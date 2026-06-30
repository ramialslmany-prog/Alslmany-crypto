"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Sparkles, ChevronRight, ArrowUpRight, ChevronDown, Brain, Loader2, ShieldAlert, TrendingUp } from "lucide-react";
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

type Pick = { c: Coin; r: Recommendation };
const STYLES: Style[] = ["scalp", "day", "swing"];
const confColor = (v: number) => (v >= 70 ? "#00E676" : v >= 55 ? "#FFD166" : "#8A94B0");

/** Real AI recommendations: top buy setups from the analysis engine + an LLM verdict. */
export function RecommendationStack() {
  const { coins } = useMarkets();
  const { t, lang } = useI18n();
  const [style, setStyle] = useState<Style>("day");
  const [verdict, setVerdict] = useState("");
  const [provider, setProvider] = useState<"ai" | "local" | "">("");
  const [openSym, setOpenSym] = useState<string | null>(null);
  const [analyses, setAnalyses] = useState<Record<string, { text: string; provider: "ai" | "local"; loading: boolean }>>({});
  // Market-leader regime (BTC 4h/1d), shared & cached — when BTC is in a downtrend
  // the trader holds cash, so the overview must not flash BUY cards.
  const { bearish: regimeBearish, trend: btcTrend } = useBtcRegime();

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

  // Stage 1 — fast scan narrows the whole market to liquid, non-stable,
  // non-pumped uptrend candidates (close-only, instant).
  const candidates = useMemo(
    () =>
      coins
        .filter((c) => !isStable(c.symbol) && (c.rank ?? 999) <= 120 && (c.change24h ?? 0) <= 15 && (c.change24h ?? 0) >= -12)
        .map((c) => ({ c, r: scan(c, style, "spot") }))
        .filter((x) => x.r.signal === "LONG" && x.r.confidence >= 60 && x.r.trend === "up")
        .map((x) => ({ ...x, score: qualityScore(x.r) + liqBonus(x.c.rank) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8),
    [coins, style]
  );
  const candSig = candidates.map((c) => c.c.symbol).join(",") + style;

  // Stage 2 — confirm each with the SAME rigorous multi-timeframe engine the
  // deep analysis uses, so the card and the analysis never contradict.
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
            if (rec.signal === "LONG" && rec.confidence >= 60 && rec.trend === "up") confirmed.push({ c: cand.c, r: rec });
          } catch {
            /* skip */
          }
        })
      );
      confirmed.sort((a, b) => b.r.confidence - a.r.confidence);
      if (!cancelled) {
        setPicks(confirmed.slice(0, 4));
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candSig]);

  // LLM verdict over the confirmed picks.
  const sig = picks.map((p) => p.c.symbol + p.r.confidence).join(",");
  useEffect(() => {
    if (!picks.length) { setVerdict(""); setProvider(""); return; }
    const facts = picks.map((x, i) => `${i + 1}. ${x.c.symbol} conf ${x.r.confidence}% entry ${formatUsd(x.r.entry)} TP1 ${formatUsd(x.r.targets[0])} R:R ${x.r.riskReward.toFixed(2)}`).join("\n");
    setVerdict(
      lang === "ar"
        ? `${picks.length} فرص شراء قوية، يتصدّرها ${picks[0].c.symbol}${picks[1] ? ` و${picks[1].c.symbol}` : ""} بثقة عالية.`
        : `${picks.length} strong buy setups, led by ${picks[0].c.symbol}${picks[1] ? ` and ${picks[1].c.symbol}` : ""}.`
    );
    setProvider("local");
    let cancelled = false;
    (async () => {
      try {
        const sys =
          lang === "ar"
            ? "أنت مستثمر كريبتو مخضرم. علّق بجملتين أو ثلاث على هذه التوصيات: استخدم الأرقام المعطاة، وأضف رأيك من معرفتك بهذه المشاريع وأيها تفضّل أنت ولماذا. اكتب بالعربية الفصحى فقط دون خلط أي كلمات من لغات أخرى. ليست نصيحة مالية."
            : "You are a veteran crypto investor. Comment in 2-3 sentences on these picks: use the given numbers, add your own take from what you know about these projects and which YOU would prefer and why. Not financial advice.";
        const res = await fetch("/api/ai", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "system", content: sys }, { role: "system", content: facts }, { role: "user", content: lang === "ar" ? "لخّص التوصيات." : "Summarize the picks." }] }),
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
          <button
            key={s}
            onClick={() => setStyle(s)}
            className={cn("flex-1 rounded-lg px-3 py-1.5 text-xs font-bold transition-all", style === s ? "bg-cyan-violet text-base-950" : "text-ink-muted hover:text-ink")}
          >
            {t(`ms.${s}`)}
          </button>
        ))}
      </div>

      {regimeBearish === true ? (
        /* Regime gate: BTC higher-timeframe downtrend → hold cash, show no buys. */
        <div className="mt-3 rounded-xl border border-bear/30 bg-bear/[0.08] p-4">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-bear">
            <ShieldAlert className="h-4 w-4" /> {lang === "ar" ? "السوق غير مؤاتٍ — نقداً" : "Unfavorable market — in cash"}
          </div>
          <p className="whitespace-pre-line text-xs leading-relaxed text-ink-muted">
            {lang === "ar"
              ? "بيتكوين (قائد السوق) في اتجاه هابط على الإطار الأعلى. لا أعرض توصيات شراء الآن — لا تُشترى الألتكوينات في سوق هابط. حماية رأس المال أولاً، وننتظر تعافي القائد."
              : "Bitcoin (the market leader) is in a higher-timeframe downtrend. No buy setups right now — you don't buy alts into a falling market. Capital first; waiting for the leader to recover."}
          </p>
          <div className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-[11px]">
            <span className="text-ink-faint">{lang === "ar" ? "اتجاه BTC" : "BTC trend"}</span>
            <span className="font-bold text-bear">{btcTrend === "down" ? (lang === "ar" ? "هابط ↓" : "down ↓") : (btcTrend ?? "—")}</span>
          </div>
        </div>
      ) : (
        <>
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

          {/* picks */}
          <div className="mt-3 space-y-2.5">
            {loading && picks.length === 0 ? (
              [0, 1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-2xl bg-white/[0.03]" />)
            ) : picks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/[0.1] px-4 py-8 text-center text-sm text-ink-faint">{t("rec.noBuys")}</div>
            ) : (
              picks.map((pick, idx) => (
                <PickCard
                  key={pick.c.symbol}
                  pick={pick}
                  rank={idx + 1}
                  open={openSym === pick.c.symbol}
                  onToggle={() => toggle(pick)}
                  analysis={analyses[pick.c.symbol]}
                  t={t}
                />
              ))
            )}
          </div>
        </>
      )}
      <p className="mt-3 text-center text-[10px] text-ink-faint">{t("ms.disclaimer")}</p>
    </div>
  );
}

function PickCard({
  pick, rank, open, onToggle, analysis, t,
}: {
  pick: Pick; rank: number; open: boolean; onToggle: () => void;
  analysis?: { text: string; provider: "ai" | "local"; loading: boolean }; t: (k: string) => string;
}) {
  const { c, r } = pick;
  const up = (c.change24h ?? 0) >= 0;
  const dist = (p: number) => ((p - r.entry) / r.entry) * 100;
  const chips = [
    `RSI ${r.indicators.rsi.toFixed(0)}`,
    r.indicators.macdHist >= 0 ? "MACD ↑" : "MACD ↓",
    r.indicators.volRatio >= 1.2 ? "VOL ✓" : null,
  ].filter(Boolean) as string[];

  return (
    <div className={cn("rounded-2xl border bg-white/[0.02] p-3 transition-colors", rank === 1 ? "border-bull/25" : "border-white/[0.06]")}>
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

      {/* price + signal */}
      <div className="mt-2 flex items-center justify-between">
        <div dir="ltr" className="flex items-baseline gap-2">
          <LivePrice value={c.price} format={formatUsd} className="font-mono text-sm font-bold text-ink" />
          <span className={cn("font-mono text-[11px] font-semibold tnum", up ? "text-bull" : "text-bear")}>{formatPercent(c.change24h)}</span>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-bull/30 bg-bull/10 px-2 py-0.5 text-[11px] font-bold text-bull">
          <ArrowUpRight className="h-3 w-3" /> {t("dir.BUY")}
        </span>
      </div>

      {/* reason chips */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-md bg-bull/10 px-1.5 py-0.5 text-[10px] font-semibold text-bull"><TrendingUp className="h-2.5 w-2.5" /> {t("ms.up")}</span>
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

      {/* deep AI analysis on demand */}
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
