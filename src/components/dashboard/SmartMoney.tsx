"use client";

import { useState } from "react";
import { Waves, TrendingUp, TrendingDown, Minus, Loader2 } from "lucide-react";
import { useStructure, type StructureRow } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

const TFS: { key: "day" | "swing" | "macro"; tf: string }[] = [
  { key: "day", tf: "1h" },
  { key: "swing", tf: "4h" },
  { key: "macro", tf: "1d" },
];

const STRUCT_CLS = (s: string) =>
  s.includes("up") || s.includes("bull") ? "text-bull" : s.includes("down") || s.includes("bear") ? "text-bear" : "text-ink-muted";

export function SmartMoney() {
  const { t } = useI18n();
  const [tf, setTf] = useState<"day" | "swing" | "macro">("swing");
  const { data, isLoading } = useStructure(tf);

  const TrendIcon = ({ trend }: { trend: StructureRow["trend"] }) =>
    trend === "up" ? <TrendingUp className="h-4 w-4 text-bull" /> : trend === "down" ? <TrendingDown className="h-4 w-4 text-bear" /> : <Minus className="h-4 w-4 text-ink-faint" />;

  const structLabel = (s: string) => {
    if (s.startsWith("BOS up")) return t("sm.bosUp");
    if (s.startsWith("BOS down")) return t("sm.bosDown");
    if (s.startsWith("CHoCH bull")) return t("sm.chochBull");
    if (s.startsWith("CHoCH bear")) return t("sm.chochBear");
    return t("sm.ranging");
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="glass glow-border rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan/15 text-cyan"><Waves className="h-5 w-5" /></span>
            <div>
              <h1 className="font-display text-xl font-bold">{t("sm.title")}</h1>
              <p className="text-sm text-ink-muted">{t("sm.sub")}</p>
            </div>
          </div>
          <div className="flex gap-1.5">
            {TFS.map((x) => (
              <button
                key={x.key}
                onClick={() => setTf(x.key)}
                className={cn("rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors",
                  tf === x.key ? "border-cyan/40 bg-cyan/10 text-cyan" : "border-white/[0.08] text-ink-muted hover:bg-white/[0.04]")}
              >
                {t(`sm.${x.key}`)} · {x.tf}
              </button>
            ))}
          </div>
        </div>

        {/* market-wide bias summary */}
        {data && (
          <div className="mt-4 grid grid-cols-3 gap-3">
            <Tally label={t("sm.bullish")} v={data.bullish} color="#00E676" />
            <Tally label={t("sm.neutral")} v={data.neutral} color="#9AA4B2" />
            <Tally label={t("sm.bearish")} v={data.bearish} color="#FF4D6D" />
          </div>
        )}
      </div>

      <div className="glass glow-border rounded-2xl p-4">
        {isLoading && !data ? (
          <div className="py-12 text-center text-sm text-ink-muted"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-cyan" /> {t("sm.loading")}</div>
        ) : (
          <div className="space-y-1.5">
            {/* header row (desktop) */}
            <div className="hidden grid-cols-12 gap-2 px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint lg:grid">
              <div className="col-span-2">{t("sm.coin")}</div>
              <div className="col-span-2">{t("sm.trend")}</div>
              <div className="col-span-3">{t("sm.structure")}</div>
              <div className="col-span-2 text-end">{t("sm.support")}</div>
              <div className="col-span-2 text-end">{t("sm.resistance")}</div>
              <div className="col-span-1 text-end">RSI</div>
            </div>
            {data?.rows.map((r) => (
              <div key={r.symbol} className="grid grid-cols-2 items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 lg:grid-cols-12">
                <div className="col-span-2 flex items-center gap-2">
                  <CoinIcon symbol={r.symbol} size={24} />
                  <div>
                    <div className="text-sm font-bold">{r.symbol}</div>
                    <div dir="ltr" className="font-mono text-[11px] text-ink-faint tnum">{formatUsd(r.price)}</div>
                  </div>
                </div>
                <div className="col-span-2 flex items-center justify-end gap-1.5 lg:justify-start">
                  <TrendIcon trend={r.trend} />
                  <span className={cn("text-xs font-semibold", r.trend === "up" ? "text-bull" : r.trend === "down" ? "text-bear" : "text-ink-muted")}>
                    {t(`sm.t${r.trend}`)}
                  </span>
                </div>
                <div className={cn("col-span-2 text-xs font-semibold lg:col-span-3", STRUCT_CLS(r.structure))}>
                  {structLabel(r.structure)}
                  {r.fvg && <span className="ms-1.5 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-ink-muted">FVG {r.fvg === "bull" ? "🟢" : "🔴"}</span>}
                </div>
                <div className="col-span-1 text-end font-mono text-[11px] text-bull tnum lg:col-span-2">{formatUsd(r.support)}</div>
                <div className="col-span-1 text-end font-mono text-[11px] text-bear tnum lg:col-span-2">{formatUsd(r.resistance)}</div>
                <div className="col-span-2 text-end font-mono text-xs tnum lg:col-span-1">
                  <span className={cn(r.rsi >= 70 ? "text-bear" : r.rsi <= 30 ? "text-bull" : "text-ink-muted")}>{r.rsi.toFixed(0)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-center text-[11px] text-ink-faint">{t("sm.legend")}</p>
      </div>
    </div>
  );
}

function Tally({ label, v, color }: { label: string; v: number; color: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-center">
      <div className="font-display text-2xl font-bold tnum" style={{ color }}>{v}</div>
      <div className="text-[11px] text-ink-muted">{label}</div>
    </div>
  );
}
