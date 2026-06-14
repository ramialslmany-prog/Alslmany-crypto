"use client";

import { useEffect, useState } from "react";
import { Newspaper, ExternalLink, Sparkles } from "lucide-react";
import { useNews } from "@/lib/hooks";
import { useI18n, timeAgo } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function NewsView() {
  const { items, isLoading } = useNews();
  const { t, lang } = useI18n();
  const [impact, setImpact] = useState("");
  const [provider, setProvider] = useState<"ai" | "local" | "">("");

  // AI read on the top headlines (grounded in the real titles).
  const headlineSig = items.slice(0, 6).map((i) => i.title).join(" | ");
  useEffect(() => {
    if (!items.length) return;
    const titles = items.slice(0, 6).map((i, n) => `${n + 1}. ${i.title}`).join("\n");
    setImpact("");
    setProvider("");
    let cancelled = false;
    (async () => {
      const local = lang === "ar" ? "أحدث العناوين معروضة بالأسفل من مصادر موثوقة." : "Latest headlines from trusted sources are listed below.";
      try {
        const sys =
          lang === "ar"
            ? "أنت مستثمر كريبتو مخضرم. اقرأ العناوين وأعطِ ٣–٤ جمل: التأثير المحتمل على المعنويات (إيجابي/سلبي/محايد) مع ربطها بالسياق الأوسع الذي تعرفه (التنظيم، المؤسسات، الدورات)، وكيف ستتصرّف أنت بناءً عليها. لا تختلق أخباراً. بالعربية. ليست نصيحة مالية."
            : "You are a veteran crypto investor. Read the headlines and give 3-4 sentences: likely sentiment impact (bullish/bearish/neutral), connected to the broader context you know (regulation, institutions, cycles), and how YOU would act on it. Don't invent news. Not financial advice.";
        const res = await fetch("/api/ai", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "system", content: sys }, { role: "system", content: titles }, { role: "user", content: lang === "ar" ? "ما تأثير هذه الأخبار؟" : "What's the market impact?" }] }),
        });
        const j = (await res.json()) as { text?: string | null };
        if (!cancelled) {
          if (j?.text) {
            setImpact(j.text);
            setProvider("ai");
          } else {
            setImpact(local);
            setProvider("local");
          }
        }
      } catch {
        if (!cancelled) {
          setImpact(local);
          setProvider("local");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headlineSig, lang]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Newspaper className="h-5 w-5 text-cyan" />
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{t("news.title")}</h1>
          <p className="text-sm text-ink-muted">{t("news.sub")}</p>
        </div>
      </div>

      {/* AI impact */}
      <div className="glass glow-border rounded-2xl p-4">
        <div className="mb-1.5 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet" />
          <span className="text-xs font-bold uppercase tracking-wider text-violet">{t("news.impact")}</span>
          {provider && (
            <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-bold", provider === "ai" ? "border-bull/30 bg-bull/10 text-bull" : "border-white/10 bg-white/[0.04] text-ink-muted")}>
              {provider === "ai" ? t("ai.viaAI") : t("ai.viaLocal")}
            </span>
          )}
        </div>
        <p className="whitespace-pre-line text-sm leading-relaxed text-ink-muted">{impact || t("news.loading")}</p>
      </div>

      {/* headlines */}
      <div className="glass glow-border overflow-hidden rounded-2xl">
        {isLoading && !items.length ? (
          <div className="px-4 py-10 text-center text-sm text-ink-faint">{t("news.loading")}</div>
        ) : items.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-ink-muted">{t("news.empty")}</div>
        ) : (
          <div className="divide-y divide-white/[0.05]">
            {items.map((n, i) => {
              const ms = new Date(n.pubDate).getTime();
              return (
                <a key={i} href={n.link} target="_blank" rel="noopener noreferrer" className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]">
                  <span className="mt-0.5 shrink-0 rounded-md border border-cyan/25 bg-cyan/10 px-1.5 py-0.5 text-[10px] font-bold text-cyan">{n.source}</span>
                  <span className="flex-1 text-sm leading-relaxed text-ink transition-colors group-hover:text-cyan">{n.title}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {ms ? <span className="text-[11px] text-ink-faint">{timeAgo(ms, t)}</span> : null}
                    <ExternalLink className="h-3.5 w-3.5 text-ink-faint" />
                  </span>
                </a>
              );
            })}
          </div>
        )}
      </div>
      <p className="text-center text-[11px] text-ink-faint">
        {lang === "ar" ? "العناوين من Cointelegraph و CoinDesk مباشرةً." : "Headlines live from Cointelegraph and CoinDesk."}
      </p>
    </div>
  );
}
