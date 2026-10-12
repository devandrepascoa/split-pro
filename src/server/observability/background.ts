import { getRequestExecutionContext } from 'vinext/shims/request-context';

import { logError } from './errorLog';

/**
 * Runs fire-and-forget work so it survives the response (via `ctx.waitUntil`) and any
 * failure is logged to Workers Observability instead of being lost.
 */
export const runInBackground = (name: string, work: Promise<unknown>) => {
  const guarded = work.catch((error: unknown) => {
    logError('worker', error, { phase: 'background', task: name });
  });
  try {
    getRequestExecutionContext()?.waitUntil(guarded);
  } catch {
    // No request context (e.g. inside a Workflow step): the promise still runs.
  }
};
