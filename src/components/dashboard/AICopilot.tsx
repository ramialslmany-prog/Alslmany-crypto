"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Send, Sparkles, User } from "lucide-react";
import { useMarkets } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { answer } from "@/lib/assistant";
import { cn } from "@/lib/utils";

type Msg = { role: "ai" | "user"; text: string };

export function AICopilot() {
  const { coins } = useMarkets();
  const { t, lang } = useI18n();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Greeting in the active language — refreshes if the language changes before
  // any conversation has started (but never wipes an ongoing chat).
  useEffect(() => {
    setMessages((m) => (m.some((x) => x.role === "user") ? m : [{ role: "ai", text: t("ai.greeting") }]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  const suggestions =
    lang === "ar"
      ? ["أفضل فرص الشراء", "حلّل BTC", "أكبر الرابحين", "مؤشّر الخوف والطمع"]
      : ["Best buys now", "Analyze BTC", "Top gainers", "Fear & Greed"];

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || thinking) return;
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setThinking(true);

    // Local engine computes grounded facts (always works, real numbers).
    const facts = await answer(q, coins, lang);
    let reply = facts;
    try {
      const sys =
        lang === "ar"
          ? "أنت «Alslmany»، مستثمر كريبتو مخضرم يجيب كأن المال ماله. استخدم البيانات الحيّة المعطاة للأرقام فقط — لا تخترع أي سعر أو رقم غير وارد فيها — وادمجها بمعرفتك الواسعة: أساسيات المشاريع، السرديات، الدورات، السياق الكلي، والمخاطر. أعطِ رأياً صريحاً وقراراً واضحاً مع التعليل، واذكر متى تكون مخطئاً. اكتب بالعربية الفصحى حصراً بإيجاز منظّم — يُسمح برموز العملات فقط، وممنوع أي كلمات من لغات أخرى. ليست نصيحة مالية."
          : "You are Alslmany, a veteran crypto investor answering as if it's your own money. Use the provided live data for numbers (don't invent live prices), but blend it with your broad knowledge: project fundamentals, narratives, market cycles, macro context and risks. Give a candid opinion and a clear decision with reasoning, and say what would prove you wrong. Concise and organized. Not financial advice.";
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: sys },
            { role: "system", content: (lang === "ar" ? "بيانات حيّة ذات صلة:\n" : "Relevant live data:\n") + facts },
            { role: "user", content: q },
          ],
        }),
      });
      const j = (await res.json()) as { text?: string | null };
      if (j?.text) reply = j.text;
    } catch {
      /* keep the local grounded answer */
    }

    setThinking(false);
    setMessages((m) => [...m, { role: "ai", text: reply }]);
  };

  return (
    <div className="glass glow-border flex min-h-[480px] max-h-[640px] flex-col rounded-2xl p-5">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-violet/15 text-violet">
          <Bot className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">{t("nav.copilot")}</h2>
          <p className="text-[11px] text-ink-faint">{t("ai.sub")}</p>
        </div>
        <span className="ms-auto flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-bull">
          <span className="h-1.5 w-1.5 rounded-full bg-bull animate-pulse-glow" /> {t("ov.live")}
        </span>
      </div>

      <div ref={scrollRef} className="mt-4 flex-1 space-y-3 overflow-y-auto pe-1">
        {messages.map((m, i) => (
          <div key={i} className={cn("flex gap-2.5", m.role === "user" && "flex-row-reverse")}>
            <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-lg", m.role === "ai" ? "bg-violet/15 text-violet" : "bg-cyan/15 text-cyan")}>
              {m.role === "ai" ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
            </span>
            <div className={cn("max-w-[82%] whitespace-pre-line rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed", m.role === "ai" ? "bg-white/[0.04] text-ink-muted" : "bg-cyan-violet font-medium text-base-950")}>
              {m.text}
            </div>
          </div>
        ))}
        {thinking && (
          <div className="flex gap-2.5">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-violet/15 text-violet">
              <Bot className="h-3.5 w-3.5" />
            </span>
            <div className="flex items-center gap-1 rounded-2xl bg-white/[0.04] px-4 py-3">
              {[0, 1, 2].map((i) => (
                <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet" style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {suggestions.map((s) => (
          <button key={s} onClick={() => send(s)} className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:border-cyan/40 hover:text-cyan">
            {s}
          </button>
        ))}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="mt-3 flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2">
        <Sparkles className="h-4 w-4 shrink-0 text-violet" />
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t("ov.ask")} className="w-full bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none" />
        <button type="submit" aria-label={t("a11y.send")} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-cyan-violet text-base-950 transition-transform hover:scale-105">
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
