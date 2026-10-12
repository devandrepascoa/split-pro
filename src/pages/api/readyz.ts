import { bindings } from '~/server/db';

export const config = { runtime: 'edge' };

const DB_CHECK_TIMEOUT_MS = 3000;

/** Readiness check: verifies D1 answers `SELECT 1` within a short timeout. */
export default async function handler(request: Request) {
  if ('GET' !== request.method) {
    return Response.json(
      { status: 'error', message: 'Method not allowed' },
      { status: 405, headers: { Allow: 'GET' } },
    );
  }

  try {
    await Promise.race([
      bindings.DB.prepare('SELECT 1').first(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), DB_CHECK_TIMEOUT_MS),
      ),
    ]);
    return Response.json({ status: 'ok' });
  } catch (error) {
    console.error('Readiness check failed:', error);
    return Response.json({ status: 'error', message: 'Database not reachable' }, { status: 503 });
  }
}
