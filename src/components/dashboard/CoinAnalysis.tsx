"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, ArrowDownRight, Brain, Loader2, ShieldCheck, Target, Gauge, Activity } from "lucide-react";
import { useMarkets, useCandles, useSignal } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { STYLE_TF, signalLabelKey, type Style } from "@/lib/signal-engine";
import { deepAnalyze } from "@/lib/deep-analyze";
import type { Coin } from "@/lib/mock-data";
import { CandleChart } from "@/components/ui/CandleChart";
import { LivePrice } from "@/components/ui/LivePrice";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { formatUsd, formatPercent, formatCompact } from "@/lib/format";
import { cn } from "@/lib/utils";

const STYLES: Style[] = ["scalp", "day", "swing"];

export function CoinAnalysis({ symbol }: { symbol: string }) {
  const { t, lang } = useI18n();
  const { coins } = useMarkets();
  const [style, setStyle] = useState<Style>("day");
  const interval = STYLE_TF[style].ltf;

  const { candles, source, isLoading: candlesLoading } = useCandles(symbol, interval, 180);
  const { rec, isLoading: signalLoading } = useSignal(symbol, style, "spot");

  // Header coin: from the live markets list, or synthesized from the latest candle.
  const coin: Coin = useMemo(() => {
    const found = coins.find((c) => c.symbol === symbol);
    if (found) return found;
    const last = candles[candles.length - 1];
    return {
      symbol,
      name: symbol,
      price: last?.c ?? 0,
      change24h: 0,
      change7d: 0,
      marketCap: 0,
      volume24h: 0,
      color: "#7C4DFF",
      spark: candles.map((c) => c.c),
    };
  }, [coins, symbol, candles]);

  // Support / resistance from the recent visible range.
  const { support, resistance } = useMemo(() => {
    const view = candles.slice(-60);
    if (!view.length) return { support: coin.price, resistance: coin.price };
    return { support: Math.min(...view.map((c) => c.l)), resistance: Math.max(...view.map((c) => c.h)) };
  }, [candles, coin.price]);

  // Live AI deep read — auto-loaded for this dedicated analysis page.
  const [ai, setAi] = useState<{ text: string; provider: "ai" | "local"; loading: boolean }>({ text: "", provider: "local", loading: true });
  useEffect(() => {
    let cancelled = false;
    setAi((a) => ({ ...a, loading: true }));
    (async () => {
      const res = await deepAnalyze(coin, lang);
      if (!cancelled) setAi({ text: res.text, provider: res.provider, loading: false });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, lang]);

  const up = coin.change24h >= 0;
  const isLive = !!source && source !== "synthetic";
  const dist = (p: number) => ((p - coin.price) / coin.price) * 100;

  return (
    <div className="space-y-4">
      {/* back */}
      <Link href="/dashboard/markets" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted transition-colors hover:text-cyan">
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> {t("nav.markets")}
      </Link>

      {/* header */}
      <div className="glass glow-border flex flex-wrap items-center justify-between gap-4 rounded-2xl p-5">
        <div className="flex items-center gap-3.5">
          <CoinIcon symbol={coin.symbol} image={coin.image} size={48} />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-display text-2xl font-bold tracking-tight">{coin.name}</h1>
              <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-semibold text-ink-muted">{coin.symbol}</span>
              {coin.rank ? <span className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-ink-faint">#{coin.rank}</span> : null}
              {coin.dex && <span className="rounded bg-violet/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-violet">DEX</span>}
            </div>
            <div dir="ltr" className="mt-1 flex items-center gap-2">
              <LivePrice value={coin.price} format={formatUsd} className="font-mono text-2xl font-bold text-ink" />
              <span className={cn("flex items-center gap-0.5 text-xs font-semibold tnum", up ? "text-bull" : "text-bear")}>
                {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                {formatPercent(coin.change24h)}
              </span>
              <span className="text-[11px] text-ink-faint tnum">7d {formatPercent(coin.change7d)}</span>
            </div>
          </div>
        </div>
        <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest">
          <span className={cn("h-1.5 w-1.5 rounded-full", isLive ? "bg-bull animate-pulse-glow" : "bg-gold")} />
          <span className={isLive ? "text-bull" : "text-gold"}>{isLive ? t("ov.live") : t("ov.demo")}</span>
        </span>
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        {/* chart + indicators */}
        <div className="space-y-4 xl:col-span-8">
          <div className="glass glow-border rounded-2xl p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">{coin.symbol}/USDT</h2>
              <div className="flex items-center gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
                {STYLES.map((s) => (
                  <button key={s} onClick={() => setStyle(s)} className={cn("rounded-lg px-3 py-1.5 text-xs font-semibold transition-all", style === s ? "bg-cyan-violet text-base-950" : "text-ink-muted hover:text-ink")}>
                    {t(`ms.${s}`)}
                  </button>
                ))}
              </div>
            </div>
            {candlesLoading && !candles.length ? (
              <div className="grid h-[340px] place-items-center"><Loader2 className="h-6 w-6 animate-spin text-ink-faint" /></div>
            ) : (
              <CandleChart candles={candles} height={340} />
            )}
          </div>

          {/* indicators */}
          <div className="glass glow-border rounded-2xl p-5">
            <div className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Activity className="h-4 w-4 text-cyan" /> {t("coin.indicators")}</div>
            {rec ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Metric label="RSI" value={rec.indicators.rsi.toFixed(0)} tone={rec.indicators.rsi >= 70 ? "bear" : rec.indicators.rsi <= 35 ? "bull" : "ink"} bar={rec.indicators.rsi} />
                <Metric label="MACD" value={`${rec.indicators.macdHist >= 0 ? "+" : ""}${rec.indicators.macdHist.toFixed(2)}`} tone={rec.indicators.macdHist >= 0 ? "bull" : "bear"} />
                <Metric label="ATR" value={`${rec.indicators.atrPct.toFixed(2)}%`} tone="ink" />
                <Metric label="%B" value={rec.indicators.bbPctB.toFixed(2)} tone={rec.indicators.bbPctB >= 0.8 ? "bear" : rec.indicators.bbPctB <= 0.2 ? "bull" : "ink"} />
              </div>
            ) : (
              <SkeletonRow />
            )}
            {rec && rec.reasons.length > 0 && (
              <ul className="mt-4 space-y-1.5 border-t border-white/[0.06] pt-3">
                {rec.reasons.slice(0, 5).map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-ink-muted"><span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-cyan" /> {r}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* trade plan + levels + snapshot */}
        <div className="space-y-4 xl:col-span-4">
          <div className="glass glow-border rounded-2xl p-5">
            <div className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Target className="h-4 w-4 text-violet" /> {t("ms.tradePlan")}</div>
            {signalLoading && !rec ? (
              <SkeletonRow />
            ) : rec ? (
              <>
                <div className="mb-3 flex items-center justify-between">
                  <span className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-wider",
                    rec.signal === "LONG" ? "border-bull/30 bg-bull/10 text-bull" : rec.signal === "SHORT" ? "border-bear/30 bg-bear/10 text-bear" : "border-white/10 bg-white/[0.05] text-ink-muted")}>
                    {t(signalLabelKey(rec.signal, "spot"))}
                  </span>
                  <span className="font-mono text-lg font-bold tnum" style={{ color: rec.confidence >= 70 ? "#00E676" : rec.confidence >= 55 ? "#FFD166" : "#8A94B0" }}>{rec.confidence}%</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Cell label={t("ms.entry")} v={formatUsd(rec.entry)} />
                  <Cell label={t("ms.stop")} v={formatUsd(rec.stop)} tone="bear" />
                  <Cell label="TP1" v={formatUsd(rec.targets[0])} tone="bull" />
                  <Cell label="TP2" v={formatUsd(rec.targets[1])} tone="bull" />
                  <Cell label="TP3" v={formatUsd(rec.targets[2])} tone="bull" />
                  <Cell label="R:R" v={`${rec.riskReward.toFixed(2)}:1`} />
                </div>
                <div className="mt-2 flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs">
                  <span className="flex items-center gap-1.5 text-ink-muted"><Gauge className="h-3.5 w-3.5" /> {t("ms.risk")}</span>
                  <span className={cn("font-semibold", rec.riskLevel === "Low" ? "text-bull" : rec.riskLevel === "Medium" ? "text-gold" : "text-bear")}>{t(`risk.${rec.riskLevel}`)}</span>
                </div>
              </>
            ) : null}
          </div>

          {/* key levels */}
          <div className="glass glow-border rounded-2xl p-5">
            <div className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-cyan" /> {t("coin.levels")}</div>
            <Level label={t("coin.resistance")} value={resistance} dist={dist(resistance)} tone="bear" />
            <div className="my-2 h-px bg-white/[0.06]" />
            <Level label={t("coin.support")} value={support} dist={dist(support)} tone="bull" />
          </div>

          {/* snapshot */}
          <div className="glass glow-border rounded-2xl p-5">
            <div className="mb-3 text-sm font-semibold">{t("coin.snapshot")}</div>
            <Stat label={t("ov.marketCap")} v={coin.marketCap ? `$${formatCompact(coin.marketCap)}` : "—"} />
            <Stat label={t("ov.volume24h")} v={coin.volume24h ? `$${formatCompact(coin.volume24h)}` : "—"} />
            <Stat label={t("coin.liquidity")} v={coin.marketCap ? `${((coin.volume24h / coin.marketCap) * 100).toFixed(1)}%` : "—"} />
          </div>
        </div>
      </div>

      {/* AI deep read */}
      <div className="glass glow-border rounded-2xl p-5">
        <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-violet"><Brain className="h-4 w-4" /> {t("rec.deep")}</div>
        {ai.loading ? (
          <span className="flex items-center gap-2 text-xs text-ink-faint"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("da.analyzing")}</span>
        ) : (
          <>
            <p className="whitespace-pre-line text-sm leading-relaxed text-ink-muted">{ai.text}</p>
            <span className={cn("mt-3 inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold", ai.provider === "ai" ? "border-bull/30 bg-bull/10 text-bull" : "border-white/10 bg-white/[0.04] text-ink-muted")}>
              {ai.provider === "ai" ? t("ai.viaAI") : t("ai.viaLocal")}
            </span>
          </>
        )}
      </div>
      <p className="text-center text-[11px] text-ink-faint">{t("ms.disclaimer")}</p>
    </div>
  );
}

function Metric({ label, value, tone, bar }: { label: string; value: string; tone: "bull" | "bear" | "ink"; bar?: number }) {
  const color = tone === "bull" ? "#00E676" : tone === "bear" ? "#FF4D6D" : "#E8ECF6";
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div dir="ltr" className="mt-0.5 text-start font-mono text-sm font-bold tnum" style={{ color }}>{value}</div>
      {bar != null && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, bar))}%`, background: color }} /></div>
      )}
    </div>
  );
}

function Cell({ label, v, tone }: { label: string; v: string; tone?: "bull" | "bear" }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div dir="ltr" className={cn("mt-0.5 text-start font-mono text-xs font-semibold tnum", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-ink")}>{v}</div>
    </div>
  );
}

function Level({ label, value, dist, tone }: { label: string; value: number; dist: number; tone: "bull" | "bear" }) {
  return (
    <div className="flex items-center justify-between">
      <span className={cn("text-xs font-semibold", tone === "bull" ? "text-bull" : "text-bear")}>{label}</span>
      <div dir="ltr" className="text-end">
        <div className="font-mono text-sm font-bold tnum text-ink">{formatUsd(value)}</div>
        <div className="font-mono text-[10px] tnum text-ink-faint">{dist >= 0 ? "+" : ""}{dist.toFixed(1)}%</div>
      </div>
    </div>
  );
}

function Stat({ label, v }: { label: string; v: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-xs">
      <span className="text-ink-muted">{label}</span>
      <span dir="ltr" className="font-mono font-semibold tnum text-ink">{v}</span>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => <div key={i} className="h-8 animate-pulse rounded-lg bg-white/[0.04]" />)}
    </div>
  );
}
