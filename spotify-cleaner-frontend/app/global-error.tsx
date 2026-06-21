'use client';

import { useEffect } from 'react';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="min-h-screen flex flex-col items-center justify-center gap-4 bg-bg-base px-6 text-center text-primary">
          <h1 className="text-2xl font-bold">Something went wrong.</h1>
          <p className="max-w-md text-sm text-muted">
            The app could not finish loading. Please try again.
          </p>
          <button
            type="button"
            onClick={reset}
            className="rounded-full border border-brand px-6 py-2 text-sm font-bold text-brand transition-colors hover:bg-brand hover:text-bg-base focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base"
          >
            Retry
          </button>
        </main>
      </body>
    </html>
  );
}
