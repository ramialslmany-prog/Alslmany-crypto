"use client";

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center p-6 text-center">
      <div>
        <div className="font-display text-5xl font-bold text-bear">Something broke</div>
        <p className="mt-3 text-ink-muted">An unexpected error occurred. Try again.</p>
        <button
          onClick={reset}
          className="mt-6 inline-block rounded-xl bg-cyan-violet px-6 py-2.5 text-sm font-bold text-base-950 transition-transform hover:scale-[1.02]"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
