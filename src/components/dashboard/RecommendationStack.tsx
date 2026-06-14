"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Sparkles, ChevronRight, ArrowUpRight, ChevronDown, Brain, Loader2 } from "lucide-react";
import { useMarkets } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { qualityScore, type Recommendation } from "@/lib/signal-engine";
import { scanCoin as scan } from "@/lib/scan-engine";
import { deepAnalyze } from "@/lib/deep-analyze";
import { isStable, liqBonus } from "@/lib/coin-meta";
import type { Coin } from "@/lib/mock-data";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

type Pick = { c: Coin; r: Recommendation };

/** Real AI recommendations: top buy setups from the analysis engine + an LLM verdict. */
export function RecommendationStack() {
  const { coins } = useMarkets();
  const { t, lang } = useI18n();
  const [verdict, setVerdict] = useState("");
  const [provider, setProvider] = useState<"ai" | "local" | "">("");
  const [openSym, setOpenSym] = useState<string | null>(null);
  const [analyses, setAnalyses] = useState<Record<string, { text: string; provider: "ai" | "local"; loading: boolean }>>({});

  const toggle = async (pick: Pick) => {
    const sym = pick.c.symbol;
    if (openSym === sym) {
      setOpenSym(null);
      return;
    }
    setOpenSym(sym);
    if (!analyses[sym]) {
      setAnalyses((a) => ({ ...a, [sym]: { text: "", provider: "local", loading: true } }));
      const res = await deepAnalyze(pick.c, lang);
      setAnalyses((a) => ({ ...a, [sym]: { text: res.text, provider: res.provider, loading: false } }));
    }
  };

  const picks: Pick[] = useMemo(
    () =>
      coins
        .filter((c) => !isStable(c.symbol))
        .map((c) => ({ c, r: scan(c, "day", "spot") }))
        .filter((x) => x.r.signal === "LONG")
        .map((x) => ({ ...x, score: qualityScore(x.r) + liqBonus(x.c.rank) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 4),
    [coins]
  );

  const sig = picks.map((p) => p.c.symbol + p.r.confidence).join(",");
  useEffect(() => {
    if (!picks.length) {
      setVerdict(t("rec.noBuys"));
      setProvider("local");
      return;
    }
    const facts = picks.map((x, i) => `${i + 1}. ${x.c.symbol} conf ${x.r.confidence}% entry ${formatUsd(x.r.entry)} TP1 ${formatUsd(x.r.targets[0])}`).join("\n");
    const local =
      lang === "ar"
        ? `${picks.length} فرص شراء قوية، يتصدّرها ${picks[0].c.symbol}${picks[1] ? ` و${picks[1].c.symbol}` : ""} بثقة عالية.`
        : `${picks.length} strong buy setups, led by ${picks[0].c.symbol}${picks[1] ? ` and ${picks[1].c.symbol}` : ""}.`;
    setVerdict(local);
    setProvider("local");

    let cancelled = false;
    (async () => {
      try {
        const sys =
          lang === "ar"
            ? "أنت مستثمر كريبتو مخضرم. علّق بجملتين أو ثلاث على هذه التوصيات: استخدم الأرقام المعطاة، وأضف رأيك من معرفتك بهذه المشاريع وأيها تفضّل أنت ولماذا. بالعربية. ليست نصيحة مالية."
            : "You are a veteran crypto investor. Comment in 2-3 sentences on these picks: use the given numbers, add your own take from what you know about these projects and which YOU would prefer and why. Not financial advice.";
        const res = await fetch("/api/ai", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "system", content: sys }, { role: "system", content: facts }, { role: "user", content: lang === "ar" ? "لخّص التوصيات." : "Summarize the picks." }] }),
        });
        const j = (await res.json()) as { text?: string | null };
        if (!cancelled && j?.text) {
          setVerdict(j.text);
          setProvider("ai");
        }
      } catch {
        /* keep local */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, lang]);

  return (
    <div className="glass glow-border rounded-2xl p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet" />
          <h2 className="text-sm font-semibold">{t("ov.aiRecs")}</h2>
          {provider && (
            <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-bold", provider === "ai" ? "border-bull/30 bg-bull/10 text-bull" : "border-white/10 bg-white/[0.04] text-ink-muted")}>
              {provider === "ai" ? t("ai.viaAI") : t("ai.viaLocal")}
            </span>
          )}
        </div>
        <Link href="/dashboard/tracker" className="flex items-center gap-1 text-xs font-medium text-ink-muted transition-colors hover:text-cyan">
          {t("ov.viewAll")} <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />
        </Link>
      </div>

      {/* AI verdict */}
      <div className="mt-3 rounded-xl border border-violet/20 bg-violet/[0.06] p-3">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-violet">{t("rec.verdict")}</div>
        <p className="whitespace-pre-line text-xs leading-relaxed text-ink-muted">{verdict || "…"}</p>
      </div>

      {/* picks */}
      <div className="mt-3 space-y-2.5">
        {picks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/[0.1] px-4 py-6 text-center text-sm text-ink-faint">{t("rec.noBuys")}</div>
        ) : (
          picks.map((pick) => {
            const { c, r } = pick;
            const tp1 = ((r.targets[0] - r.entry) / r.entry) * 100;
            const confColor = r.confidence >= 70 ? "#00E676" : r.confidence >= 55 ? "#FFD166" : "#8A94B0";
            return (
              <div key={c.symbol} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="flex items-center gap-2.5">
                  <CoinIcon symbol={c.symbol} image={c.image} size={28} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-bold">{c.symbol}</span>
                      {c.dex && <span className="rounded bg-violet/15 px-1 py-0.5 text-[8px] font-bold uppercase text-violet">DEX</span>}
                    </div>
                    <div className="hidden truncate text-[10px] text-ink-faint sm:block">{c.name}</div>
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-full border border-bull/30 bg-bull/10 px-2 py-0.5 text-[11px] font-bold text-bull">
                    <ArrowUpRight className="h-3 w-3" /> {t("dir.BUY")}
                  </span>
                  <span className="ms-auto font-mono text-sm font-bold tnum" style={{ color: confColor }}>{r.confidence}%</span>
                </div>
                <div className="mt-2.5 grid grid-cols-4 gap-2">
                  <Cell label={t("ms.entry")} v={formatUsd(r.entry)} />
                  <Cell label={t("ms.stop")} v={formatUsd(r.stop)} tone="bear" />
                  <Cell label="TP1" v={`+${tp1.toFixed(1)}%`} tone="bull" />
                  <Cell label="R:R" v={`${r.riskReward.toFixed(2)}:1`} />
                </div>
                {/* deep AI analysis on demand */}
                <button onClick={() => toggle(pick)} className="mt-2.5 flex w-full items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-[11px] font-semibold text-ink-muted transition-colors hover:text-violet">
                  <span className="flex items-center gap-1.5"><Brain className="h-3.5 w-3.5 text-violet" /> {t("rec.deep")}</span>
                  <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", openSym === c.symbol && "rotate-180")} />
                </button>
                {openSym === c.symbol && (
                  <div className="mt-2 rounded-lg bg-white/[0.03] p-3">
                    {analyses[c.symbol]?.loading ? (
                      <span className="flex items-center gap-2 text-xs text-ink-faint"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("da.analyzing")}</span>
                    ) : (
                      <>
                        <p className="whitespace-pre-line text-xs leading-relaxed text-ink-muted">{analyses[c.symbol]?.text}</p>
                        {analyses[c.symbol] && (
                          <span className={cn("mt-2 inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold", analyses[c.symbol].provider === "ai" ? "border-bull/30 bg-bull/10 text-bull" : "border-white/10 bg-white/[0.04] text-ink-muted")}>
                            {analyses[c.symbol].provider === "ai" ? t("ai.viaAI") : t("ai.viaLocal")}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <p className="mt-3 text-center text-[10px] text-ink-faint">{t("ms.disclaimer")}</p>
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
