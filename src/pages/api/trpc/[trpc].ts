import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { appRouter } from '~/server/api/root';
import { createTRPCContext } from '~/server/api/trpc';
import { logError } from '~/server/observability/errorLog';

export const config = { runtime: 'edge' };

/** Client mistakes (bad input, auth) are expected; log them as warnings, not errors. */
const EXPECTED_CODES = new Set([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'PARSE_ERROR',
  'METHOD_NOT_SUPPORTED',
  'TOO_MANY_REQUESTS',
]);

export default function handler(request: Request) {
  let userId: number | undefined;

  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req: request,
    router: appRouter,
    createContext: async () => {
      const ctx = await createTRPCContext({ req: { headers: request.headers } });
      userId = ctx.session?.user.id;
      return ctx;
    },
    onError: ({ path, type, error, input }) => {
      const context = {
        path,
        type,
        code: error.code,
        userId,
        input,
        rayId: request.headers.get('cf-ray') ?? undefined,
      };
      if (EXPECTED_CODES.has(error.code)) {
        console.warn(
          JSON.stringify(
            { level: 'warn', source: 'trpc', message: error.message, ...context },
            (_k, v: unknown) => ('bigint' === typeof v ? v.toString() : v),
          ),
        );
        return;
      }
      // Log the original error (with its stack), not the tRPC wrapper.
      logError('trpc', error.cause ?? error, context);
    },
  });
}
