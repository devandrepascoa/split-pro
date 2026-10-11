import { getSessionFromHeaders } from '~/server/auth';

export const config = { runtime: 'edge' };

/** Returns the app session (with SplitPro user fields) for the client SessionProvider. */
export default async function handler(request: Request) {
  const session = await getSessionFromHeaders(request.headers);
  return Response.json(session, { headers: { 'Cache-Control': 'private, no-store' } });
}
