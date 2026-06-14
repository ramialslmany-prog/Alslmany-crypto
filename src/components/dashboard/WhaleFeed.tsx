"use client";

import { ArrowDownLeft, ArrowUpRight, Fish, Loader2 } from "lucide-react";
import { useWhales } from "@/lib/hooks";
import { useI18n, timeAgo } from "@/lib/i18n";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

export function WhaleFeed() {
  const { t } = useI18n();
  const { trades, netBuyUsd, netSellUsd, isLive, isLoading } = useWhales();
  const net = netBuyUsd - netSellUsd;
  const total = netBuyUsd + netSellUsd || 1;
  const buyShare = (netBuyUsd / total) * 100;

  return (
    <div className="glass glow-border rounded-2xl p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Fish className="h-4 w-4 text-cyan" />
          <h2 className="text-sm font-semibold">{t("nav.whaleFlow")}</h2>
        </div>
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-ink-faint">
          {isLoading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <span className={cn("h-1.5 w-1.5 rounded-full", isLive ? "bg-bull animate-pulse" : "bg-gold")} />
          )}
          {isLive ? t("wh.live") : t("wh.unavailable")}
        </span>
      </div>

      <p className="mt-1 text-xs text-ink-faint">{t("wh.sub")}</p>

      {/* net pressure bar */}
      <div className="mt-4">
        <div className="flex items-center justify-between text-[11px] font-semibold">
          <span className="text-bull">{t("ov.accumulation")} {formatUsd(netBuyUsd, { compact: true })}</span>
          <span className="text-bear">{formatUsd(netSellUsd, { compact: true })} {t("ov.distribution")}</span>
        </div>
        <div className="mt-1.5 flex h-2 overflow-hidden rounded-full bg-bear/30">
          <div className="h-full rounded-full bg-bull transition-all" style={{ width: `${buyShare}%` }} />
        </div>
        <div className="mt-1.5 text-center text-[11px] font-bold" dir="ltr">
          <span className={net >= 0 ? "text-bull" : "text-bear"}>
            {t("wh.net")}: {net >= 0 ? "+" : "−"}{formatUsd(Math.abs(net), { compact: true })}
          </span>
        </div>
      </div>

      <div className="mt-3 max-h-[460px] space-y-1 overflow-y-auto pe-1">
        {trades.length === 0 && !isLoading && (
          <div className="rounded-xl border border-dashed border-white/[0.1] px-4 py-8 text-center text-sm text-ink-faint">
            {t("wh.empty")}
          </div>
        )}
        {trades.map((w) => {
          const buy = w.side === "accumulation";
          return (
            <div key={w.id} className="flex items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-white/[0.03]">
              <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", buy ? "bg-bull/12 text-bull" : "bg-bear/12 text-bear")}>
                {buy ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
              </span>
              <CoinIcon symbol={w.symbol} size={22} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold">{w.symbol}</span>
                  <span className={cn("text-[11px] font-medium", buy ? "text-bull" : "text-bear")}>
                    {buy ? t("ov.accumulation") : t("ov.distribution")}
                  </span>
                </div>
                <div className="truncate text-[11px] text-ink-faint" dir="ltr">@ {formatUsd(w.price)}</div>
              </div>
              <div className="text-end">
                <div dir="ltr" className="font-mono text-sm font-semibold tnum">{formatUsd(w.amountUsd, { compact: true })}</div>
                <div className="text-[11px] text-ink-faint">{timeAgo(w.ts, t)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
