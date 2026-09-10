"use client";

import { useEffect } from "react";

/**
 * The last line of defence. It never shows a stack trace to the user, but it
 * does log one, so a failure is diagnosable without being alarming.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Unhandled application error:", error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 px-6 text-center">
      <p className="eyebrow text-bear">Error</p>
      <h1 className="font-display text-2xl text-ink">
        حدث خطأ غير متوقّع · Something went wrong
      </h1>
      <p className="max-w-sm text-sm leading-relaxed text-ink-muted">
        تعذّر عرض هذا الجزء. حاول مرة أخرى. — This section could not be rendered. Try again.
      </p>
      <button type="button" onClick={reset} className="btn btn-primary">
        إعادة المحاولة · Retry
      </button>
      {error.digest && (
        <p className="num text-2xs text-ink-faint">ref: {error.digest}</p>
      )}
    </main>
  );
}
