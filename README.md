# SplitPro on Cloudflare Workers

> [!WARNING]
> **EXPERIMENTAL and VIBE-CODED.** This is an AI-assisted port of SplitPro to Cloudflare Workers.
> It is a hobby project. It has **no automated tests**, it has not been security-reviewed, and parts
> of it are untested (bank sync, Splitwise import, recurring expenses under load). It handles money
> records. Use at your own risk, and do not trust it with anything important.

This is a fork of **[oss-apps/split-pro](https://github.com/oss-apps/split-pro)**, the open source
Splitwise alternative. All credit for the app, UI, and features goes to the original authors. For the
original project, its documentation, and the supported Docker/Postgres setup, go to
**https://github.com/oss-apps/split-pro** (website: https://splitpro.app).

This fork is **not affiliated with or endorsed by** the upstream project. License: MIT (see `LICENSE`).

## What is different from upstream

Everything runs on Cloudflare Workers. There is no Node server, no Docker, and no Postgres.

| Area                      | Upstream          | This fork                                                                                         |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| Runtime                   | Next.js on Node   | Next.js on Workers via [vinext](https://github.com/cloudflare/vinext) + `@cloudflare/vite-plugin` |
| Database                  | Postgres + Prisma | Cloudflare D1 + Drizzle (money writes use atomic `db.batch`)                                      |
| Auth                      | next-auth         | better-auth, Google sign-in only                                                                  |
| Uploads                   | local disk        | R2                                                                                                |
| Email                     | nodemailer / SMTP | Cloudflare Email Sending binding                                                                  |
| Cron / recurring expenses | `pg_cron`         | A Workflow with a `* * * * *` schedule, driven by the `job` table                                 |
| Push                      | `web-push`        | `web-push` on Workers (VAPID keys as secrets)                                                     |
| Observability             | none              | Workers Logs, Traces, and Issues, unsampled; tRPC, Worker, and browser errors are logged          |

The `Dockerfile`, `docker/`, `start.sh`, `flake.nix`, and most of `docs/` are leftovers from upstream.
They describe the Postgres/Prisma setup, which this fork removed. They no longer work here.

## Deploy

You need a Cloudflare account on a plan that supports Workers, D1, R2, Workflows, and Email Sending,
a domain on Cloudflare, and a Google OAuth client.

1. Install: `pnpm install`
2. Create resources:
   ```sh
   npx wrangler d1 create splitpro
   npx wrangler r2 bucket create splitpro-uploads
   ```
3. Copy `wrangler.example.jsonc` to `wrangler.jsonc`. Set your domain, the D1 `database_id`, and the
   sender address (`FROM_EMAIL`). Your domain must have Email Sending enabled.
4. Create a Google OAuth client (Web application). Add the redirect URI
   `https://YOUR_DOMAIN/api/auth/callback/google`.
5. Apply the migrations: `npx wrangler d1 migrations apply splitpro --remote`
6. Set the secrets (`npx wrangler secret put NAME`):
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET` (a random string; the name is kept
   from upstream), and for push notifications `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`,
   `WEB_PUSH_EMAIL`. Generate VAPID keys with `npx web-push generate-vapid-keys`.
7. Build and deploy:
   ```sh
   SKIP_ENV_VALIDATION=1 pnpm build && npx wrangler deploy
   ```

Local development: put the same values in `.dev.vars` (git-ignored, with `NEXTAUTH_URL=http://localhost:8787`),
run `npx wrangler d1 migrations apply splitpro --local`, then `npx wrangler dev --port 8787`.

## Known gaps

- Test coverage is small and focused on the riskiest paths (see below). There are no unit or component tests.
- Plaid / GoCardless bank sync and the Splitwise import are untested on Workers.
- Only Google sign-in is wired up. There is no email or password login.
- `drizzle-kit` and `wrangler d1 migrations` own the schema. `migrations/0001_balance_view_and_triggers.sql`
  is hand-written (the `BalanceView` view and a trigger). Back it up before regenerating migrations.

## Tests

```sh
pnpm test:integration   # Vitest in workerd with a real local D1 and the production migrations
pnpm build && pnpm test:e2e   # Playwright against the built Worker (wrangler dev), 4 parallel workers
```

- `src/tests/integration`: authorization, balances and simplification, expense create/edit/delete
  atomicity, settlements, recurring expenses (including idempotent retries), and regression tests
  for D1 query bugs.
- `tests/e2e`: sign-in redirect, signed-in session, groups, expenses, settle up, a stranger being
  blocked, and recurring expenses, all against the production bundle. Google sign-in cannot be
  automated, so the tests seed users and signed `better-auth` session cookies in a throwaway D1.
- CI (`.github/workflows/ci.yml`) runs typecheck, integration, and e2e as three parallel jobs with
  the pnpm store, Playwright browsers, and the build cached. The target is under 2 minutes.

Bug reports for this fork go to this repository's issues. Please do not report them upstream.
