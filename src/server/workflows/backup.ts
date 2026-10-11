/**
 * Backup Workflow: exports D1 and mirrors uploaded files to a private R2 bucket once a day.
 *
 * D1 Time Travel already allows point-in-time restores for 30 days (Workers Paid). These dumps
 * are for longer retention and for restoring into a fresh database. Restore with
 * `wrangler d1 execute <db> --remote --file <dump>.sql`.
 *
 * Uses the D1 REST export API (consistent snapshot, includes views and triggers), so it needs
 * the `D1_EXPORT_TOKEN` secret (a scoped API token) plus the CF_ACCOUNT_ID and D1_DATABASE_ID vars.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

import { type AppBindings } from '~/server/db';
import { logError } from '~/server/observability/errorLog';
import { copyUploadPage, type UploadObjectSummary } from './backupStorage';
import { getD1ExportFile, isD1ExportResponse } from './backupProtocol';

const D1_PREFIX = 'd1/';
const UPLOADS_PREFIX = 'uploads/';
const DEFAULT_RETENTION_DAYS = 90;
const UPLOADS_PAGE_SIZE = 100;

const steps = {
  start: { retries: { limit: 5, delay: '15 seconds', backoff: 'exponential' } },
  // The export is prepared asynchronously; poll until the signed URL is ready.
  poll: { retries: { limit: 20, delay: '15 seconds', backoff: 'constant' } },
  list: { retries: { limit: 5, delay: '15 seconds', backoff: 'exponential' } },
  copy: {
    retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' },
    timeout: '25 minutes',
  },
  store: { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } },
} as const;

export class BackupWorkflow extends WorkflowEntrypoint<AppBindings> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const env = this.env;
    const when = new Date(event.schedule?.scheduledTime ?? event.timestamp.getTime());
    const retentionDays = Number(env.BACKUP_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
      throw new Error('BACKUP_RETENTION_DAYS must be a positive integer');
    }

    const day = when.toISOString().slice(0, 10);
    const time = when.toISOString().slice(11, 16).replace(':', '');
    const exportUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.D1_DATABASE_ID}/export`;

    const call = async (body: Record<string, unknown>) => {
      const response = await fetch(exportUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.D1_EXPORT_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const json: unknown = await response.json();
      if (!isD1ExportResponse(json)) {
        throw new Error(`D1 export API ${response.status}: invalid response`);
      }
      if (!response.ok || json.success === false) {
        throw new Error(
          `D1 export API ${response.status}: ${json.errors?.map((e) => e.message).join('; ') ?? 'unknown error'}`,
        );
      }
      return json.result ?? {};
    };

    try {
      const bookmark = await step.do('start export', steps.start, async () => {
        const result = await call({ output_format: 'polling' });
        if (!result.at_bookmark) {
          throw new Error('Export did not return a bookmark');
        }
        return result.at_bookmark;
      });

      const databaseKey = await step.do('download and store D1 export', steps.poll, async () => {
        const result = await call({ output_format: 'polling', current_bookmark: bookmark });
        if (result.status === 'error') {
          throw new Error(`Export failed: ${result.error ?? 'unknown'}`);
        }
        const file = getD1ExportFile(result);
        if (!file?.signed_url) {
          throw new Error('Export not ready yet');
        }
        const dump = await fetch(file.signed_url);
        if (!dump.ok || !dump.body) {
          throw new Error(`Could not download the export (${dump.status})`);
        }
        const objectKey = `${D1_PREFIX}splitpro-${day}-${time}.sql`;
        await env.BACKUPS.put(objectKey, dump.body, {
          customMetadata: { bookmark, createdAt: when.toISOString() },
        });
        return objectKey;
      });

      let cursor: string | undefined = undefined;
      let pageNumber = 0;
      let uploadsScanned = 0;
      let uploadsCopied = 0;
      do {
        const page = await step.do(`list upload objects ${pageNumber}`, steps.list, async () => {
          const listed = await env.UPLOADS.list({
            prefix: '',
            limit: UPLOADS_PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          });
          if (listed.truncated && !listed.cursor) {
            throw new Error('R2 upload listing was truncated without a cursor');
          }
          const objects: UploadObjectSummary[] = listed.objects.map(({ key, etag, size }) => ({
            key,
            etag,
            size,
          }));
          return {
            objects,
            cursor: listed.truncated ? listed.cursor! : null,
          };
        });

        const copied = await step.do(`copy upload objects ${pageNumber}`, steps.copy, async () =>
          copyUploadPage(env.UPLOADS, env.BACKUPS, page.objects),
        );
        uploadsScanned += page.objects.length;
        uploadsCopied += copied;
        cursor = page.cursor ?? undefined;
        pageNumber += 1;
      } while (cursor);

      const manifestKey = await step.do('write backup manifest', steps.store, async () => {
        const key = `${D1_PREFIX}splitpro-${day}-${time}.json`;
        const manifest = {
          version: 1,
          createdAt: when.toISOString(),
          database: { key: databaseKey, bookmark },
          uploads: { prefix: UPLOADS_PREFIX, scanned: uploadsScanned, copied: uploadsCopied },
        };
        await env.BACKUPS.put(key, JSON.stringify(manifest, null, 2), {
          httpMetadata: { contentType: 'application/json' },
        });
        return key;
      });

      const pruned = await step.do('prune old D1 backup artifacts', steps.store, async () => {
        const cutoff = when.getTime() - retentionDays * 86_400_000;
        const stale: string[] = [];
        let pruneCursor: string | undefined;
        do {
          const page = await env.BACKUPS.list({ prefix: D1_PREFIX, cursor: pruneCursor });
          for (const object of page.objects) {
            if (object.uploaded.getTime() < cutoff) {
              stale.push(object.key);
            }
          }
          pruneCursor = page.truncated ? page.cursor : undefined;
        } while (pruneCursor);
        for (let index = 0; index < stale.length; index += 1000) {
          await env.BACKUPS.delete(stale.slice(index, index + 1000));
        }
        return stale.length;
      });

      return { databaseKey, manifestKey, uploadsScanned, uploadsCopied, pruned };
    } catch (error) {
      logError('workflow', error, { step: 'backup', instanceId: event.instanceId });
      throw error;
    }
  }
}
