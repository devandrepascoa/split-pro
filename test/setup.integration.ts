import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll } from 'vitest';

// BigInt values appear in tRPC results and balance rows.
// @ts-expect-error extending the BigInt prototype for tests only
BigInt.prototype.toJSON = function toJSON() {
  return this.toString();
};

beforeAll(async () => {
  const { DB, TEST_MIGRATIONS } = env as unknown as {
    DB: D1Database;
    TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  };
  await applyD1Migrations(DB, TEST_MIGRATIONS);
});
