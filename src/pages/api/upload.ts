import { env } from '~/env';
import { getSessionFromHeaders } from '~/server/auth';
import { bindings } from '~/server/db';

export const config = { runtime: 'edge' };

const ALLOWED_TYPES = new Set(['image/webp', 'image/jpeg', 'image/png', 'image/gif', 'image/avif']);

/**
 * Stores a receipt in R2 under `<userId>/<uuid>`. The browser already compresses images
 * (browser-image-compression), so the server stores them as-is (no sharp on Workers).
 */
export default async function handler(request: Request) {
  if ('POST' !== request.method) {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const session = await getSessionFromHeaders(request.headers);
  if (!session?.user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const maxBytes = env.UPLOAD_MAX_FILE_SIZE_MB * 1024 * 1024;
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > maxBytes + 64 * 1024) {
    return Response.json({ error: 'File too large' }, { status: 413 });
  }

  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return Response.json({ error: 'No file provided' }, { status: 400 });
    }
    if (file.size > maxBytes) {
      return Response.json({ error: 'File too large' }, { status: 413 });
    }
    const contentType = file.type || 'application/octet-stream';
    if (!ALLOWED_TYPES.has(contentType)) {
      return Response.json({ error: 'Unsupported file type' }, { status: 415 });
    }

    const key = `${session.user.id}/${crypto.randomUUID()}`;
    await bindings.UPLOADS.put(key, file.stream(), {
      httpMetadata: { contentType },
      customMetadata: { uploadedBy: String(session.user.id) },
    });

    return Response.json({ key });
  } catch (error) {
    console.error('Upload error:', error);
    return Response.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
