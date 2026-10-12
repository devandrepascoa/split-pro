import { defineConfig } from 'drizzle-kit';

// Generates SQL migrations only. They are applied with `wrangler d1 migrations apply`.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/db/schema.ts',
  out: './migrations',
});
