import { cn } from "@/lib/utils";

/**
 * The mark: a candle with its wick, drawn as a monogram.
 * Amber, like every other brand-level accent on the site.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-5 w-5", className)}
      fill="none"
      role="img"
      aria-label="Alslmany Crypto"
    >
      <path d="M12 2v4M12 18v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <rect
        x="7.5" y="6" width="9" height="12" rx="1"
        stroke="currentColor" strokeWidth="1.6"
      />
      <path d="M10 10.5h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.55" />
    </svg>
  );
}
