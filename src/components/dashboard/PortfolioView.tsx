"use client";

import { useEffect, useState } from "react";
import { Wallet, ArrowUpRight, ArrowDownRight, Trash2, Activity } from "lucide-react";
import { useTracker, evaluate, assessHealth, pnlUsd, setPositionAmount, type Health } from "@/lib/tracker";
import { signalLabelKey } from "@/lib/signal-engine";
import { useMarkets } from "@/lib/hooks";
import { useI18n, timeAgo } from "@/lib/i18n";
import { colorOf } from "@/lib/coin-meta";
import { formatUsd, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

const HEALTH_CLS: Record<Health, string> = {
  hold: "text-bull bg-bull/10 border-bull/30",
  watch: "text-gold bg-gold/10 border-gold/30",
  takeProfit: "text-cyan bg-cyan/10 border-cyan/30",
  exit: "text-bear bg-bear/10 border-bear/30",
};

export function PortfolioView() {
  const tracked = useTracker();
  const { coins } = useMarkets();
  const { t, lang } = useI18n();

  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const priceOf = (sym: string) => coins.find((c) => c.symbol === sym)?.price ?? 0;
  const positions = tracked.filter((s) => s.amount);

  const invested = positions.reduce((a, s) => a + (s.amount ?? 0), 0);
  const totalPnl = positions.reduce((a, s) => a + pnlUsd(s, priceOf(s.symbol) || s.entry), 0);
  const value = invested + totalPnl;
  const roi = invested > 0 ? (totalPnl / invested) * 100 : 0;

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <Wallet className="h-5 w-5 text-cyan" />
          <h1 className="font-display text-2xl font-bold tracking-tight">{t("pf.title")}</h1>
        </div>
        <p className="mt-1 text-sm text-ink-muted">{t("pf.subtitle")}</p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={t("tr.invested")} value={formatUsd(invested)} />
        <Kpi label={t("pf.totalValue")} value={formatUsd(value)} />
        <Kpi label={t("pf.totalPnl")} value={`${totalPnl >= 0 ? "+" : "-"}${formatUsd(Math.abs(totalPnl))}`} tone={totalPnl >= 0 ? "bull" : "bear"} ltr />
        <Kpi label={t("tr.roi")} value={formatPercent(roi)} tone={roi >= 0 ? "bull" : "bear"} ltr />
      </div>

      {/* positions */}
      <div className="glass glow-border overflow-hidden rounded-2xl">
        <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
          <Activity className="h-4 w-4 text-cyan" />
          <h2 className="text-sm font-semibold">{t("pf.open")}</h2>
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-semibold text-ink-muted tnum">{positions.length}</span>
        </div>

        {positions.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-ink-muted">{t("pf.empty")}</div>
        ) : (
          <div className="divide-y divide-white/[0.05]">
            {positions.map((s) => {
              const price = priceOf(s.symbol) || s.entry;
              const { pnlPct } = evaluate(s, price);
              const dollar = pnlUsd(s, price);
              const health = assessHealth(s, price);
              const long = s.direction === "LONG";
              return (
                <div key={s.id} className="grid grid-cols-2 items-center gap-3 px-4 py-3 sm:grid-cols-12">
                  <div className="col-span-1 flex items-center gap-2.5 sm:col-span-3">
                    <span className="grid h-8 w-8 place-items-center rounded-lg text-[10px] font-bold" style={{ background: `${colorOf(s.symbol)}22`, color: colorOf(s.symbol) }}>
                      {s.symbol}
                    </span>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-semibold">{s.symbol}</span>
                        <span className={cn("text-[11px] font-bold", long ? "text-bull" : "text-bear")}>{t(signalLabelKey(s.direction, s.market))}</span>
                      </div>
                      <div className="text-[10px] text-ink-faint">{timeAgo(s.startedAt, t)}</div>
                    </div>
                  </div>
                  <Cell label={t("tr.invested")} value={formatUsd(s.amount!)} className="sm:col-span-2" />
                  <Cell label={t("tr.value")} value={formatUsd(s.amount! + dollar)} className="sm:col-span-2" />
                  <Cell label={t("tr.pnlUsd")} value={`${dollar >= 0 ? "+" : "-"}${formatUsd(Math.abs(dollar))}`} tone={dollar >= 0 ? "bull" : "bear"} className="sm:col-span-2" ltr />
                  <Cell label={t("tr.roi")} value={formatPercent(pnlPct)} tone={pnlPct >= 0 ? "bull" : "bear"} className="sm:col-span-2" ltr />
                  <div className="col-span-2 flex items-center justify-between gap-2 sm:col-span-1 sm:justify-end">
                    <span className={cn("inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold", HEALTH_CLS[health])}>
                      {long ? <ArrowUpRight className="h-2.5 w-2.5" /> : <ArrowDownRight className="h-2.5 w-2.5" />}
                    </span>
                    <button onClick={() => setPositionAmount(s.id, undefined)} className="text-ink-faint transition-colors hover:text-bear">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="col-span-2 sm:hidden">
                    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold", HEALTH_CLS[health])}>{t(`health.${health}`)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, tone, ltr }: { label: string; value: string; tone?: "bull" | "bear"; ltr?: boolean }) {
  return (
    <div className="glass glow-border rounded-2xl p-4">
      <div dir={ltr ? "ltr" : undefined} className={cn("font-display text-2xl font-bold tracking-tight tnum", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-ink")}>
        {value}
      </div>
      <div className="mt-0.5 text-xs text-ink-muted">{label}</div>
    </div>
  );
}

function Cell({ label, value, tone, className, ltr }: { label: string; value: string; tone?: "bull" | "bear"; className?: string; ltr?: boolean }) {
  return (
    <div className={className}>
      <div className="text-[10px] uppercase tracking-wider text-ink-faint sm:hidden">{label}</div>
      <div dir={ltr ? "ltr" : undefined} className={cn("font-mono text-xs font-semibold tnum", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-ink")}>{value}</div>
    </div>
  );
}
