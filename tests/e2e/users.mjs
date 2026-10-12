import { createHmac } from 'node:crypto';

export const SECRET = 'e2e-secret-e2e-secret-e2e-secret-123456';
export const USERS = {
  alice: { id: 1, name: 'Alice E2E', email: 'alice@e2e.test', token: 'e2e-token-alice' },
  bob: { id: 2, name: 'Bob E2E', email: 'bob@e2e.test', token: 'e2e-token-bob' },
  mallory: { id: 3, name: 'Mallory E2E', email: 'mallory@e2e.test', token: 'e2e-token-mallory' },
};

/** better-auth cookie value: `<token>.<base64 HMAC-SHA256(secret, token)>`, URL-encoded. */
export const sessionCookie = (token) =>
  encodeURIComponent(`${token}.${createHmac('sha256', SECRET).update(token).digest('base64')}`);
