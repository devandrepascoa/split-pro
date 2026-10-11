/**
 * Worker entry: vinext Pages Router handler plus the scheduler Workflow class.
 * vinext uses ./worker/index.ts as `main` when it exists.
 *
 * The wrapper logs every uncaught exception and every 5xx response to Workers Observability.
 * Uncaught exceptions are re-thrown so they also appear in Workers Issues.
 */
import handler from 'vinext/server/pages-router-entry';

import { logError } from '../src/server/observability/errorLog';

export { SchedulerWorkflow } from '../src/server/workflows/scheduler';

addEventListener('unhandledrejection', (event: Event) => {
  logError('unhandledrejection', (event as PromiseRejectionEvent).reason);
});

type FetchHandler = (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
const vinextFetch = (handler as unknown as { fetch: FetchHandler }).fetch;

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
