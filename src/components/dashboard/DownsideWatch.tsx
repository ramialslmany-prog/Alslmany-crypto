"use client";

import { useMemo } from "react";
import Link from "next/link";
import { TrendingDown, ChevronRight, ShieldAlert } from "lucide-react";
import { useMarkets } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { scanCoin } from "@/lib/scan-engine";
import { isStable } from "@/lib/coin-meta";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { Sparkline } from "@/components/ui/Sparkline";
import { LivePrice } from "@/components/ui/LivePrice";
import { formatUsd, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Downside watch — the sell-side counterpart of the opportunity radar. Surfaces
 * liquid coins under real pressure (engine-confirmed breakdowns and heavy
 * declines) so holders get warned, not just buyers get ideas. Same engine, same
 * honesty: this is a warning list, not a short-selling signal feed.
 */
export function DownsideWatch() {
  const { coins } = useMarkets();
  const { t } = useI18n();

  const decliners = useMemo(
    () =>
      coins
        .filter((c) => !isStable(c.symbol) && (c.rank ?? 999) <= 100)
        .map((c) => ({ c, r: scanCoin(c, "day", "spot") }))
        // Under pressure = the engine reads a breakdown (spot SHORT = exit/avoid
        // in a downtrend) AND price is actually falling today, OR a heavy day
        // (−5%+) — liquid names only. A flat coin is not a warning.
        .filter((x) => (x.r.signal === "SHORT" && x.r.trend === "down" && (x.c.change24h ?? 0) <= -2) || (x.c.change24h ?? 0) <= -5)
        .map((x) => ({
          ...x,
          sev:
            -(x.c.change24h ?? 0) * 1.5 -
            (x.c.change7d ?? 0) * 0.4 +
            (x.r.signal === "SHORT" ? 10 : 0) +
            (x.r.trend === "down" ? 6 : 0),
        }))
        .sort((a, b) => b.sev - a.sev)
        .slice(0, 5),
    [coins]
  );

  const breakdowns = decliners.filter((d) => d.r.signal === "SHORT" && d.r.trend === "down").length;

  return (
    <div className="glass glow-border rounded-2xl p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <TrendingDown className="h-4 w-4 text-bear" />
          <h2 className="text-sm font-semibold">{t("dw.title")}</h2>
          {decliners.length > 0 && (
            <span className="rounded-full border border-bear/30 bg-bear/10 px-2 py-0.5 text-[10px] font-bold text-bear tnum">{decliners.length}</span>
          )}
        </div>
        <Link href="/dashboard/markets" className="flex items-center gap-1 text-xs font-medium text-ink-muted transition-colors hover:text-cyan">
          {t("ov.viewAll")} <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />
        </Link>
      </div>
      <p className="mt-1 text-[11px] text-ink-faint">{t("dw.sub")}</p>

      <div className="mt-3 space-y-2">
        {decliners.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/[0.1] px-4 py-6 text-center text-sm text-ink-faint">{t("dw.empty")}</div>
        ) : (
          decliners.map(({ c, r }) => {
            const breakdown = r.signal === "SHORT" && r.trend === "down";
            return (
              <Link
                key={c.symbol}
                href={`/dashboard/coin/${c.symbol}`}
                className="flex items-center gap-2.5 rounded-xl border border-white/[0.05] bg-white/[0.02] p-2.5 transition-colors hover:border-bear/25"
              >
                <CoinIcon symbol={c.symbol} image={c.image} size={26} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-bold">{c.symbol}</span>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[9px] font-bold",
                        breakdown ? "bg-bear/15 text-bear" : "bg-gold/15 text-gold"
                      )}
                    >
                      {breakdown ? t("dw.breakdown") : t("dw.down")}
                    </span>
                  </div>
                  <div dir="ltr" className="mt-0.5 flex items-center gap-2 text-[11px]">
                    <LivePrice value={c.price} format={formatUsd} className="font-mono font-semibold text-ink" />
                    <span className="font-mono font-semibold tnum text-bear">{formatPercent(c.change24h)}</span>
                    <span className="font-mono text-[10px] tnum text-ink-faint">7d {formatPercent(c.change7d)}</span>
                  </div>
                </div>
                <span dir="ltr" className="hidden rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-ink-muted sm:block">RSI {r.indicators.rsi.toFixed(0)}</span>
                {c.spark?.length > 1 && (
                  <div className="hidden w-16 sm:block [&_svg]:h-auto [&_svg]:w-full">
                    <Sparkline data={c.spark} width={64} height={22} color="#FF4D6D" strokeWidth={1.3} fill={false} />
                  </div>
                )}
              </Link>
            );
          })
        )}
      </div>

      {breakdowns > 0 && (
        <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-ink-faint">
          <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0 text-bear" />
          {t("dw.note")}
        </p>
      )}
    </div>
  );
}
