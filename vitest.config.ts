import { resolve } from 'node:path';

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const alias = { '~': resolve(import.meta.dirname, 'src') };

export default defineConfig({
  test: {
    projects: [
      {
        // Real D1 (local, via workerd) with the production migrations applied.
        resolve: { alias },
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: './test/wrangler.test.jsonc' },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations(resolve(import.meta.dirname, 'migrations')),
              },
            },
          })),
        ],
        test: {
          name: 'integration',
          include: ['src/tests/integration/**/*.integration.test.ts'],
          setupFiles: ['test/setup.integration.ts'],
          // CommonJS-only dependencies must be pre-bundled to run inside workerd.
          deps: { optimizer: { ssr: { enabled: true, include: ['cron-parser'] } } },
        },
      },
    ],
  },
});
