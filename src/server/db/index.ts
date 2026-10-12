import { env } from 'cloudflare:workers';
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';

import * as schema from './schema';

export type DB = DrizzleD1Database<typeof schema>;

/** Cloudflare bindings for this Worker. Keep in sync with wrangler.jsonc. */
export interface AppBindings {
  DB: D1Database;
  UPLOADS: R2Bucket;
  EMAIL?: SendEmail;
  SCHEDULER?: Workflow;
  [key: string]: unknown;
}

export const bindings = env as unknown as AppBindings;

/** Drizzle over the D1 binding. `cloudflare:workers` env is available at module scope. */
export const db: DB = drizzle(bindings.DB, { schema });

export const getDb = (): DB => db;
