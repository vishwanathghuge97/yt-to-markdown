import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

/**
 * Last-resort error boundary: a render-time crash shows a recoverable message
 * instead of a blank page. Notes themselves live in the browser, so reloading
 * is safe.
 */
class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-zinc-50 dark:bg-zinc-950">
          <div className="max-w-md w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-3 text-center">
            <h1 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Something went wrong
            </h1>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              The page hit an unexpected error. Your saved notes stay in this browser;
              reloading usually fixes it.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-3 py-1.5 rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-medium"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>
);
