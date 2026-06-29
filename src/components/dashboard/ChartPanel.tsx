"use client";

import { useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Loader2 } from "lucide-react";
import { CandleChart } from "@/components/ui/CandleChart";
import { LivePrice } from "@/components/ui/LivePrice";
import { useCandles, useCoin } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import type { Interval } from "@/lib/candles";
import { formatUsd, formatPercent, formatCompact } from "@/lib/format";
import { cn } from "@/lib/utils";

const intervals: { id: Interval; label: string }[] = [
  { id: "15m", label: "15m" },
  { id: "1h", label: "1H" },
  { id: "4h", label: "4H" },
  { id: "1d", label: "1D" },
];

export function ChartPanel() {
  const { t } = useI18n();
  const [iv, setIv] = useState<Interval>("1h");
  const btc = useCoin("BTC");
  const { candles, source, isLoading } = useCandles("BTC", iv, 180);

  const isLive = !!source && source !== "synthetic";
  const up = btc.change24h >= 0;
  const { high, low } = useMemo(() => {
    if (!candles.length) return { high: btc.price, low: btc.price };
    return { high: Math.max(...candles.map((c) => c.h)), low: Math.min(...candles.map((c) => c.l)) };
  }, [candles, btc.price]);

  return (
    <div className="glass glow-border rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl text-sm font-bold" style={{ background: `${btc.color}22`, color: btc.color }}>
            BTC
          </span>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">Bitcoin</span>
              <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">BTC/USD</span>
              <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest">
                <span className={cn("h-1.5 w-1.5 rounded-full", isLive ? "bg-bull animate-pulse-glow" : "bg-gold")} />
                <span className={isLive ? "text-bull" : "text-gold"}>{isLive ? t("ov.live") : t("ov.demo")}</span>
              </span>
            </div>
            <div dir="ltr" className="flex items-center gap-2">
              <LivePrice value={btc.price} format={formatUsd} className="font-mono text-2xl font-bold text-ink" />
              <span className={cn("flex items-center gap-0.5 text-xs font-semibold tnum", up ? "text-bull" : "text-bear")}>
                {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                {formatPercent(btc.change24h)}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
          {intervals.map((it) => (
            <button
              key={it.id}
              onClick={() => setIv(it.id)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-semibold transition-all duration-200",
                iv === it.id ? "bg-cyan-violet text-base-950" : "text-ink-muted hover:text-ink"
              )}
            >
              {it.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        {isLoading && !candles.length ? (
          <div className="grid h-[320px] place-items-center">
            <Loader2 className="h-6 w-6 animate-spin text-ink-faint" />
          </div>
        ) : (
          <CandleChart candles={candles} height={320} />
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { l: `${iv.toUpperCase()} ${t("ov.high")}`, v: formatUsd(high) },
          { l: `${iv.toUpperCase()} ${t("ov.low")}`, v: formatUsd(low) },
          { l: t("ov.volume24h"), v: `$${formatCompact(btc.volume24h)}` },
          { l: t("ov.marketCap"), v: `$${formatCompact(btc.marketCap)}` },
        ].map((s) => (
          <div key={s.l} className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-ink-faint">{s.l}</div>
            <div dir="ltr" className="mt-0.5 text-start font-mono text-sm font-semibold tnum">{s.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
