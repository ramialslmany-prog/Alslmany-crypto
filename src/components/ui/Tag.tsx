import { cn } from "@/lib/utils";

export type TagTone = "neutral" | "bull" | "bear" | "amber" | "muted";

const TONES: Record<TagTone, string> = {
  neutral: "border-rule-strong text-ink-muted",
  bull: "border-bull/45 bg-bull/10 text-bull",
  bear: "border-bear/45 bg-bear/10 text-bear",
  amber: "border-amber/45 bg-amber/10 text-amber-soft",
  muted: "border-rule text-ink-faint",
};

export function Tag({
  children,
  tone = "neutral",
  dot = false,
  className,
}: {
  children: React.ReactNode;
  tone?: TagTone;
  /** A live indicator dot, for states that are actively updating. */
  dot?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("tag", TONES[tone], className)}>
      {dot && (
        <span
          aria-hidden
          className={cn(
            "inline-block h-1.5 w-1.5 rounded-full animate-pulse-dot",
            tone === "bull" && "bg-bull",
            tone === "bear" && "bg-bear",
            tone === "amber" && "bg-amber",
            (tone === "neutral" || tone === "muted") && "bg-ink-faint",
          )}
        />
      )}
      {children}
    </span>
  );
}
