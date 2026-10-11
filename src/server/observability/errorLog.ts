/**
 * Structured error logging for Workers Observability.
 *
 * Every entry is one `console.error` call with a JSON object, so Workers Logs can filter on
 * fields such as `source`, `path`, or `errorName`. Nothing is sampled
 * (see `observability` in wrangler.jsonc).
 */
export type ErrorSource = 'worker' | 'unhandledrejection' | 'trpc' | 'ssr' | 'workflow' | 'browser';

export interface ErrorContext {
  [key: string]: unknown;
}

const MAX_STRING = 4000;

const truncate = (value: string) =>
  value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;

export const serializeError = (error: unknown) => {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return {
      errorName: error.name,
      errorMessage: truncate(error.message),
      stack: error.stack ? truncate(error.stack) : undefined,
      cause: cause instanceof Error ? `${cause.name}: ${truncate(cause.message)}` : undefined,
    };
  }
  return { errorName: 'NonError', errorMessage: truncate(String(error)) };
};

export const logError = (source: ErrorSource, error: unknown, context: ErrorContext = {}) => {
  console.error(
    JSON.stringify(
      {
        level: 'error',
        source,
        ...serializeError(error),
        ...context,
        timestamp: new Date().toISOString(),
      },
      (_key, value: unknown) => ('bigint' === typeof value ? value.toString() : value),
    ),
  );
};
