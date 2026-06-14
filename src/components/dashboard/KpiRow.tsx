"use client";

import { useEffect, useState } from "react";
import { Wallet, TrendingUp, BarChart3, Layers } from "lucide-react";
import { useTracker, pnlUsd } from "@/lib/tracker";
import { useMarkets } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { formatUsd, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Overview KPIs derived from the user's real entered positions (same source as the Portfolio page). */
export function KpiRow() {
  const tracked = useTracker();
  const { coins } = useMarkets();
  const { t } = useI18n();

  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const priceOf = (sym: string) => coins.find((c) => c.symbol === sym)?.price ?? 0;
  const positions = tracked.filter((s) => s.amount);
  const invested = positions.reduce((a, s) => a + (s.amount ?? 0), 0);
  const openPnl = positions.reduce((a, s) => a + pnlUsd(s, priceOf(s.symbol) || s.entry), 0);
  const value = invested + openPnl;
  const roi = invested > 0 ? (openPnl / invested) * 100 : 0;

  const cards = [
    { icon: Wallet, label: t("kpi.invested"), value: formatUsd(invested), color: "#00D4FF" },
    { icon: BarChart3, label: t("kpi.value"), value: formatUsd(value), color: "#7C4DFF" },
    {
      icon: TrendingUp,
      label: t("kpi.openPnl"),
      value: `${openPnl >= 0 ? "+" : "-"}${formatUsd(Math.abs(openPnl))}`,
      sub: formatPercent(roi),
      color: openPnl >= 0 ? "#00E676" : "#FF4D6D",
      ltr: true,
    },
    { icon: Layers, label: t("kpi.openPositions"), value: String(positions.length), color: "#FFD166" },
  ];

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((k) => (
          <div key={k.label} className="glass glow-border group rounded-2xl p-5 transition-transform duration-500 ease-out-quint hover:-translate-y-1">
            <span className="grid h-9 w-9 place-items-center rounded-xl" style={{ background: `${k.color}1f`, color: k.color }}>
              <k.icon className="h-[18px] w-[18px]" strokeWidth={1.9} />
            </span>
            <div dir={k.ltr ? "ltr" : undefined} className="mt-4 font-display text-2xl font-bold tracking-tight tnum" style={k.color === "#00E676" || k.color === "#FF4D6D" ? { color: k.color } : undefined}>
              {k.value}
              {k.sub && <span className="ms-2 text-sm font-semibold opacity-80">{k.sub}</span>}
            </div>
            <div className="mt-0.5 text-xs text-ink-faint">{k.label}</div>
          </div>
        ))}
      </div>
      {positions.length === 0 && <p className="px-1 text-xs text-ink-faint">{t("kpi.hint")}</p>}
    </div>
  );
}
