"use client";

import { useEffect, useMemo, useState } from "react";
import { Radar, Trash2, Clock, Wallet, Check, X, Activity, TrendingUp, Layers, Sparkles, ArrowUpRight, ChevronDown, Eye } from "lucide-react";
import { Sparkline } from "@/components/ui/Sparkline";
import {
  useTracker, untrack, clearTracked, evaluate, assessHealth, pnlUsd, units, peakPnlPct, updatePeaks,
  setPositionAmount, trackSignal, trackId, type Health, type TrackedSignal,
} from "@/lib/tracker";
import { signalLabelKey, qualityScore } from "@/lib/signal-engine";
import type { Recommendation } from "@/lib/signal-engine";
import { scanCoin } from "@/lib/scan-engine";
import { liqBonus } from "@/lib/coin-meta";
import type { Coin } from "@/lib/mock-data";
import { useMarkets } from "@/lib/hooks";
import { useI18n, timeAgo } from "@/lib/i18n";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { formatUsd, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

const HEALTH_CLS: Record<Health, string> = {
  hold: "text-bull bg-bull/10 border-bull/30",
  watch: "text-gold bg-gold/10 border-gold/30",
  takeProfit: "text-cyan bg-cyan/10 border-cyan/30",
  exit: "text-bear bg-bear/10 border-bear/30",
};
const PRESETS = [100, 500, 1000, 5000];
const fmtUnits = (u: number) =>
  u >= 1 ? u.toLocaleString("en-US", { maximumFractionDigits: 2 }) : u.toLocaleString("en-US", { maximumSignificantDigits: 4 });

export function SignalTracker() {
  const tracked = useTracker();
  const { coins } = useMarkets();
  const { t, lang } = useI18n();
  const imageOf = (sym: string) => coins.find((c) => c.symbol === sym)?.image;

  const [, force] = useState(0);
  useEffect(() => {
    const tick = () => {
      const prices: Record<string, number> = {};
      coins.forEach((c) => (prices[c.symbol] = c.price));
      updatePeaks(prices);
      force((n) => n + 1);
    };
    const id = setInterval(tick, 12_000);
    return () => clearInterval(id);
  }, [coins]);

  const priceOf = (sym: string) => coins.find((c) => c.symbol === sym)?.price ?? 0;
  const positions = tracked.filter((s) => s.amount);
  const watching = tracked.filter((s) => !s.amount);

  const invested = positions.reduce((a, s) => a + (s.amount ?? 0), 0);
  const totalPnl = positions.reduce((a, s) => a + pnlUsd(s, priceOf(s.symbol) || s.entry), 0);
  const value = invested + totalPnl;
  const roi = invested > 0 ? (totalPnl / invested) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radar className="h-5 w-5 text-cyan" />
          <h2 className="font-display text-xl font-bold tracking-tight">{t("tr.title")}</h2>
          <span className="rounded-full border border-bull/30 bg-bull/10 px-2 py-0.5 text-[11px] font-bold text-bull">SPOT</span>
        </div>
        {tracked.length > 0 && (
          <button onClick={clearTracked} className="flex items-center gap-1.5 text-[11px] font-medium text-ink-faint transition-colors hover:text-bear">
            <Trash2 className="h-3.5 w-3.5" /> {t("tr.clear")}
          </button>
        )}
      </div>

      {/* summary KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={Wallet} label={t("tr.invested")} value={formatUsd(invested)} color="#00D4FF" />
        <Kpi icon={Layers} label={t("tr.value")} value={formatUsd(value)} color="#7C4DFF" />
        <Kpi icon={TrendingUp} label={t("tr.pnlUsd")} value={`${totalPnl >= 0 ? "+" : "-"}${formatUsd(Math.abs(totalPnl))}`} sub={formatPercent(roi)} color={totalPnl >= 0 ? "#00E676" : "#FF4D6D"} ltr />
        <Kpi icon={Activity} label={t("tr.openPositions")} value={String(positions.length)} color="#FFD166" />
      </div>

      {/* best recommendations right now */}
      <BestNow coins={coins} imageOf={imageOf} t={t} />

      {/* open positions */}
      <div className="glass glow-border rounded-2xl p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Wallet className="h-4 w-4 text-cyan" /> {t("tr.openPositions")}
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-ink-muted tnum">{positions.length}</span>
        </div>
        {positions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/[0.1] px-4 py-8 text-center text-sm text-ink-faint">{t("tr.noOpen")}</div>
        ) : (
          <div className="space-y-3">
            {positions.map((s) => (
              <OpenCard key={s.id} s={s} price={priceOf(s.symbol) || s.entry} image={imageOf(s.symbol)} t={t} />
            ))}
          </div>
        )}
      </div>

      {/* watchlist */}
      <div className="glass glow-border rounded-2xl p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Radar className="h-4 w-4 text-violet" /> {t("tr.watching")}
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-ink-muted tnum">{watching.length}</span>
        </div>
        {watching.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/[0.1] px-4 py-6 text-center text-sm text-ink-faint">{t("tr.noWatch")}</div>
        ) : (
          <div className="max-h-[360px] space-y-1.5 overflow-y-auto pe-1">
            {watching.map((s) => (
              <WatchRow key={s.id} s={s} price={priceOf(s.symbol) || s.entry} image={imageOf(s.symbol)} t={t} lang={lang} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BestNow({ coins, imageOf, t }: { coins: Coin[]; imageOf: (s: string) => string | undefined; t: (k: string) => string }) {
  const best = useMemo(
    () =>
      coins
        .map((coin) => ({ coin, rec: scanCoin(coin, "day", "spot") }))
        // Buy setups + uptrend coins worth watching for an entry.
        .filter((s) => s.rec.signal === "LONG" || s.rec.trend === "up")
        .map((s) => ({ ...s, score: qualityScore(s.rec) + liqBonus(s.coin.rank) + (s.rec.signal === "LONG" ? 500 : 0) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 50),
    [coins]
  );

  return (
    <div className="glass glow-border rounded-2xl p-5">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-gold" />
        <h2 className="text-sm font-semibold">{t("tr.bestNow")}</h2>
        {best.length > 0 && <span className="rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-[11px] font-bold text-gold tnum">{best.length}</span>}
      </div>
      <p className="mt-1 text-xs text-ink-muted">{t("tr.bestNowSub")}</p>

      {best.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-white/[0.1] px-4 py-6 text-center text-sm text-ink-faint">{t("tr.noBest")}</div>
      ) : (
        <div className="mt-3 max-h-[680px] space-y-2 overflow-y-auto pe-1">
          {best.map(({ coin, rec }, i) => (
            <RecCard key={coin.symbol} rank={i + 1} coin={coin} rec={rec} image={imageOf(coin.symbol)} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function RecCard({ rank, coin, rec, image, t }: { rank: number; coin: Coin; rec: Recommendation; image?: string; t: (k: string) => string }) {
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState("1000");
  const amount = parseFloat(amt) || 0;
  const id = trackId(rec);
  const confColor = rec.confidence >= 70 ? "#00E676" : rec.confidence >= 55 ? "#FFD166" : "#8A94B0";
  const trendColor = rec.trend === "up" ? "#00E676" : rec.trend === "down" ? "#FF4D6D" : "#8A94B0";
  const movePct = (x: number) => ((x - rec.entry) / rec.entry) * 100;
  const moneyAt = (x: number) => (amount * movePct(x)) / 100;
  const enter = () => { if (amount > 0) { trackSignal(rec); setPositionAmount(id, amount); } };

  return (
    <div className="overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.02]">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2.5 px-3 pt-3 text-start">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-gold/15 font-mono text-[11px] font-bold text-gold tnum">{rank}</span>
        <CoinIcon symbol={coin.symbol} image={image} size={28} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-bold">{coin.symbol}</span>
            {coin.dex && <span className="rounded bg-violet/15 px-1 py-0.5 text-[8px] font-bold uppercase text-violet">DEX</span>}
          </div>
          <div className="hidden truncate text-[10px] text-ink-faint sm:block">{coin.name}</div>
        </div>
        {rec.signal === "LONG" ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-bull/30 bg-bull/10 px-2 py-0.5 text-[11px] font-bold text-bull">
            <ArrowUpRight className="h-3 w-3" /> {t("dir.BUY")}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-[11px] font-bold text-gold">
            <Eye className="h-3 w-3" /> {t("dir.WAIT")}
          </span>
        )}
        <div className="ms-auto flex items-center gap-3">
          <div className="hidden text-end sm:block">
            <div className="text-[9px] uppercase tracking-wider text-ink-faint">{t("ms.confidence")}</div>
            <div className="font-mono text-sm font-bold tnum" style={{ color: confColor }}>{rec.confidence}%</div>
          </div>
          <ChevronDown className={cn("h-4 w-4 text-ink-faint transition-transform", open && "rotate-180")} />
        </div>
      </button>

      {/* always-visible quick decision row */}
      <div className="mt-2.5 grid grid-cols-4 gap-px border-t border-white/[0.06] text-center">
        <Quick label={t("ms.entry")} value={formatUsd(rec.entry)} />
        <Quick label={t("ms.stop")} value={formatUsd(rec.stop)} pct={movePct(rec.stop)} tone="bear" />
        <Quick label="TP1" value={formatUsd(rec.targets[0])} pct={movePct(rec.targets[0])} tone="bull" />
        <Quick label="R:R" value={`${rec.riskReward.toFixed(2)}:1`} />
      </div>

      {open && (
        <div className="space-y-3 border-t border-white/[0.06] p-3">
          {/* 7-day chart */}
          <div className="rounded-xl bg-white/[0.03] p-2">
            <Sparkline data={coin.spark} width={300} height={44} color={trendColor} strokeWidth={1.8} />
          </div>

          {/* context chips */}
          <div className="flex flex-wrap gap-1.5 text-[10px]">
            <span className="rounded-md px-1.5 py-0.5 font-semibold" style={{ background: `${trendColor}1f`, color: trendColor }}>{t("tr.trend")}: {t(`trend.${rec.trend}`)}</span>
            <span className={cn("rounded-md px-1.5 py-0.5 font-semibold", rec.riskLevel === "Low" ? "bg-bull/12 text-bull" : rec.riskLevel === "Medium" ? "bg-gold/12 text-gold" : "bg-bear/12 text-bear")}>{t("ms.risk")}: {t(`risk.${rec.riskLevel}`)}</span>
            <span dir="ltr" className="rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-ink-muted">RSI {rec.indicators.rsi.toFixed(0)}</span>
            <span dir="ltr" className="rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-ink-muted">MACD {rec.indicators.macdHist >= 0 ? "+" : ""}{rec.indicators.macdHist.toFixed(2)}</span>
            <span dir="ltr" className="rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-ink-muted">ATR {rec.indicators.atrPct.toFixed(1)}%</span>
          </div>

          {/* why */}
          <div>
            <div className="mb-1.5 text-xs font-semibold text-ink-muted">{t("ms.whySignal")}</div>
            <ul className="space-y-1">
              {rec.reasons.slice(0, 4).map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-ink-muted"><span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-cyan" /> {r}</li>
              ))}
            </ul>
          </div>

          {/* projection */}
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-ink">{t("tr.projection")}</span>
              <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.03] px-2.5 py-1.5">
                <span className="text-xs text-ink-faint">$</span>
                <input type="number" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} className="w-20 bg-transparent text-sm text-ink focus:outline-none" dir="ltr" />
              </div>
              {PRESETS.map((p) => (
                <button key={p} onClick={() => setAmt(String(p))} className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1 font-mono text-[11px] text-ink-muted transition-colors hover:text-ink tnum">${p}</button>
              ))}
            </div>
            <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Proj label={t("tr.atStop")} money={moneyAt(rec.stop)} pct={movePct(rec.stop)} tone="bear" />
              <Proj label="TP1" money={moneyAt(rec.targets[0])} pct={movePct(rec.targets[0])} tone="bull" />
              <Proj label="TP2" money={moneyAt(rec.targets[1])} pct={movePct(rec.targets[1])} tone="bull" />
              <Proj label="TP3" money={moneyAt(rec.targets[2])} pct={movePct(rec.targets[2])} tone="bull" />
            </div>
          </div>

          {/* actions */}
          <div className="flex items-center gap-2">
            <button onClick={() => trackSignal(rec)} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] font-semibold text-ink-muted transition-colors hover:text-cyan">
              <Radar className="h-3.5 w-3.5" /> {t("tr.watchAdd")}
            </button>
            <button onClick={enter} className="ms-auto inline-flex items-center gap-1.5 rounded-lg bg-cyan-violet px-4 py-2 text-xs font-bold text-base-950 transition-transform hover:scale-[1.02]">
              <Wallet className="h-4 w-4" /> {t("tr.enter")} · <span dir="ltr" className="tnum">{formatUsd(amount)}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Quick({ label, value, pct, tone }: { label: string; value: string; pct?: number; tone?: "bull" | "bear" }) {
  return (
    <div className="bg-white/[0.01] px-2 py-2">
      <div className="text-[9px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div dir="ltr" className={cn("font-mono text-xs font-semibold tnum", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-ink")}>{value}</div>
      {pct !== undefined && <div dir="ltr" className={cn("font-mono text-[9px] tnum", pct >= 0 ? "text-bull/70" : "text-bear/70")}>{pct >= 0 ? "+" : ""}{pct.toFixed(1)}%</div>}
    </div>
  );
}

function Proj({ label, money, pct, tone }: { label: string; money: number; pct: number; tone: "bull" | "bear" }) {
  return (
    <div className={cn("rounded-lg border px-2.5 py-2", tone === "bull" ? "border-bull/20 bg-bull/[0.06]" : "border-bear/20 bg-bear/[0.06]")}>
      <div className="text-[10px] text-ink-muted">{label}</div>
      <div dir="ltr" className={cn("font-mono text-sm font-bold tnum", tone === "bull" ? "text-bull" : "text-bear")}>{money >= 0 ? "+" : "-"}{formatUsd(Math.abs(money))}</div>
      <div dir="ltr" className={cn("font-mono text-[10px] tnum", tone === "bull" ? "text-bull/70" : "text-bear/70")}>{pct >= 0 ? "+" : ""}{pct.toFixed(1)}%</div>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, sub, color, ltr }: { icon: React.ElementType; label: string; value: string; sub?: string; color: string; ltr?: boolean }) {
  return (
    <div className="glass rounded-2xl p-4">
      <span className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: `${color}1f`, color }}>
        <Icon className="h-4 w-4" strokeWidth={1.9} />
      </span>
      <div dir={ltr ? "ltr" : undefined} className="mt-3 font-display text-xl font-bold tracking-tight tnum" style={{ color: ltr ? color : undefined }}>
        {value}
        {sub && <span className="ms-1.5 text-xs font-semibold opacity-80">{sub}</span>}
      </div>
      <div className="mt-0.5 text-xs text-ink-muted">{label}</div>
    </div>
  );
}

function OpenCard({ s, price, image, t }: { s: TrackedSignal; price: number; image?: string; t: (k: string) => string }) {
  const long = s.direction === "LONG";
  const { pnlPct } = evaluate(s, price);
  const dollar = pnlUsd(s, price);
  const health = assessHealth(s, price);
  const u = units(s);
  const peakPct = peakPnlPct(s);
  const dd = Math.max(0, peakPct - pnlPct);
  const held = timeAgo(s.openedAt ?? s.startedAt, t);

  return (
    <div className="rounded-2xl border border-cyan/25 bg-white/[0.02] p-4">
      <div className="flex items-center gap-2.5">
        <CoinIcon symbol={s.symbol} image={image} size={32} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-bold">{s.symbol}</span>
            <span className={cn("text-[11px] font-bold", long ? "text-bull" : "text-bear")}>{t(signalLabelKey(s.direction, "spot"))}</span>
          </div>
          <div className="text-[10px] text-ink-faint">{t("tr.action")}</div>
        </div>
        <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-bold", HEALTH_CLS[health])}>
          <Activity className="h-3 w-3" /> {t(`health.${health}`)}
        </span>
        <div className="ms-auto text-end">
          <div dir="ltr" className={cn("font-mono text-base font-bold tnum", dollar >= 0 ? "text-bull" : "text-bear")}>
            {dollar >= 0 ? "+" : "-"}{formatUsd(Math.abs(dollar))}
          </div>
          <div dir="ltr" className={cn("font-mono text-[11px] tnum", pnlPct >= 0 ? "text-bull/80" : "text-bear/80")}>{formatPercent(pnlPct)}</div>
        </div>
        <button onClick={() => untrack(s.id)} className="ms-1 text-ink-faint transition-colors hover:text-bear">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* progress bar: stop → entry → now → targets */}
      <div className="mt-4">
        <ProgressBar entry={s.entry} stop={s.stop} targets={s.targets} current={price} long={long} profit={pnlPct >= 0} />
      </div>

      {/* metrics */}
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-white/[0.06] pt-3 sm:grid-cols-5">
        <Metric label={t("tr.invested")} value={formatUsd(s.amount!)} />
        <Metric label={t("tr.value")} value={formatUsd(s.amount! + dollar)} ltr />
        <Metric label={t("tr.units")} value={fmtUnits(u)} ltr />
        <Metric label={t("tr.peak")} value={`${peakPct >= 0 ? "+" : ""}${peakPct.toFixed(2)}%`} sub={dd > 0.3 ? `-${dd.toFixed(1)}% ${t("tr.fromPeak")}` : undefined} tone={dd > 0.3 ? "warn" : "bull"} ltr />
        <Metric label={t("tr.held")} value={held} icon />
      </div>
    </div>
  );
}

function ProgressBar({ entry, stop, targets, current, long, profit }: { entry: number; stop: number; targets: number[]; current: number; long: boolean; profit: boolean }) {
  const all = [entry, stop, current, ...targets];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const pct = (x: number) => Math.max(0, Math.min(100, ((x - lo) / span) * 100));
  const a = pct(entry);
  const b = pct(current);
  const left = Math.min(a, b);
  const width = Math.abs(b - a);

  return (
    <div dir="ltr">
      <div className="relative h-2 rounded-full bg-white/[0.07]">
        {/* filled entry → current */}
        <div className="absolute top-0 h-full rounded-full" style={{ left: `${left}%`, width: `${width}%`, background: profit ? "#00E676" : "#FF4D6D" }} />
        {/* target ticks */}
        {targets.map((tp, i) => (
          <span key={i} className="absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-bull/70" style={{ left: `${pct(tp)}%` }} title={`TP${i + 1}`} />
        ))}
        {/* stop tick */}
        <span className="absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-bear" style={{ left: `${pct(stop)}%` }} />
        {/* entry tick */}
        <span className="absolute top-1/2 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/70" style={{ left: `${pct(entry)}%` }} />
        {/* current dot */}
        <span className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-base-950" style={{ left: `${pct(current)}%`, background: profit ? "#00E676" : "#FF4D6D" }} />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-ink-faint tnum">
        <span className="text-bear/80">{formatUsd(stop)}</span>
        <span className="text-white/70">{formatUsd(entry)}</span>
        <span className="text-bull/80">{formatUsd(targets[targets.length - 1])}</span>
      </div>
    </div>
  );
}

function Metric({ label, value, sub, tone, icon, ltr }: { label: string; value: string; sub?: string; tone?: "bull" | "warn"; icon?: boolean; ltr?: boolean }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-ink-faint">
        {icon && <Clock className="h-3 w-3" />} {label}
      </div>
      <div dir={ltr ? "ltr" : undefined} className={cn("mt-0.5 font-mono text-xs font-semibold tnum", tone === "bull" ? "text-bull" : tone === "warn" ? "text-gold" : "text-ink")}>{value}</div>
      {sub && <div dir="ltr" className="text-[9px] text-gold">{sub}</div>}
    </div>
  );
}

function WatchRow({ s, price, image, t, lang }: { s: TrackedSignal; price: number; image?: string; t: (k: string) => string; lang: string }) {
  const [entering, setEntering] = useState(false);
  const [amt, setAmt] = useState("");
  const long = s.direction === "LONG";
  const { pnlPct } = evaluate(s, price);
  const started = new Date(s.startedAt).toLocaleTimeString(lang === "ar" ? "ar" : "en-US", { hour: "2-digit", minute: "2-digit" });

  const confirm = () => {
    const v = parseFloat(amt);
    if (v > 0) {
      setPositionAmount(s.id, v);
      setEntering(false);
      setAmt("");
    }
  };

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5">
      <div className="flex items-center gap-2.5">
        <CoinIcon symbol={s.symbol} image={image} size={24} />
        <span className="text-sm font-semibold">{s.symbol}</span>
        <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-bold", long ? "text-bull bg-bull/10 border-bull/30" : "text-bear bg-bear/10 border-bear/30")}>
          {t(signalLabelKey(s.direction, "spot"))}
        </span>
        <span className="hidden text-[11px] text-ink-faint sm:inline">{timeAgo(s.startedAt, t)} · {started}</span>
        <span dir="ltr" className={cn("ms-auto font-mono text-xs font-semibold tnum", pnlPct >= 0 ? "text-bull" : "text-bear")}>{formatPercent(pnlPct)}</span>
        {long &&
          (entering ? null : (
            <button onClick={() => setEntering(true)} className="inline-flex items-center gap-1 rounded-lg border border-cyan/40 bg-cyan/10 px-2.5 py-1.5 text-[11px] font-bold text-cyan transition-colors hover:bg-cyan/20">
              <Wallet className="h-3.5 w-3.5" /> {t("tr.enter")}
            </button>
          ))}
        <button onClick={() => untrack(s.id)} className="text-ink-faint transition-colors hover:text-bear">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {entering && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-2.5">
          <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.03] px-2.5 py-1.5">
            <span className="text-xs text-ink-faint">$</span>
            <input autoFocus type="number" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} onKeyDown={(e) => e.key === "Enter" && confirm()} placeholder={t("tr.amount")} className="w-24 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none" dir="ltr" />
          </div>
          {PRESETS.map((p) => (
            <button key={p} onClick={() => setAmt(String(p))} className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1 font-mono text-[11px] text-ink-muted transition-colors hover:text-ink tnum">${p}</button>
          ))}
          <button onClick={confirm} className="ms-auto inline-flex items-center gap-1 rounded-lg bg-cyan-violet px-3 py-1.5 text-[11px] font-bold text-base-950">
            <Check className="h-3.5 w-3.5" /> {t("tr.confirm")}
          </button>
          <button onClick={() => setEntering(false)} className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] font-semibold text-ink-muted hover:text-ink">
            <X className="h-3.5 w-3.5" /> {t("tr.cancel")}
          </button>
        </div>
      )}
    </div>
  );
}
