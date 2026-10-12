const UPLOADS_PREFIX = 'uploads/';
const COPY_CONCURRENCY = 5;

export interface UploadObjectSummary {
  key: string;
  etag: string;
  size: number;
}

const copyUploadObject = async (
  uploads: R2Bucket,
  backups: R2Bucket,
  object: UploadObjectSummary,
) => {
  const backupKey = `${UPLOADS_PREFIX}${object.key}`;
  const existing = await backups.head(backupKey);
  if (existing?.etag === object.etag && existing.size === object.size) {
    return false;
  }

  const source = await uploads.get(object.key);
  if (!source?.body) {
    throw new Error(`Upload disappeared while backing up: ${object.key}`);
  }

  const copied = await backups.put(backupKey, source.body, {
    ...(source.httpMetadata ? { httpMetadata: source.httpMetadata } : {}),
    ...(source.customMetadata ? { customMetadata: source.customMetadata } : {}),
  });
  if (!copied || copied.etag !== source.etag || copied.size !== source.size) {
    throw new Error(`Could not verify uploaded backup object: ${object.key}`);
  }
  return true;
};

/** Idempotently mirrors one page of uploads while bounding concurrent object streams. */
export const copyUploadPage = async (
  uploads: R2Bucket,
  backups: R2Bucket,
  objects: UploadObjectSummary[],
) => {
  let copied = 0;
  for (let index = 0; index < objects.length; index += COPY_CONCURRENCY) {
    const page = objects.slice(index, index + COPY_CONCURRENCY);
    const results = await Promise.all(
      page.map((object) => copyUploadObject(uploads, backups, object)),
    );
    copied += results.filter(Boolean).length;
  }
  return copied;
};
