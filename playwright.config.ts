import { defineConfig } from '@playwright/test';

const PORT = 3176;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: 4,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    // Runs the *built* Worker (dist/) in workerd with a throwaway local D1 under .e2e-state.
    command: `node tests/e2e/prepare.mjs && npx wrangler dev -c dist/splitpro/wrangler.json --local --persist-to .e2e-state --ip 127.0.0.1 --port ${PORT} --var NEXTAUTH_URL:http://127.0.0.1:${PORT} --var NEXTAUTH_SECRET:e2e-secret-e2e-secret-e2e-secret-123456 --var GOOGLE_CLIENT_ID:e2e --var GOOGLE_CLIENT_SECRET:e2e`,
    url: `http://127.0.0.1:${PORT}/api/healthz`,
    timeout: 90_000,
    reuseExistingServer: !process.env.CI,
  },
});
