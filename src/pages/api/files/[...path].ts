import { getSessionFromHeaders } from '~/server/auth';
import { bindings } from '~/server/db';

export const config = { runtime: 'edge' };

const PREFIX = '/api/files/';

/** Serves receipts from R2. Any signed-in user can read, as before. */
export default async function handler(request: Request) {
  if ('GET' !== request.method) {
    return new Response(null, { status: 405 });
  }

  const session = await getSessionFromHeaders(request.headers);
  if (!session) {
    return new Response('Unauthorized', { status: 403 });
  }

  const { pathname } = new URL(request.url);
  const key = decodeURIComponent(pathname.slice(pathname.indexOf(PREFIX) + PREFIX.length));
  // Keys look like "<userId>/<uuid>" (legacy: "<userId>/<uuid>.webp").
  if (!/^\d+\/[0-9a-f-]{36}(-thumb)?(\.webp)?$/i.test(key)) {
    return new Response('Invalid path', { status: 400 });
  }

  const object = await bindings.UPLOADS.get(key);
  if (!object) {
    return new Response('File not found', { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  return new Response(object.body, { headers });
}
