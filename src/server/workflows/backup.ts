/**
 * Backup Workflow: exports the D1 database to R2 as a SQL dump once a day.
 *
 * D1 Time Travel already allows point-in-time restores for 30 days (Workers Paid). These dumps
 * are for longer retention and for restoring into a fresh database. Restore with
 * `wrangler d1 execute <db> --remote --file <dump>.sql`.
 *
 * Uses the D1 REST export API (consistent snapshot, includes views and triggers), so it needs
 * the `D1_EXPORT_TOKEN` secret (a scoped API token) plus the CF_ACCOUNT_ID and D1_DATABASE_ID vars.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

import { bindings } from '~/server/db';
import { logError } from '~/server/observability/errorLog';

interface BackupBindings {
  BACKUPS: R2Bucket;
  CF_ACCOUNT_ID: string;
  D1_DATABASE_ID: string;
  D1_EXPORT_TOKEN: string;
  BACKUP_RETENTION_DAYS?: string;
}

interface ExportResponse {
  success?: boolean;
  errors?: { message: string }[];
  result?: {
    status?: string;
    at_bookmark?: string;
    signed_url?: string;
    filename?: string;
    error?: string;
  };
}

const PREFIX = 'd1/';
const DEFAULT_RETENTION_DAYS = 90;

const steps = {
  start: { retries: { limit: 5, delay: '15 seconds', backoff: 'exponential' } },
  // The export is prepared asynchronously; poll until the signed URL is ready.
  poll: { retries: { limit: 20, delay: '15 seconds', backoff: 'constant' } },
  store: { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } },
} as const;

export class BackupWorkflow extends WorkflowEntrypoint {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const env = bindings as unknown as BackupBindings;
    const when = new Date(event.schedule?.scheduledTime ?? event.timestamp.getTime());
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
      const json = (await response.json()) as ExportResponse;
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

      const key = await step.do('download and store in R2', steps.poll, async () => {
        const result = await call({ output_format: 'polling', current_bookmark: bookmark });
        if (result.status === 'error') {
          throw new Error(`Export failed: ${result.error ?? 'unknown'}`);
        }
        if (!result.signed_url) {
          throw new Error('Export not ready yet');
        }
        const dump = await fetch(result.signed_url);
        if (!dump.ok || !dump.body) {
          throw new Error(`Could not download the export (${dump.status})`);
        }
        const day = when.toISOString().slice(0, 10);
        const time = when.toISOString().slice(11, 16).replace(':', '');
        const objectKey = `${PREFIX}splitpro-${day}-${time}.sql`;
        await env.BACKUPS.put(objectKey, dump.body, {
          customMetadata: { bookmark, createdAt: when.toISOString() },
        });
        return objectKey;
      });

      const pruned = await step.do('prune old backups', steps.store, async () => {
        const days = Number(env.BACKUP_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
        const cutoff = when.getTime() - days * 86_400_000;
        const stale: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await env.BACKUPS.list({ prefix: PREFIX, cursor });
          for (const object of page.objects) {
            if (object.uploaded.getTime() < cutoff) {
              stale.push(object.key);
            }
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        if (stale.length > 0) {
          await env.BACKUPS.delete(stale);
        }
        return stale.length;
      });

      return { key, pruned };
    } catch (error) {
      logError('workflow', error, { step: 'backup', instanceId: event.instanceId });
      throw error;
    }
  }
}
