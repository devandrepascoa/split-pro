import { getSessionFromHeaders } from '~/server/auth';
import { logError } from '~/server/observability/errorLog';

export const config = { runtime: 'edge' };

const MAX_BODY_BYTES = 16 * 1024;
const MAX_FIELD = 4000;

const clip = (value: unknown, max = MAX_FIELD) =>
  'string' === typeof value ? value.slice(0, max) : undefined;

/**
 * Receives browser errors (window.onerror, unhandled rejections, React error boundary) and
 * writes them to Workers Logs. Same-origin only, size-capped, no auth required so crashes on
 * the sign-in page are captured too.
 */
export default async function handler(request: Request) {
  if ('POST' !== request.method) {
    return new Response(null, { status: 405 });
  }

  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return new Response(null, { status: 403 });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new Response(null, { status: 400 });
  }

  const session = await getSessionFromHeaders(request.headers).catch(() => null);

  const error = new Error(clip(body.message) ?? 'Unknown browser error');
  error.name = clip(body.name, 200) ?? 'BrowserError';
  error.stack = clip(body.stack);

  logError('browser', error, {
    kind: clip(body.kind, 50),
    url: clip(body.url, 1000),
    componentStack: clip(body.componentStack),
    userAgent: clip(request.headers.get('user-agent'), 300),
    userId: session?.user.id,
    rayId: request.headers.get('cf-ray') ?? undefined,
  });

  return new Response(null, { status: 204 });
}
