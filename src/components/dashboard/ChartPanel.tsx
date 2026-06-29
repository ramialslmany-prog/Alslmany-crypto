"use client";

import { useState } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { AreaChart } from "@/components/ui/AreaChart";
import { LivePrice } from "@/components/ui/LivePrice";
import { useChart, useCoin } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { formatUsd, formatPercent, formatCompact } from "@/lib/format";
import { cn } from "@/lib/utils";

const timeframes = ["1H", "4H", "1D", "1W", "1M"] as const;
const DAYS: Record<string, number> = { "1H": 1, "4H": 1, "1D": 1, "1W": 7, "1M": 30 };

export function ChartPanel() {
  const { t } = useI18n();
  const [tf, setTf] = useState<string>("1D");
  const btc = useCoin("BTC");
  const { prices, isLive } = useChart("BTC", DAYS[tf]);

  const up = btc.change24h >= 0;
  const high = prices.length ? Math.max(...prices) : btc.price;
  const low = prices.length ? Math.min(...prices) : btc.price;

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
          {timeframes.map((t) => (
            <button
              key={t}
              onClick={() => setTf(t)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-semibold transition-all duration-200",
                tf === t ? "bg-cyan-violet text-base-950" : "text-ink-muted hover:text-ink"
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <AreaChart key={tf} data={prices} height={300} color={btc.color} color2="#7C4DFF" />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { l: `${tf} ${t("ov.high")}`, v: formatUsd(high) },
          { l: `${tf} ${t("ov.low")}`, v: formatUsd(low) },
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
