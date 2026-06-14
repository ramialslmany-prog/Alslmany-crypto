import { cn } from "@/lib/utils";
import type { Signal } from "@/lib/mock-data";

const signalStyles: Record<Signal, string> = {
  BUY: "text-bull bg-bull/10 border-bull/30",
  ACCUMULATE: "text-cyan bg-cyan/10 border-cyan/30",
  SELL: "text-bear bg-bear/10 border-bear/30",
  REDUCE: "text-gold bg-gold/10 border-gold/30",
};

export function SignalBadge({ signal, className }: { signal: Signal; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-widest",
        signalStyles[signal],
        className
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse-glow" />
      {signal}
    </span>
  );
}

export function Pill({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-ink-muted",
        className
      )}
    >
      {children}
    </span>
  );
}
