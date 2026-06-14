"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  Star,
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
  ShieldCheck,
  Gauge,
  Target,
  Layers,
  HelpCircle,
  Radar,
  Search,
} from "lucide-react";
import { useMarkets } from "@/lib/hooks";
import { scanCoin } from "@/lib/scan-engine";
import { trackSignal } from "@/lib/tracker";
import { useI18n } from "@/lib/i18n";
import { signalLabelKey, qualityScore } from "@/lib/signal-engine";
import type { Recommendation, Style, Direction, Market } from "@/lib/signal-engine";
import type { Coin } from "@/lib/mock-data";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

const STYLES: { id: Style; sub: string }[] = [
  { id: "scalp", sub: "fast" },
  { id: "day", sub: "1h · 4h" },
  { id: "swing", sub: "swing" },
];

const DIR: Record<Direction, { cls: string; icon: React.ElementType }> = {
  LONG: { cls: "text-bull bg-bull/10 border-bull/30", icon: ArrowUpRight },
  SHORT: { cls: "text-bear bg-bear/10 border-bear/30", icon: ArrowDownRight },
  NEUTRAL: { cls: "text-ink-muted bg-white/[0.05] border-white/10", icon: Minus },
};

type Scanned = { coin: Coin; rec: Recommendation };

export function ManualSignals() {
  const { t } = useI18n();
  const { coins } = useMarkets();
  const [market, setMarket] = useState<Market>("spot");
  const [style, setStyle] = useState<Style>("day");
  const [dirFilter, setDirFilter] = useState<"ALL" | Direction>("ALL");
  const [minConf, setMinConf] = useState(0);
  const [dexOnly, setDexOnly] = useState(false);
  const [q, setQ] = useState("");
  const [autoTrack, setAutoTrack] = useState(true);
  const [favorites, setFavorites] = useState<Set<string>>(new Set(["BTC", "SOL"]));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [limit, setLimit] = useState(50);

  // Scan every coin from the already-loaded market data (instant, no requests).
  const scanned: Scanned[] = useMemo(
    () => coins.map((coin) => ({ coin, rec: scanCoin(coin, style, market) })),
    [coins, style, market]
  );

  const stats = useMemo(() => {
    const longs = scanned.filter((s) => s.rec.signal === "LONG").length;
    const shorts = scanned.filter((s) => s.rec.signal === "SHORT").length;
    const actionable = scanned.filter((s) => s.rec.signal !== "NEUTRAL");
    const avgConf = actionable.length ? Math.round(actionable.reduce((a, s) => a + s.rec.confidence, 0) / actionable.length) : 0;
    return { longs, shorts, neutrals: scanned.length - longs - shorts, avgConf };
  }, [scanned]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return scanned.filter(({ coin, rec }) => {
      if (dexOnly && !coin.dex) return false;
      if (dirFilter !== "ALL" && rec.signal !== dirFilter) return false;
      if (rec.confidence < minConf) return false;
      if (query && !coin.symbol.toLowerCase().includes(query) && !coin.name.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [scanned, q, dirFilter, minConf, dexOnly]);

  // Rank by setup quality, lightly tilted toward liquid (higher-cap) coins so
  // obscure microcaps don't dominate the "best" / auto-tracked picks.
  const liqBonus = (rank?: number) => (!rank ? 0 : rank <= 30 ? 40 : rank <= 100 ? 25 : rank <= 200 ? 10 : 0);
  const score = (s: Scanned) => qualityScore(s.rec) + liqBonus(s.coin.rank);
  const sorted = useMemo(() => [...filtered].sort((a, b) => score(b) - score(a)), [filtered]);
  const bestSymbol = sorted.find((s) => s.rec.signal !== "NEUTRAL")?.coin.symbol;

  // Auto-track only the top few actionable setups (so the tracker doesn't flood).
  const topSig = sorted.filter((s) => s.rec.signal !== "NEUTRAL").slice(0, 6);
  const sig = topSig.map((s) => `${s.coin.symbol}${s.rec.signal}${s.rec.market}${s.rec.style}`).join("|");
  useEffect(() => {
    if (!autoTrack) return;
    topSig.forEach((s) => trackSignal(s.rec));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTrack, sig]);

  const toggleFav = (s: string) =>
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-cyan" />
            <h1 className="font-display text-2xl font-bold tracking-tight">{t("ms.title")}</h1>
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-xs font-semibold text-ink-muted tnum">
              {coins.length} {t("ex.coins")}
            </span>
          </div>
          <p className="mt-1 text-sm text-ink-muted">{t("ms.scanNote")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
            {(["spot", "futures"] as Market[]).map((m) => (
              <button key={m} onClick={() => setMarket(m)} className={cn("rounded-lg px-3.5 py-2.5 text-xs font-bold transition-all duration-200", market === m ? "bg-cyan-violet text-base-950" : "text-ink-muted hover:text-ink")}>
                {t(`market.${m}`)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
            {STYLES.map((s) => (
              <button key={s.id} onClick={() => setStyle(s.id)} className={cn("rounded-lg px-3.5 py-2.5 text-xs font-bold transition-all duration-200", style === s.id ? "bg-cyan-violet text-base-950" : "text-ink-muted hover:text-ink")}>
                {t(`ms.${s.id}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* legend */}
      <div className="glass rounded-2xl">
        <button onClick={() => setShowHelp((v) => !v)} className="flex w-full items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-ink-muted transition-colors hover:text-ink">
          <span className="flex items-center gap-2"><HelpCircle className="h-4 w-4 text-cyan" /> {t("legend.title")}</span>
          <ChevronDown className={cn("h-4 w-4 transition-transform", showHelp && "rotate-180")} />
        </button>
        {showHelp && (
          <ul className="space-y-1.5 border-t border-white/[0.06] px-4 py-3 text-xs leading-relaxed text-ink-muted">
            {["legend.buy", "legend.sell", "legend.wait", "legend.confidence", "legend.entry", "legend.rr", "legend.health"].map((k) => (
              <li key={k} className="flex items-start gap-2"><span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-cyan" /> {t(k)}</li>
            ))}
          </ul>
        )}
      </div>

      {/* tracker link */}
      <Link href="/dashboard/tracker" className="glass glow-border flex items-center justify-between gap-2 rounded-2xl px-4 py-3 text-sm transition-colors hover:border-cyan/30">
        <span className="flex items-center gap-2 font-medium text-ink"><Radar className="h-4 w-4 text-cyan" /> {t("tr.title")}</span>
        <span className="flex items-center gap-1 text-xs font-semibold text-cyan">{t("ex.viewAll")} <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" /></span>
      </Link>

      {/* stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t(market === "spot" ? "ms.buySetups" : "ms.longSetups")} value={stats.longs} tone="bull" />
        <StatCard label={t(market === "spot" ? "ms.sellSetups" : "ms.shortSetups")} value={stats.shorts} tone="bear" />
        <StatCard label={t("ms.neutralSetups")} value={stats.neutrals} tone="muted" />
        <StatCard label={t("ms.avgConfidence")} value={stats.avgConf} tone="cyan" suffix="%" />
      </div>

      {/* filters */}
      <div className="glass glow-border flex flex-wrap items-center gap-3 rounded-2xl p-3">
        <div className="flex min-w-48 flex-1 items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-ink-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("ex.search")} className="w-full bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none" />
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5">
          {(["ALL", "LONG", "SHORT", "NEUTRAL"] as const).map((d) => (
            <button key={d} onClick={() => setDirFilter(d)} className={cn("rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors", dirFilter === d ? "bg-white/10 text-ink" : "text-ink-muted hover:text-ink")}>
              {d === "ALL" ? t("ms.all") : t(signalLabelKey(d as Direction, market))}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5">
          {[0, 60, 70, 80].map((c) => (
            <button key={c} onClick={() => setMinConf(c)} className={cn("rounded-md px-2.5 py-1 text-[11px] font-semibold tnum transition-colors", minConf === c ? "bg-white/10 text-ink" : "text-ink-muted hover:text-ink")}>
              {c === 0 ? t("ms.anyConf") : `≥${c}%`}
            </button>
          ))}
        </div>
        <button onClick={() => setDexOnly((v) => !v)} className={cn("rounded-lg border px-2.5 py-1.5 text-[11px] font-bold transition-colors", dexOnly ? "border-violet/50 bg-violet/15 text-violet" : "border-white/[0.08] bg-white/[0.02] text-ink-muted hover:text-ink")}>
          {t("ms.dexOnly")}
        </button>
        <button onClick={() => setAutoTrack((v) => !v)} className={cn("flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors", autoTrack ? "border-cyan/40 bg-cyan/10 text-cyan" : "border-white/[0.08] bg-white/[0.02] text-ink-muted hover:text-ink")}>
          <span className={cn("h-1.5 w-1.5 rounded-full", autoTrack ? "bg-cyan animate-pulse-glow" : "bg-ink-faint")} /> {t("ms.autoTrack")}
        </button>
      </div>

      {/* table */}
      <div className="glass glow-border overflow-hidden rounded-2xl">
        <div className="hidden grid-cols-12 gap-2 border-b border-white/[0.06] px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-ink-faint lg:grid">
          <div className="col-span-3">{t("ms.pair")}</div>
          <div className="col-span-2">{t("ms.signal")}</div>
          <div className="col-span-2">{t("ms.confidence")}</div>
          <div className="col-span-2 text-end">{t("ms.entry")}</div>
          <div className="col-span-1 text-end">TP1</div>
          <div className="col-span-1 text-end">R:R</div>
          <div className="col-span-1 text-end">{t("ms.risk")}</div>
        </div>

        <div className="divide-y divide-white/[0.05]">
          {sorted.slice(0, limit).map((s, i) => (
            <Row
              key={s.coin.symbol}
              rank={i + 1}
              best={s.coin.symbol === bestSymbol}
              coin={s.coin}
              rec={s.rec}
              fav={favorites.has(s.coin.symbol)}
              onFav={() => toggleFav(s.coin.symbol)}
              open={expanded === s.coin.symbol}
              onToggle={() => setExpanded(expanded === s.coin.symbol ? null : s.coin.symbol)}
              market={market}
              t={t}
            />
          ))}
          {sorted.length === 0 && <div className="px-4 py-10 text-center text-sm text-ink-muted">{t("ms.noMatch")}</div>}
        </div>
      </div>

      {sorted.length > limit && (
        <div className="flex flex-col items-center gap-2">
          <button onClick={() => setLimit((l) => l + 50)} className="rounded-full border border-white/15 bg-white/[0.04] px-6 py-2.5 text-sm font-semibold text-ink transition-colors hover:border-cyan/40 hover:text-cyan">
            {t("ex.loadMore")}
          </button>
          <span className="text-[11px] text-ink-faint tnum">{t("ex.showing")} {Math.min(limit, sorted.length)} / {sorted.length}</span>
        </div>
      )}
      <p className="text-center text-[11px] text-ink-faint">{t("ms.disclaimer")}</p>
    </div>
  );
}

function StatCard({ label, value, tone, suffix = "" }: { label: string; value: number; tone: "bull" | "bear" | "cyan" | "muted"; suffix?: string }) {
  const color = { bull: "#00E676", bear: "#FF4D6D", cyan: "#00D4FF", muted: "#8A94B0" }[tone];
  return (
    <div className="glass rounded-2xl p-4">
      <div className="font-display text-3xl font-bold tnum" style={{ color }}>{value}{suffix}</div>
      <div className="mt-0.5 text-xs text-ink-muted">{label}</div>
    </div>
  );
}

function Row({
  coin, rec, fav, onFav, open, onToggle, market, rank, best, t,
}: {
  coin: Coin; rec: Recommendation; fav: boolean; onFav: () => void; open: boolean; onToggle: () => void; market: Market; rank: number; best: boolean; t: (k: string) => string;
}) {
  const d = DIR[rec.signal];
  const DIcon = d.icon;
  const confColor = rec.confidence >= 70 ? "#00E676" : rec.confidence >= 55 ? "#FFD166" : "#8A94B0";

  return (
    <div className={cn("transition-colors", open && "bg-white/[0.02]", best && "bg-bull/[0.03]")}>
      <button onClick={onToggle} className="grid w-full grid-cols-2 items-center gap-2 px-4 py-3.5 text-start lg:grid-cols-12">
        <div className="col-span-1 flex items-center gap-2 lg:col-span-3">
          <span className="hidden w-4 shrink-0 text-center font-mono text-[11px] text-ink-faint tnum sm:block">{rank}</span>
          <span onClick={(e) => { e.stopPropagation(); onFav(); }} className={cn("cursor-pointer", fav ? "text-gold" : "text-ink-faint hover:text-ink-muted")}>
            <Star className="h-3.5 w-3.5" fill={fav ? "currentColor" : "none"} />
          </span>
          <CoinIcon symbol={coin.symbol} image={coin.image} size={26} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold">{coin.symbol}</span>
              {coin.dex && <span className="rounded bg-violet/15 px-1 py-0.5 text-[8px] font-bold uppercase text-violet">DEX</span>}
            </div>
            <div className="hidden truncate text-[11px] text-ink-faint sm:block">{coin.name}</div>
          </div>
        </div>
        <div className="col-span-1 flex items-center gap-1.5 lg:col-span-2">
          <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-bold uppercase tracking-wider", d.cls)}>
            <DIcon className="h-3 w-3" /> {t(signalLabelKey(rec.signal, market))}
          </span>
          {best && <span className="hidden items-center gap-0.5 rounded-full bg-gold/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-gold sm:inline-flex">★ {t("tr.best")}</span>}
        </div>
        <div className="col-span-2 hidden items-center gap-2 lg:flex">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full rounded-full" style={{ width: `${rec.confidence}%`, background: confColor }} /></div>
          <span className="w-8 font-mono text-xs font-semibold tnum" style={{ color: confColor }}>{rec.confidence}</span>
        </div>
        <div dir="ltr" className="col-span-2 hidden text-end font-mono text-xs tnum lg:block">{formatUsd(rec.entry)}</div>
        <div dir="ltr" className="col-span-1 hidden text-end font-mono text-xs text-bull/80 tnum lg:block">{formatUsd(rec.targets[0])}</div>
        <div dir="ltr" className="col-span-1 hidden text-end font-mono text-xs tnum lg:block">{rec.riskReward.toFixed(2)}</div>
        <div className="col-span-1 hidden items-center justify-end gap-1 lg:flex">
          <span className={cn("text-[11px] font-semibold", rec.riskLevel === "Low" ? "text-bull" : rec.riskLevel === "Medium" ? "text-gold" : "text-bear")}>{t(`risk.${rec.riskLevel}`)}</span>
          <ChevronDown className={cn("h-3.5 w-3.5 text-ink-faint transition-transform", open && "rotate-180")} />
        </div>
      </button>

      {open && (
        <div className="grid gap-4 px-4 pb-4 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink-muted"><ShieldCheck className="h-3.5 w-3.5 text-cyan" /> {t("ms.whySignal")}</div>
            <ul className="space-y-1.5">
              {rec.reasons.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-ink-muted"><span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-cyan" /> {r}</li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
              <Chip label={`RSI ${rec.indicators.rsi.toFixed(0)}`} />
              <Chip label={`MACD ${rec.indicators.macdHist >= 0 ? "+" : ""}${rec.indicators.macdHist.toFixed(2)}`} />
              <Chip label={`ATR ${rec.indicators.atrPct.toFixed(2)}%`} />
              <Chip label={`%B ${rec.indicators.bbPctB.toFixed(2)}`} />
            </div>
          </div>
          <div className="lg:col-span-5">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink-muted"><Target className="h-3.5 w-3.5 text-violet" /> {t("ms.tradePlan")}</div>
            <div className="grid grid-cols-3 gap-2">
              <Plan label={t("ms.entry")} value={formatUsd(rec.entry)} />
              <Plan label={t("ms.stop")} value={formatUsd(rec.stop)} tone="bear" />
              {market === "futures" && <Plan label={t("ms.leverage")} value={rec.leverage} />}
              {rec.targets.map((tp, i) => <Plan key={i} label={`TP${i + 1}`} value={formatUsd(tp)} tone="bull" />)}
            </div>
            <div className="mt-2 flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs">
              <span className="flex items-center gap-1.5 text-ink-muted"><Gauge className="h-3.5 w-3.5" /> {t("ms.riskReward")}</span>
              <span dir="ltr" className="font-mono font-semibold text-ink tnum">{rec.riskReward.toFixed(2)} : 1</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const Chip = ({ label }: { label: string }) => (
  <span dir="ltr" className="rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-ink-muted">{label}</span>
);

const Plan = ({ label, value, tone }: { label: string; value: string; tone?: "bull" | "bear" }) => (
  <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
    <div className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</div>
    <div dir="ltr" className={cn("mt-0.5 text-start font-mono text-xs font-semibold tnum", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-ink")}>{value}</div>
  </div>
);
