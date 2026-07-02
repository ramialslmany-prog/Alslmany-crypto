/**
 * Per-coin deep AI analysis: pulls the detailed klines engine result for one
 * coin, then asks the AI gateway for a professional analysis + recommendation.
 * Falls back to the computed facts when no LLM is configured. Shared by the
 * Deep Analysis panel and the recommendation cards.
 */
import type { Coin } from "@/lib/mock-data";
import type { Recommendation } from "@/lib/signal-engine";
import { formatUsd, formatPercent, formatCompact } from "@/lib/format";

export function buildContext(c: Coin, r: Recommendation, lang: "en" | "ar"): string {
  const L = (en: string, ar: string) => (lang === "ar" ? ar : en);
  return [
    `${c.name} (${c.symbol})${c.rank ? ` — #${c.rank}` : ""}`,
    `${L("Price", "السعر")} ${formatUsd(c.price)} · 24h ${formatPercent(c.change24h)} · 7d ${formatPercent(c.change7d)}`,
    `${L("Market cap", "القيمة السوقية")} $${formatCompact(c.marketCap)} · ${L("24h vol", "حجم 24س")} $${formatCompact(c.volume24h)}`,
    `${L("Engine call", "إشارة المحرّك")}: ${r.signal} · ${L("confidence", "الثقة")} ${r.confidence}% · ${L("risk", "المخاطرة")} ${r.riskLevel} · ${L("trend", "الاتجاه")} ${r.trend} · TF ${r.ltf}/${r.htf}`,
    `${L("Plan", "الخطة")}: entry ${formatUsd(r.entry)} · stop ${formatUsd(r.stop)} · targets ${r.targets.map((t) => formatUsd(t)).join(" / ")} · R:R ${r.riskReward.toFixed(2)}`,
    `${L("Indicators", "المؤشرات")}: RSI ${r.indicators.rsi.toFixed(0)} · MACD ${r.indicators.macdHist >= 0 ? "+" : ""}${r.indicators.macdHist.toFixed(2)} · ATR ${r.indicators.atrPct.toFixed(2)}% · %B ${r.indicators.bbPctB.toFixed(2)}`,
    `${L("Signals", "الإشارات")}: ${r.reasons.join("; ")}`,
  ].join("\n");
}

export async function deepAnalyze(coin: Coin, lang: "en" | "ar", context?: string): Promise<{ rec: Recommendation | null; text: string; provider: "ai" | "local" }> {
  let rec: Recommendation | null = null;
  try {
    rec = (await (await fetch(`/api/signals?symbol=${coin.symbol}&style=day&market=spot`)).json()) as Recommendation;
  } catch {
    /* engine unavailable */
  }
  const ctx = rec ? buildContext(coin, rec, lang) : `${coin.name} (${coin.symbol}) · ${formatUsd(coin.price)} · 24h ${formatPercent(coin.change24h)} · 7d ${formatPercent(coin.change7d)}`;
  let text = ctx;
  let provider: "ai" | "local" = "local";
  try {
    // Investor persona: live numbers come from our data, but the model is
    // explicitly asked to bring its broader knowledge of the project & market.
    const sys =
      lang === "ar"
        ? "أنت مستثمر كريبتو مخضرم تدير محفظتك الخاصة منذ سنوات. حلّل العملة بعمق بدمج أمرين: (1) المؤشرات والاتجاه المعطاة، و(2) معرفتك الواسعة عن المشروع نفسه: ما هو، أساسياته، فريقه واقتصاد توكنه، منافسوه، سردياته الحالية، تاريخه في الدورات السابقة، ومخاطره (تنظيمية/تقنية/سيولة). مهم جداً: لا تذكر أي سعر محدّد بالدولار إطلاقاً (الواجهة تعرض السعر الحيّ والخطة الرقمية) — تحدّث عن المستويات والاتجاه نوعياً (مقاومة/دعم/زخم) لا برقم. ثم أجب بصراحة كأن المال مالك: ماذا ستفعل أنت الآن (شراء/بيع/انتظار)؟ بأي نسبة من المحفظة؟ وما الشرط الذي يغيّر رأيك؟ اذكر أقوى سبب مع وأقوى سبب ضد. اكتب بالعربية الفصحى حصراً في ٨–١٤ جملة منظّمة — يُسمح برموز العملات فقط، وممنوع أي كلمات من لغات أخرى. ليست نصيحة مالية."
        : "You are a veteran crypto investor managing your own portfolio for years. Analyze the coin deeply by combining two things: (1) the provided indicators & trend, and (2) your broad knowledge of the project itself: what it is, fundamentals, team & tokenomics, competitors, current narratives, history across past cycles, and risks (regulatory/technical/liquidity). IMPORTANT: never state a specific dollar price (the UI already shows the live price and the numeric plan) — discuss levels and trend qualitatively (resistance/support/momentum), not with figures. Then answer candidly as if it were your own money: what would YOU do now (BUY/SELL/WAIT)? What portfolio allocation? What condition would change your mind? Give the strongest bull and bear case. 8–14 organized sentences. Not financial advice.";
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "system", content: sys }, { role: "system", content: (lang === "ar" ? "بيانات حيّة:\n" : "Live data:\n") + ctx }, { role: "user", content: (lang === "ar" ? `بصفتك مستثمراً: حلّل ${coin.name} (${coin.symbol}) بعمق — ماذا ستفعل أنت؟` : `As an investor: deeply analyze ${coin.name} (${coin.symbol}) — what would YOU do?`) + (context ? `\n${context}` : "") }] }),
    });
    const j = (await res.json()) as { text?: string | null };
    if (j?.text) {
      text = j.text;
      provider = "ai";
    }
  } catch {
    /* keep local context */
  }
  return { rec, text, provider };
}
