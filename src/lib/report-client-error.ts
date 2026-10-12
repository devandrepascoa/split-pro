interface ClientErrorReport {
  kind: 'error' | 'unhandledrejection' | 'react-boundary';
  message?: string;
  name?: string;
  stack?: string;
  componentStack?: string;
}

let sent = 0;
const MAX_REPORTS_PER_PAGE = 20;

/** Sends a browser error to /api/client-errors (Workers Logs). Never throws. */
export const reportClientError = (report: ClientErrorReport) => {
  if ('undefined' === typeof window || sent >= MAX_REPORTS_PER_PAGE) {
    return;
  }
  sent += 1;
  try {
    const body = JSON.stringify({ ...report, url: window.location.href });
    if (
      !navigator.sendBeacon?.('/api/client-errors', new Blob([body], { type: 'application/json' }))
    ) {
      void fetch('/api/client-errors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => undefined);
    }
  } catch {
    // Reporting must never break the app.
  }
};

export const installGlobalErrorReporting = () => {
  window.addEventListener('error', (event) => {
    reportClientError({
      kind: 'error',
      message: event.message,
      name: event.error instanceof Error ? event.error.name : undefined,
      stack:
        event.error instanceof Error
          ? event.error.stack
          : `${event.filename}:${event.lineno}:${event.colno}`,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    reportClientError({
      kind: 'unhandledrejection',
      message: reason instanceof Error ? reason.message : String(reason),
      name: reason instanceof Error ? reason.name : undefined,
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
};
