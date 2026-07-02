"use client";

import { useCallback, useEffect, useState } from "react";
import { Sparkles, RefreshCw } from "lucide-react";
import { useMarkets } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { marketContext } from "@/lib/assistant";
import { cn } from "@/lib/utils";

/**
 * AI-generated market brief. Sends live, locally-computed facts to the AI
 * gateway (/api/ai) and shows the model's brief; if no LLM is configured it
 * falls back to the real computed facts — so it always works.
 */
export function AIBrief() {
  const { coins } = useMarkets();
  const { t, lang } = useI18n();
  const [brief, setBrief] = useState("");
  const [provider, setProvider] = useState<"ai" | "local" | "">("");
  const [loading, setLoading] = useState(false);

  const generate = useCallback(async () => {
    if (!coins.length) return;
    setLoading(true);
    const facts = await marketContext(coins, lang);
    let text = facts;
    let prov: "ai" | "local" = "local";
    try {
      const sys =
        lang === "ar"
          ? "أنت مستثمر كريبتو مخضرم. اكتب موجزاً (٤–٧ جمل) عن حالة السوق وأبرز الفرص: استخدم البيانات المعطاة للأرقام فقط — لا تذكر أي سعر أو رقم غير وارد فيها — وادمجها بمعرفتك بالسياق الأوسع (دورات السوق، السيولة، السرديات الحالية، سلوك بيتكوين كقائد للسوق). اختم برأيك: ماذا ستفعل أنت اليوم؟ اكتب بالعربية الفصحى حصراً — يُسمح برموز العملات فقط، وممنوع أي كلمات من لغات أخرى. ليست نصيحة مالية."
          : "You are a veteran crypto investor. Write a brief (4–7 sentences) on the market state and best opportunities: use ONLY the provided data for numbers — never state a price or figure not present in it — blended with your broader knowledge (market cycles, liquidity, current narratives, Bitcoin as the market leader). End with your own call: what would YOU do today? Not financial advice.";
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: sys },
            { role: "system", content: (lang === "ar" ? "بيانات حيّة:\n" : "Live data:\n") + facts },
            { role: "user", content: lang === "ar" ? "اكتب الموجز." : "Write the brief." },
          ],
        }),
      });
      const j = (await res.json()) as { text?: string | null };
      if (j?.text) {
        text = j.text;
        prov = "ai";
      }
    } catch {
      /* keep local facts */
    }
    setBrief(text);
    setProvider(prov);
    setLoading(false);
  }, [coins, lang]);

  useEffect(() => {
    generate();
  }, [generate]);

  return (
    <div className="glass glow-border rounded-2xl p-5">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-violet/15 text-violet">
          <Sparkles className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">{t("ai.briefTitle")}</h2>
          <p className="text-[11px] text-ink-faint">{t("ai.briefSub")}</p>
        </div>
        {provider && (
          <span className={cn("ms-auto rounded-full border px-2 py-0.5 text-[10px] font-bold", provider === "ai" ? "border-bull/30 bg-bull/10 text-bull" : "border-white/10 bg-white/[0.04] text-ink-muted")}>
            {provider === "ai" ? t("ai.viaAI") : t("ai.viaLocal")}
          </span>
        )}
        <button onClick={generate} disabled={loading} aria-label={t("a11y.refresh")} className="ms-2 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.03] text-ink-muted transition-colors hover:text-cyan disabled:opacity-50">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>
      <div className="mt-4 min-h-[140px] whitespace-pre-line rounded-xl bg-white/[0.03] p-4 text-sm leading-relaxed text-ink-muted">
        {loading && !brief ? t("ai.generating") : brief}
      </div>
    </div>
  );
}
