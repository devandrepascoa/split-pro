import { Component, type ErrorInfo, type ReactNode } from 'react';

import { reportClientError } from '~/lib/report-client-error';

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/** Catches render errors, reports them to Workers Logs, and shows a reload prompt. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportClientError({
      kind: 'react-boundary',
      message: error.message,
      name: error.name,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    });
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="text-lg font-semibold">Something went wrong.</p>
          <p className="text-muted-foreground text-sm">
            The error was reported. Try reloading the page.
          </p>
          <button
            type="button"
            className="rounded-md bg-white px-4 py-2 text-black"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
