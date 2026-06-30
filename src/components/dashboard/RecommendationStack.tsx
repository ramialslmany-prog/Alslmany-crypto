"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Sparkles, ChevronRight, ChevronDown, Brain, Loader2, ShieldAlert, TrendingUp, Activity } from "lucide-react";
import { useMarkets, useBtcRegime } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { qualityScore, type Recommendation, type Style } from "@/lib/signal-engine";
import { scanCoin as scan } from "@/lib/scan-engine";
import { deepAnalyze } from "@/lib/deep-analyze";
import { isStable, liqBonus } from "@/lib/coin-meta";
import type { Coin } from "@/lib/mock-data";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { Sparkline } from "@/components/ui/Sparkline";
import { LivePrice } from "@/components/ui/LivePrice";
import { formatUsd, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A graded opportunity: BUY (high-conviction long), SETUP (long, lower conf),
 *  WATCH (constructive but unconfirmed — wait for the trigger). */
type OppType = "buy" | "setup" | "watch";
type Pick = { c: Coin; r: Recommendation; type: OppType };

const STYLES: Style[] = ["scalp", "day", "swing"];
const confColor = (v: number) => (v >= 70 ? "#00E676" : v >= 55 ? "#FFD166" : "#8A94B0");
const TYPE_META: Record<OppType, { key: string; cls: string; rank: number }> = {
  buy: { key: "dir.BUY", cls: "border-bull/30 bg-bull/10 text-bull", rank: 0 },
  setup: { key: "opp.setup", cls: "border-cyan/30 bg-cyan/10 text-cyan", rank: 1 },
  watch: { key: "opp.watch", cls: "border-gold/30 bg-gold/10 text-gold", rank: 2 },
};

/** AI Opportunity Radar: always surfaces the best available buy-side setups,
 *  graded by conviction, ranked & explained by the live AI. Never empty unless
 *  the whole market is in a confirmed downtrend. */
export function RecommendationStack() {
  const { coins } = useMarkets();
  const { t, lang } = useI18n();
  const [style, setStyle] = useState<Style>("day");
  const [verdict, setVerdict] = useState("");
  const [provider, setProvider] = useState<"ai" | "local" | "">("");
  const [openSym, setOpenSym] = useState<string | null>(null);
  const [analyses, setAnalyses] = useState<Record<string, { text: string; provider: "ai" | "local"; loading: boolean }>>({});
  const { bearish: regimeBearish } = useBtcRegime();
  const cautious = regimeBearish === true;
  const btcCh = coins.find((c) => c.symbol === "BTC")?.change24h ?? 0;

  const toggle = async (pick: Pick) => {
    const sym = pick.c.symbol;
    if (openSym === sym) return setOpenSym(null);
    setOpenSym(sym);
    if (!analyses[sym]) {
      setAnalyses((a) => ({ ...a, [sym]: { text: "", provider: "local", loading: true } }));
      const res = await deepAnalyze(pick.c, lang);
      setAnalyses((a) => ({ ...a, [sym]: { text: res.text, provider: res.provider, loading: false } }));
    }
  };

  // Stage 1 — broad, instant scan: liquid, non-stable, buy-side (not a downtrend,
  // not breaking down), ranked by setup quality + liquidity + relative strength
  // vs BTC. This keeps the radar populated even when momentum is thin.
  const candidates = useMemo(
    () =>
      coins
        .filter(
          (c) =>
            !isStable(c.symbol) &&
            (c.rank ?? 999) <= 100 && // liquid, recognizable names only
            (c.change24h ?? 0) <= 18 &&
            (c.change24h ?? 0) >= -12 &&
            // drop flat pegs that slip past the name list (e.g. GHO): a real
            // opportunity has actually moved; a peg sits dead-flat.
            !(Math.abs(c.change24h ?? 0) < 0.8 && Math.abs(c.change7d ?? 0) < 1.5)
        )
        .map((c) => ({ c, r: scan(c, style, "spot") }))
        .filter((x) => x.r.signal !== "SHORT" && x.r.trend !== "down")
        .map((x) => ({ ...x, score: qualityScore(x.r) + liqBonus(x.c.rank) + Math.max(0, (x.c.change24h ?? 0) - btcCh) * 2 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10),
    [coins, style, btcCh]
  );
  const candSig = candidates.map((c) => c.c.symbol).join(",") + style;

  // Stage 2 — rigorous multi-timeframe confirmation (same engine as the deep
  // analysis), then grade each into BUY / SETUP / WATCH. Drop anything the
  // engine reads as a short or a breakdown — those are not buy opportunities.
  const [picks, setPicks] = useState<Pick[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setOpenSym(null);
    (async () => {
      const confirmed: Pick[] = [];
      await Promise.all(
        candidates.map(async (cand) => {
          try {
            const rec = (await (await fetch(`/api/signals?symbol=${cand.c.symbol}&style=${style}&market=spot`)).json()) as Recommendation;
            if (rec.signal === "SHORT" || rec.trend === "down") return;
            const type: OppType = rec.signal === "LONG" && rec.confidence >= 60 ? "buy" : rec.signal === "LONG" ? "setup" : "watch";
            confirmed.push({ c: cand.c, r: rec, type });
          } catch {
            /* skip */
          }
        })
      );
      confirmed.sort((a, b) => TYPE_META[a.type].rank - TYPE_META[b.type].rank || b.r.confidence - a.r.confidence);
      if (!cancelled) {
        setPicks(confirmed.slice(0, 5));
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candSig]);

  const buyCount = picks.filter((p) => p.type === "buy").length;

  // LLM verdict — regime-aware ranking of the live opportunities.
  const sig = picks.map((p) => p.c.symbol + p.r.confidence + p.type).join(",");
  useEffect(() => {
    if (!picks.length) { setVerdict(""); setProvider(""); return; }
    const facts = picks.map((x, i) => `${i + 1}. ${x.c.symbol} [${x.type}] conf ${x.r.confidence}% trend ${x.r.trend} entry ${formatUsd(x.r.entry)} TP1 ${formatUsd(x.r.targets[0])} R:R ${x.r.riskReward.toFixed(2)}`).join("\n");
    setVerdict(
      lang === "ar"
        ? `${picks.length} فرص على الرادار، يتصدّرها ${picks[0].c.symbol}.`
        : `${picks.length} opportunities on the radar, led by ${picks[0].c.symbol}.`
    );
    setProvider("local");
    let cancelled = false;
    (async () => {
      try {
        const sys =
          lang === "ar"
            ? `أنت مستثمر كريبتو مخضرم. أمامك قائمة فرص مصنّفة (buy=شراء قوي، setup=إعداد، watch=مراقبة) في سوق ${cautious ? "حذر (بيتكوين ضعيف على الإطار الأعلى)" : "مؤاتٍ"}. رتّبها بصدق في جملتين أو ثلاث: ما أفضل فرصة الآن ولماذا، وأيّها الأعلى مخاطرة، وما شرط الدخول. ${cautious ? "وضّح أن الفرص في سوق حذر انتقائية وقصيرة المدى وتتطلّب وقفاً ضيّقاً وحجماً أصغر." : ""} لا تذكر سعراً محدّداً. بالعربية الفصحى فقط. ليست نصيحة مالية.`
            : `You are a veteran crypto investor. Here is a graded opportunity list (buy/setup/watch) in a ${cautious ? "cautious market (BTC weak on the higher timeframe)" : "favorable market"}. Rank them candidly in 2-3 sentences: the best opportunity now and why, the riskiest, and the entry condition. ${cautious ? "Make clear that in a cautious market these are selective, short-term, and need tight stops and smaller size." : ""} Don't state a specific price. Not financial advice.`;
        const res = await fetch("/api/ai", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "system", content: sys }, { role: "system", content: facts }, { role: "user", content: lang === "ar" ? "رتّب الفرص." : "Rank the opportunities." }] }),
        });
        const j = (await res.json()) as { text?: string | null };
        if (!cancelled && j?.text) { setVerdict(j.text); setProvider("ai"); }
      } catch {
        /* keep local */
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, lang]);

  return (
    <div className="glass glow-border rounded-2xl p-5">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet" />
          <h2 className="text-sm font-semibold">{t("ov.aiRecs")}</h2>
          <span className="rounded-full border border-bull/30 bg-bull/10 px-2 py-0.5 text-[10px] font-bold text-bull">{t("ai.viaAI")}</span>
        </div>
        <Link href="/dashboard/signals" className="flex items-center gap-1 text-xs font-medium text-ink-muted transition-colors hover:text-cyan">
          {t("ov.viewAll")} <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />
        </Link>
      </div>

      {/* horizon toggle */}
      <div className="mt-3 flex items-center gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
        {STYLES.map((s) => (
          <button key={s} onClick={() => setStyle(s)} className={cn("flex-1 rounded-lg px-3 py-1.5 text-xs font-bold transition-all", style === s ? "bg-cyan-violet text-base-950" : "text-ink-muted hover:text-ink")}>
            {t(`ms.${s}`)}
          </button>
        ))}
      </div>

      {/* regime banner — context, not a wall */}
      <div className={cn("mt-3 flex items-center gap-2 rounded-xl border px-3 py-2 text-[11px] font-medium", cautious ? "border-gold/25 bg-gold/[0.07] text-gold" : "border-bull/25 bg-bull/[0.07] text-bull")}>
        {cautious ? <ShieldAlert className="h-3.5 w-3.5 shrink-0" /> : <Activity className="h-3.5 w-3.5 shrink-0" />}
        <span className="text-ink-muted">
          {cautious
            ? (lang === "ar" ? "سوق حذر (بيتكوين ضعيف) — الفرص أدناه انتقائية وأعلى مخاطرة: وقف ضيّق وحجم أصغر." : "Cautious market (BTC weak) — the setups below are selective and higher-risk: tight stops, smaller size.")
            : (lang === "ar" ? "السوق مؤاتٍ للشراء — أفضل الفرص المؤكَّدة أدناه." : "Market favors buying — the best confirmed setups are below.")}
        </span>
      </div>

      {/* AI verdict */}
      <div className="mt-3 rounded-xl border border-violet/20 bg-violet/[0.06] p-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-wider text-violet">{t("rec.verdict")}</span>
          {provider && (
            <span className={cn("rounded-full border px-1.5 py-0.5 text-[9px] font-bold", provider === "ai" ? "border-bull/30 bg-bull/10 text-bull" : "border-white/10 bg-white/[0.04] text-ink-muted")}>
              {provider === "ai" ? t("ai.viaAI") : t("ai.viaLocal")}
            </span>
          )}
        </div>
        <p className="whitespace-pre-line text-xs leading-relaxed text-ink-muted">{verdict || (loading ? "…" : t("rec.noBuys"))}</p>
      </div>

      {/* opportunities */}
      <div className="mt-3 space-y-2.5">
        {loading && picks.length === 0 ? (
          [0, 1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-2xl bg-white/[0.03]" />)
        ) : picks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/[0.1] px-4 py-8 text-center text-sm text-ink-faint">{t("rec.noBuys")}</div>
        ) : (
          picks.map((pick, idx) => (
            <PickCard key={pick.c.symbol} pick={pick} rank={idx + 1} open={openSym === pick.c.symbol} onToggle={() => toggle(pick)} analysis={analyses[pick.c.symbol]} t={t} />
          ))
        )}
      </div>

      <p className="mt-3 text-center text-[10px] text-ink-faint">
        {buyCount === 0 && picks.length > 0 ? (lang === "ar" ? "لا توجد إشارة شراء عالية الثقة الآن — ما تراه فرص مراقبة. " : "No high-conviction buy right now — these are watch ideas. ") : ""}
        {t("ms.disclaimer")}
      </p>
    </div>
  );
}

function PickCard({
  pick, rank, open, onToggle, analysis, t,
}: {
  pick: Pick; rank: number; open: boolean; onToggle: () => void;
  analysis?: { text: string; provider: "ai" | "local"; loading: boolean }; t: (k: string) => string;
}) {
  const { c, r, type } = pick;
  const up = (c.change24h ?? 0) >= 0;
  const dist = (p: number) => ((p - r.entry) / r.entry) * 100;
  const meta = TYPE_META[type];
  const trendChip = r.trend === "up"
    ? { label: t("ms.up"), cls: "bg-bull/10 text-bull" }
    : { label: t("opp.range"), cls: "bg-gold/10 text-gold" };
  const chips = [
    `RSI ${r.indicators.rsi.toFixed(0)}`,
    r.indicators.macdHist >= 0 ? "MACD ↑" : "MACD ↓",
    r.indicators.volRatio >= 1.2 ? "VOL ✓" : null,
  ].filter(Boolean) as string[];

  return (
    <div className={cn("rounded-2xl border bg-white/[0.02] p-3 transition-colors", rank === 1 && type === "buy" ? "border-bull/25" : "border-white/[0.06]")}>
      {/* top row */}
      <div className="flex items-center gap-2.5">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-white/[0.06] text-[10px] font-bold text-ink-muted tnum">{rank}</span>
        <Link href={`/dashboard/coin/${c.symbol}`} className="flex min-w-0 flex-1 items-center gap-2.5 transition-opacity hover:opacity-80">
          <CoinIcon symbol={c.symbol} image={c.image} size={30} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-bold">{c.symbol}</span>
              {c.dex && <span className="rounded bg-violet/15 px-1 py-0.5 text-[8px] font-bold uppercase text-violet">DEX</span>}
            </div>
            <div className="truncate text-[10px] text-ink-faint">{c.name}</div>
          </div>
        </Link>
        {c.spark?.length > 1 && (
          <div className="hidden w-20 sm:block [&_svg]:h-auto [&_svg]:w-full">
            <Sparkline data={c.spark} width={80} height={26} color={up ? "#00E676" : "#FF4D6D"} strokeWidth={1.4} fill={false} />
          </div>
        )}
        <ConfidenceRing value={r.confidence} />
      </div>

      {/* price + type badge */}
      <div className="mt-2 flex items-center justify-between">
        <div dir="ltr" className="flex items-baseline gap-2">
          <LivePrice value={c.price} format={formatUsd} className="font-mono text-sm font-bold text-ink" />
          <span className={cn("font-mono text-[11px] font-semibold tnum", up ? "text-bull" : "text-bear")}>{formatPercent(c.change24h)}</span>
        </div>
        <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold", meta.cls)}>{t(meta.key)}</span>
      </div>

      {/* chips */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold", trendChip.cls)}><TrendingUp className={cn("h-2.5 w-2.5", r.trend !== "up" && "rotate-90")} /> {trendChip.label}</span>
        {chips.map((ch) => (
          <span key={ch} dir="ltr" className="rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">{ch}</span>
        ))}
      </div>

      {/* plan grid */}
      <div className="mt-2.5 grid grid-cols-4 gap-2">
        <Cell label={t("ms.entry")} v={formatUsd(r.entry)} />
        <Cell label={t("ms.stop")} v={`${dist(r.stop).toFixed(1)}%`} tone="bear" />
        <Cell label="R:R" v={`${r.riskReward.toFixed(2)}:1`} />
        <Cell label={t("ms.risk")} v={t(`risk.${r.riskLevel}`)} tone={r.riskLevel === "Low" ? "bull" : r.riskLevel === "High" ? "bear" : undefined} />
      </div>

      {/* targets */}
      <div className="mt-2 grid grid-cols-3 gap-2">
        {r.targets.map((tp, i) => (
          <div key={i} className="rounded-lg border border-bull/15 bg-bull/[0.04] px-2 py-1.5 text-center">
            <div className="text-[9px] uppercase tracking-wider text-ink-faint">TP{i + 1}</div>
            <div dir="ltr" className="mt-0.5 font-mono text-xs font-semibold tnum text-bull">{dist(tp) >= 0 ? "+" : ""}{dist(tp).toFixed(1)}%</div>
          </div>
        ))}
      </div>

      {/* deep AI analysis */}
      <button onClick={onToggle} className="mt-2.5 flex w-full items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-[11px] font-semibold text-ink-muted transition-colors hover:text-violet">
        <span className="flex items-center gap-1.5"><Brain className="h-3.5 w-3.5 text-violet" /> {t("rec.deep")}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-2 rounded-lg bg-white/[0.03] p-3">
          {analysis?.loading || !analysis ? (
            <span className="flex items-center gap-2 text-xs text-ink-faint"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("da.analyzing")}</span>
          ) : (
            <>
              <p className="whitespace-pre-line text-xs leading-relaxed text-ink-muted">{analysis.text}</p>
              <div className="mt-2 flex items-center justify-between">
                <span className={cn("inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold", analysis.provider === "ai" ? "border-bull/30 bg-bull/10 text-bull" : "border-white/10 bg-white/[0.04] text-ink-muted")}>
                  {analysis.provider === "ai" ? t("ai.viaAI") : t("ai.viaLocal")}
                </span>
                <Link href={`/dashboard/coin/${c.symbol}`} className="flex items-center gap-1 text-[11px] font-semibold text-cyan transition-colors hover:text-cyan/80">
                  {t("coin.fullAnalysis")} <ChevronRight className="h-3 w-3 rtl:rotate-180" />
                </Link>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ConfidenceRing({ value }: { value: number }) {
  const r = 16;
  const circ = 2 * Math.PI * r;
  const off = circ * (1 - Math.min(100, Math.max(0, value)) / 100);
  const color = confColor(value);
  return (
    <div className="relative grid h-11 w-11 shrink-0 place-items-center">
      <svg viewBox="0 0 40 40" className="h-11 w-11 -rotate-90">
        <circle cx="20" cy="20" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3.5" />
        <circle cx="20" cy="20" r={r} fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={off} />
      </svg>
      <span className="absolute font-mono text-[11px] font-bold tnum" style={{ color }}>{value}</span>
    </div>
  );
}

function Cell({ label, v, tone }: { label: string; v: string; tone?: "bull" | "bear" }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div dir="ltr" className={cn("mt-0.5 text-start font-mono text-xs font-semibold tnum", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-ink")}>{v}</div>
    </div>
  );
}
