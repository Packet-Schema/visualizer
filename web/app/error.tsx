"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6 text-fg">
      <div className="max-w-md text-center space-y-3">
        <h1 className="text-xl font-semibold">Something went wrong.</h1>
        <p className="text-sm text-fg-muted">
          Packet View hit an unexpected error while rendering. Try again, or
          refresh the page if the problem persists.
        </p>
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-bg-elevated"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
