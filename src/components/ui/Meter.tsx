import { cn } from "@/lib/utils";
import { clamp } from "@/lib/utils";

/**
 * A horizontal gauge. Used for confidence, score and reward-to-risk.
 * The track is always drawn to full width so a low reading reads as low
 * rather than simply as a short bar with no context.
 */
export function Meter({
  value,
  max = 100,
  tone = "amber",
  label,
  ariaLabel,
  className,
  showValue = false,
}: {
  value: number;
  max?: number;
  tone?: "amber" | "bull" | "bear" | "neutral";
  label?: string;
  /** Accessible name when the meter has no visible label of its own. */
  ariaLabel?: string;
  className?: string;
  showValue?: boolean;
}) {
  const pct = clamp((value / max) * 100, 0, 100);
  const name = ariaLabel ?? label;
  const fill = {
    amber: "bg-amber",
    bull: "bg-bull",
    bear: "bg-bear",
    neutral: "bg-ink-faint",
  }[tone];

  return (
    <div className={cn("w-full", className)}>
      {(label || showValue) && (
        <div className="mb-1 flex items-baseline justify-between gap-2">
          {label && <span className="eyebrow">{label}</span>}
          {showValue && (
            <span className="num text-xs text-ink-muted">{Math.round(value)}</span>
          )}
        </div>
      )}
      {/* A meter role without an accessible name is worse than no role: a
          screen reader announces "meter" and nothing else. When there is no
          name to give, the bar is decorative reinforcement of the figure
          beside it, so it drops the role rather than claiming one it cannot
          fulfil. */}
      <div
        className="h-1 w-full overflow-hidden rounded-sm bg-ground-750"
        {...(name
          ? {
              role: "meter" as const,
              "aria-valuenow": Math.round(value),
              "aria-valuemin": 0,
              "aria-valuemax": max,
              "aria-label": name,
            }
          : { role: "presentation" as const })}
      >
        <div
          className={cn("h-full origin-left rounded-sm animate-bar-grow", fill)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
