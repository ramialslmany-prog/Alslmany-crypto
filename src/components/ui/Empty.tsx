import { cn } from "@/lib/utils";

/** Empty and error states, so a blank region always explains itself. */
export function Empty({
  title,
  body,
  icon,
  className,
  action,
}: {
  title: string;
  body?: string;
  icon?: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 border border-dashed border-rule px-6 py-12 text-center",
        className,
      )}
    >
      {icon && <div className="text-ink-faint" aria-hidden>{icon}</div>}
      <p className="font-display text-lg text-ink">{title}</p>
      {body && <p className="max-w-sm text-sm leading-relaxed text-ink-muted">{body}</p>}
      {action}
    </div>
  );
}

/** A skeleton row, matched to the density of the data it stands in for. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-sm bg-ground-800",
        "after:absolute after:inset-0 after:-translate-x-full after:animate-sweep",
        "after:bg-gradient-to-r after:from-transparent after:via-ink/[0.06] after:to-transparent",
        className,
      )}
      aria-hidden
    />
  );
}
