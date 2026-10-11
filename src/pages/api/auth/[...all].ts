import { auth } from '~/server/auth';

export const config = { runtime: 'edge' };

export default function handler(request: Request) {
  return auth.handler(request);
}
