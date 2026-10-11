// Creates a throwaway local D1 under .e2e-state (migrations + three users with live sessions).
// Runs as part of the Playwright webServer command, before the Worker starts.
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

import { USERS } from './users.mjs';

const wrangler = (...args) =>
  execFileSync(
    'npx',
    [
      'wrangler',
      ...args,
      '-c',
      'dist/splitpro/wrangler.json',
      '--local',
      '--persist-to',
      '.e2e-state',
    ],
    { stdio: 'pipe', env: { ...process.env, CI: '1' } },
  );

rmSync('.e2e-state', { recursive: true, force: true });
wrangler('d1', 'migrations', 'apply', 'splitpro');

const now = Date.now();
const expires = now + 7 * 86_400_000;
const sql = Object.values(USERS)
  .flatMap((u) => [
    `INSERT INTO "User" (id, name, email, emailVerified, currency, createdAt, updatedAt) VALUES (${u.id}, '${u.name}', '${u.email}', 1, 'EUR', ${now}, ${now});`,
    `INSERT INTO "Session" (token, userId, expiresAt, createdAt, updatedAt) VALUES ('${u.token}', ${u.id}, ${expires}, ${now}, ${now});`,
  ])
  .join('\n');
writeFileSync('.e2e-seed.sql', sql);
wrangler('d1', 'execute', 'splitpro', '--file', '.e2e-seed.sql');
rmSync('.e2e-seed.sql');
