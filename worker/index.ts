/**
 * Worker entry: vinext Pages Router handler plus the scheduler Workflow class.
 * vinext uses ./worker/index.ts as `main` when it exists.
 *
 * The wrapper logs every uncaught exception and every 5xx response to Workers Observability.
 * Uncaught exceptions are re-thrown so they also appear in Workers Issues.
 */
import handler from 'vinext/server/pages-router-entry';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import { logError } from '../src/server/observability/errorLog';
import { PREVIEW_ACCESS_EMAIL_HEADER, PREVIEW_ACCESS_NAME_HEADER } from '../src/server/preview-access';

export { BackupWorkflow } from '../src/server/workflows/backup';
export { SchedulerWorkflow } from '../src/server/workflows/scheduler';

addEventListener('unhandledrejection', (event: Event) => {
  logError('unhandledrejection', (event as PromiseRejectionEvent).reason);
});

type FetchHandler = (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
const vinextFetch = (handler as unknown as { fetch: FetchHandler }).fetch;
const accessIssuer = 'https://andrepascoa.cloudflareaccess.com';
const accessJwks = createRemoteJWKSet(new URL(`${accessIssuer}/cdn-cgi/access/certs`));

const requestContext = (request: Request) => {
  const url = new URL(request.url);
  return {
    method: request.method,
    path: url.pathname,
    query: url.search,
    rayId: request.headers.get('cf-ray') ?? undefined,
  };
};

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const previewAccessEnabled =
      'object' === typeof env && null !== env && 'true' === Reflect.get(env, 'PREVIEW_ACCESS_AUTH');

    if (previewAccessEnabled) {
      let identity = await ctx.access?.getIdentity();
      if (!identity?.email) {
        const assertion = request.headers.get('cf-access-jwt-assertion');
        const audience = 'object' === typeof env && null !== env && Reflect.get(env, 'PREVIEW_ACCESS_AUD');
        if (assertion && 'string' === typeof audience) {
          try {
            const verified = await jwtVerify(assertion, accessJwks, {
              issuer: accessIssuer,
              audience,
            });
            if ('string' === typeof verified.payload.email) {
              identity = {
                email: verified.payload.email,
                name: 'string' === typeof verified.payload.name ? verified.payload.name : undefined,
              };
            }
          } catch (error) {
            logError('worker', error, { ...requestContext(request), phase: 'access-identity-fallback' });
          }
        }
      }

      const email = identity?.email?.trim().toLowerCase();
      if (!email) {
        return new Response('Cloudflare Access authentication was not verified.', { status: 403 });
      }

      // Replace, never trust, identity headers supplied by the incoming client.
      const headers = new Headers(request.headers);
      headers.delete(PREVIEW_ACCESS_EMAIL_HEADER);
      headers.delete(PREVIEW_ACCESS_NAME_HEADER);
      headers.set(PREVIEW_ACCESS_EMAIL_HEADER, email);
      if (identity?.name) headers.set(PREVIEW_ACCESS_NAME_HEADER, identity.name);
      request = new Request(request, { headers });
    }

    let response: Response;
    try {
      response = await vinextFetch(request, env, ctx);
    } catch (error) {
      logError('worker', error, { ...requestContext(request), phase: 'uncaught' });
      throw error;
    }

    // Vinext turns errors in getServerSideProps / API routes into 5xx responses without
    // Throwing, so log those too (the handler's own console.error output, if any, is
    // Attached to the same invocation in Workers Logs).
    if (500 <= response.status) {
      logError('ssr', new Error(`HTTP ${response.status} response`), {
        ...requestContext(request),
        status: response.status,
      });
    }

    return response;
  },
} satisfies ExportedHandler;
