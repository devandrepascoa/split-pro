import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { copyUploadPage } from '~/server/workflows/backupStorage';

const buckets = env as unknown as { UPLOADS: R2Bucket; BACKUPS: R2Bucket };

describe('R2 upload backup', () => {
  it('copies upload contents and metadata, skips unchanged objects, and refreshes changed objects', async () => {
    const key = `backup-test/${crypto.randomUUID()}`;
    const backupKey = `uploads/${key}`;

    try {
      await buckets.UPLOADS.put(key, 'first version', {
        httpMetadata: { contentType: 'text/plain' },
        customMetadata: { uploadedBy: 'test-user' },
      });
      const firstSource = await buckets.UPLOADS.head(key);
      expect(firstSource).not.toBeNull();
      if (!firstSource) {
        throw new Error('Test upload was not stored');
      }

      expect(
        await copyUploadPage(buckets.UPLOADS, buckets.BACKUPS, [
          { key, etag: firstSource.etag, size: firstSource.size },
        ]),
      ).toBe(1);

      const firstBackup = await buckets.BACKUPS.get(backupKey);
      expect(firstBackup?.body).toBeDefined();
      expect(await firstBackup?.text()).toBe('first version');
      expect(firstBackup?.httpMetadata?.contentType).toBe('text/plain');
      expect(firstBackup?.customMetadata).toEqual({ uploadedBy: 'test-user' });

      expect(
        await copyUploadPage(buckets.UPLOADS, buckets.BACKUPS, [
          { key, etag: firstSource.etag, size: firstSource.size },
        ]),
      ).toBe(0);

      await buckets.UPLOADS.put(key, 'updated version', {
        httpMetadata: { contentType: 'application/json' },
      });
      const updatedSource = await buckets.UPLOADS.head(key);
      if (!updatedSource) {
        throw new Error('Updated test upload was not stored');
      }

      expect(
        await copyUploadPage(buckets.UPLOADS, buckets.BACKUPS, [
          { key, etag: updatedSource.etag, size: updatedSource.size },
        ]),
      ).toBe(1);

      const updatedBackup = await buckets.BACKUPS.get(backupKey);
      expect(await updatedBackup?.text()).toBe('updated version');
      expect(updatedBackup?.httpMetadata?.contentType).toBe('application/json');
    } finally {
      await Promise.all([buckets.UPLOADS.delete(key), buckets.BACKUPS.delete(backupKey)]);
    }
  });
});
