import Link from "next/link";

export default function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center p-6 text-center">
      <div>
        <div className="font-display text-7xl font-bold text-cyan">404</div>
        <p className="mt-3 text-ink-muted">This page doesn’t exist.</p>
        <Link
          href="/dashboard"
          className="mt-6 inline-block rounded-xl bg-cyan-violet px-6 py-2.5 text-sm font-bold text-base-950 transition-transform hover:scale-[1.02]"
        >
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}
