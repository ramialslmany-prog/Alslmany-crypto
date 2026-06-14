"use client";

import { useState } from "react";
import { History, Play, Loader2, TrendingUp } from "lucide-react";
import { useBacktest } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { Sparkline } from "@/components/ui/Sparkline";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { formatUsd, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

const SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "LINK"];
const STYLES = [
  { key: "scalp", tf: "15m" },
  { key: "day", tf: "1h" },
  { key: "swing", tf: "4h" },
];

const OUTCOME_CLS: Record<string, string> = {
  tp3: "text-bull bg-bull/10 border-bull/30",
  trail: "text-bull bg-bull/10 border-bull/30",
  breakeven: "text-ink-muted bg-white/[0.06] border-white/15",
  stop: "text-bear bg-bear/10 border-bear/30",
  timeout: "text-gold bg-gold/10 border-gold/30",
};

export function BacktestView() {
  const { t, lang } = useI18n();
  const [symbol, setSymbol] = useState("BTC");
  const [style, setStyle] = useState("day");
  const [run, setRun] = useState(false);
  const { data, isLoading } = useBacktest(symbol, style, run);

  const outcomeLabel = (o: string) =>
    o === "tp3" ? t("bt.oTp3") : o === "trail" ? t("bt.oTrail") : o === "breakeven" ? t("at.breakeven") : o === "stop" ? t("bt.oStop") : t("bt.oTimeout");

  const dateRange =
    data?.fromTs && data?.toTs
      ? `${new Date(data.fromTs).toLocaleDateString()} → ${new Date(data.toTs).toLocaleDateString()}`
      : "";

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      {/* header */}
      <div className="glass glow-border rounded-2xl p-5">
        <div className="flex items-center gap-2">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-violet/15 text-violet"><History className="h-5 w-5" /></span>
          <div>
            <h1 className="font-display text-xl font-bold">{t("bt.title")}</h1>
            <p className="text-sm text-ink-muted">{t("bt.sub")}</p>
          </div>
        </div>

        {/* controls */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1.5">
            {SYMBOLS.map((s) => (
              <button
                key={s}
                onClick={() => { setSymbol(s); setRun(false); }}
                className={cn("flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-colors",
                  symbol === s ? "border-cyan/40 bg-cyan/10 text-cyan" : "border-white/[0.08] text-ink-muted hover:bg-white/[0.04]")}
              >
                <CoinIcon symbol={s} size={16} /> {s}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="flex gap-1.5">
            {STYLES.map((s) => (
              <button
                key={s.key}
                onClick={() => { setStyle(s.key); setRun(false); }}
                className={cn("rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors",
                  style === s.key ? "border-violet/40 bg-violet/10 text-violet" : "border-white/[0.08] text-ink-muted hover:bg-white/[0.04]")}
              >
                {t(`ms.${s.key}`)} · {s.tf}
              </button>
            ))}
          </div>
          <button
            onClick={() => setRun(true)}
            disabled={isLoading}
            className="ms-auto inline-flex items-center gap-2 rounded-xl bg-cyan-violet px-5 py-2.5 text-sm font-bold text-base-950 transition-transform hover:scale-[1.02] disabled:opacity-50"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} {isLoading ? t("bt.running") : t("bt.run")}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-ink-faint">{t("bt.note")}</p>
      </div>

      {!run && (
        <div className="glass rounded-2xl px-4 py-10 text-center text-sm text-ink-faint">{t("bt.idle")}</div>
      )}

      {run && isLoading && (
        <div className="glass rounded-2xl px-4 py-10 text-center text-sm text-ink-muted">
          <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-cyan" /> {t("bt.running")}…
        </div>
      )}

      {run && data && !isLoading && (data.error || data.trades === 0 ? (
        <div className="glass rounded-2xl px-4 py-10 text-center text-sm text-ink-faint">{t("bt.noTrades")}</div>
      ) : (
        <>
          {/* equity curve */}
          <div className="glass glow-border rounded-2xl p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <TrendingUp className="h-4 w-4 text-cyan" /> {t("bt.equity")}
              </div>
              <span className="text-[11px] text-ink-faint" dir="ltr">{dateRange} · {data.bars} {t("bt.candles")}</span>
            </div>
            <div className="w-full">
              <Sparkline
                data={data.equityCurve}
                width={760}
                height={120}
                color={data.totalReturnPct >= 0 ? "#00E676" : "#FF4D6D"}
                strokeWidth={2}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] text-ink-faint" dir="ltr">
              <span>$100 start</span>
              <span className={cn("font-bold", data.totalReturnPct >= 0 ? "text-bull" : "text-bear")}>
                ${(100 + data.totalReturnPct).toFixed(2)} ({formatPercent(data.totalReturnPct)})
              </span>
            </div>
          </div>

          {/* KPIs */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Kpi label={t("bt.kTrades")} v={String(data.trades)} color="#00D4FF" />
            <Kpi label={t("bt.kWinRate")} v={`${data.winRate.toFixed(0)}%`} color={data.winRate >= 50 ? "#00E676" : "#FF4D6D"} />
            <Kpi label={t("bt.kReturn")} v={formatPercent(data.totalReturnPct)} color={data.totalReturnPct >= 0 ? "#00E676" : "#FF4D6D"} />
            <Kpi label={t("bt.kPF")} v={data.profitFactor.toFixed(2)} color="#FFD166" />
            <Kpi label={t("bt.kBest")} v={formatPercent(data.bestPct)} color="#00E676" />
            <Kpi label={t("bt.kWorst")} v={formatPercent(data.worstPct)} color="#FF4D6D" />
          </div>

          {/* recent trades */}
          <div className="glass glow-border rounded-2xl p-5">
            <div className="mb-3 text-sm font-semibold">{t("bt.recentTrades")}</div>
            <div className="space-y-1.5">
              {data.recent.map((tr, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                  <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold", OUTCOME_CLS[tr.outcome])}>
                    {outcomeLabel(tr.outcome)}
                  </span>
                  <span dir="ltr" className="font-mono text-[11px] text-ink-muted tnum">{formatUsd(tr.entry)} → {formatUsd(tr.exit)}</span>
                  <span className="text-[11px] text-ink-faint">{tr.bars} {t("bt.bars")}</span>
                  <span dir="ltr" className={cn("ms-auto font-mono text-sm font-bold tnum", tr.retPct >= 0 ? "text-bull" : "text-bear")}>{formatPercent(tr.retPct)}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-center text-[11px] text-ink-faint">
              {lang === "ar" ? `المصدر: ${data.source} · ${t("ms.disclaimer")}` : `Source: ${data.source} · ${t("ms.disclaimer")}`}
            </p>
          </div>
        </>
      ))}
    </div>
  );
}

function Kpi({ label, v, color }: { label: string; v: string; color: string }) {
  return (
    <div className="glass rounded-2xl p-4">
      <div dir="ltr" className="font-display text-xl font-bold tracking-tight tnum" style={{ color }}>{v}</div>
      <div className="mt-0.5 text-[11px] text-ink-muted">{label}</div>
    </div>
  );
}
