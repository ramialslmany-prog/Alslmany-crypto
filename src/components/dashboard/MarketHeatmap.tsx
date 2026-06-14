"use client";

import Link from "next/link";
import { Grid3x3, ArrowUpRight } from "lucide-react";
import { useMarkets } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { formatUsd, formatPercent } from "@/lib/format";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { cn } from "@/lib/utils";

function tileBg(change: number) {
  const intensity = Math.min(1, Math.abs(change) / 8);
  const alpha = 0.08 + intensity * 0.26;
  return change >= 0 ? `rgba(0,230,118,${alpha})` : `rgba(255,77,109,${alpha})`;
}

export function MarketHeatmap() {
  const { coins, isLive } = useMarkets();
  const { t } = useI18n();
  const top = coins.slice(0, 12);

  return (
    <div className="glass glow-border rounded-2xl p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Grid3x3 className="h-4 w-4 text-bull" />
          <h2 className="text-sm font-semibold">{t("nav.heatmap")}</h2>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/dashboard/markets" className="flex items-center gap-1 text-[11px] font-medium text-ink-muted transition-colors hover:text-cyan">
            {t("ex.viewAll")} <ArrowUpRight className="h-3 w-3" />
          </Link>
          <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
            <span className={cn("h-1.5 w-1.5 rounded-full", isLive ? "bg-bull animate-pulse-glow" : "bg-gold")} />
            {isLive ? "live" : "demo"}
          </span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {top.map((c) => {
          const up = c.change24h >= 0;
          return (
            <div
              key={c.symbol}
              className="group relative overflow-hidden rounded-xl border border-white/[0.06] p-3 transition-transform duration-300 hover:scale-[1.03]"
              style={{ background: tileBg(c.change24h) }}
            >
              <div className="flex items-center gap-2">
                <CoinIcon symbol={c.symbol} image={c.image} size={20} />
                <span className="text-sm font-bold">{c.symbol}</span>
              </div>
              <div className="mt-2 font-mono text-xs text-ink tnum">{formatUsd(c.price)}</div>
              <div dir="ltr" className={cn("text-start font-mono text-sm font-bold tnum", up ? "text-bull" : "text-bear")}>
                {formatPercent(c.change24h)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
