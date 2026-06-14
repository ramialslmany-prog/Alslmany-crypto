/**
 * Local, data-driven AI assistant.
 *
 * It actually answers — using the live market data + the scan engine — instead
 * of a canned demo reply. No external LLM key required. Detects the user's
 * intent (analyze a coin, best buys, movers, sentiment, market state) in Arabic
 * or English and responds with real, computed numbers.
 *
 * To upgrade to a true LLM later: add an `/api/assistant` route that calls
 * OpenAI/Claude/DeepSeek (key in env), and fall back to `answer()` when absent.
 */
import type { Coin } from "@/lib/mock-data";
import { scanCoin } from "@/lib/scan-engine";
import { isStable, liqBonus } from "@/lib/coin-meta";
import { formatUsd, formatPercent } from "@/lib/format";

type Lang = "en" | "ar";

const has = (q: string, words: string[]) => words.some((w) => q.includes(w));

function detectSymbol(q: string, coins: Coin[]): Coin | null {
  const upper = ` ${q.toUpperCase()} `;
  // exact symbol token (longest first so "BTC" beats a stray "B")
  const sorted = [...coins].sort((a, b) => b.symbol.length - a.symbol.length);
  for (const c of sorted) {
    if (new RegExp(`[^A-Z0-9]${c.symbol}[^A-Z0-9]`).test(upper)) return c;
  }
  const lower = q.toLowerCase();
  for (const c of coins) if (c.name && c.name.length > 3 && lower.includes(c.name.toLowerCase())) return c;
  const alias: Record<string, string> = {
    bitcoin: "BTC", "بيتكوين": "BTC", ethereum: "ETH", "ايثيريوم": "ETH", "إيثيريوم": "ETH",
    solana: "SOL", "سولانا": "SOL", ripple: "XRP", "ريبل": "XRP", dogecoin: "DOGE", "دوج": "DOGE",
  };
  for (const [k, sym] of Object.entries(alias)) if (lower.includes(k)) { const c = coins.find((x) => x.symbol === sym); if (c) return c; }
  return null;
}

const trendWord = (t: string, lang: Lang) =>
  lang === "ar" ? (t === "up" ? "صاعد" : t === "down" ? "هابط" : "عرضي") : t === "up" ? "Uptrend" : t === "down" ? "Downtrend" : "Ranging";

const actionWord = (s: string, lang: Lang) =>
  lang === "ar" ? (s === "LONG" ? "شراء" : s === "SHORT" ? "بيع / تجنّب" : "انتظار") : s === "LONG" ? "BUY" : s === "SHORT" ? "SELL / AVOID" : "WAIT";

function analyzeCoin(c: Coin, lang: Lang): string {
  const r = scanCoin(c, "day", "spot");
  const plan =
    r.signal !== "NEUTRAL"
      ? lang === "ar"
        ? `📐 الخطة: دخول ${formatUsd(r.entry)} · وقف ${formatUsd(r.stop)} · أهداف ${r.targets.map((t) => formatUsd(t)).join(" / ")} · مخاطرة:عائد ${r.riskReward.toFixed(2)}\n`
        : `📐 Plan: entry ${formatUsd(r.entry)} · stop ${formatUsd(r.stop)} · targets ${r.targets.map((t) => formatUsd(t)).join(" / ")} · R:R ${r.riskReward.toFixed(2)}\n`
      : "";
  if (lang === "ar") {
    return (
      `📊 ${c.name} (${c.symbol})\n` +
      `التوصية: ${actionWord(r.signal, "ar")} · الثقة ${r.confidence}% · المخاطرة ${r.riskLevel === "Low" ? "منخفضة" : r.riskLevel === "Medium" ? "متوسطة" : "عالية"}\n` +
      `الاتجاه: ${trendWord(r.trend, "ar")} · السعر ${formatUsd(c.price)} · ٢٤س ${formatPercent(c.change24h)} · ٧أيام ${formatPercent(c.change7d)}\n` +
      plan +
      `المؤشرات: RSI ${r.indicators.rsi.toFixed(0)} · MACD ${r.indicators.macdHist >= 0 ? "+" : ""}${r.indicators.macdHist.toFixed(2)} · ATR ${r.indicators.atrPct.toFixed(1)}%`
    );
  }
  return (
    `📊 ${c.name} (${c.symbol})\n` +
    `Call: ${actionWord(r.signal, "en")} · confidence ${r.confidence}% · risk ${r.riskLevel}\n` +
    `Trend: ${trendWord(r.trend, "en")} · price ${formatUsd(c.price)} · 24h ${formatPercent(c.change24h)} · 7d ${formatPercent(c.change7d)}\n` +
    plan +
    `Indicators: RSI ${r.indicators.rsi.toFixed(0)} · MACD ${r.indicators.macdHist >= 0 ? "+" : ""}${r.indicators.macdHist.toFixed(2)} · ATR ${r.indicators.atrPct.toFixed(1)}%`
  );
}

function bestBuys(coins: Coin[], lang: Lang): string {
  const buys = coins
    .filter((c) => !isStable(c.symbol))
    .map((c) => ({ c, r: scanCoin(c, "day", "spot") }))
    .filter((x) => x.r.signal === "LONG")
    .map((x) => ({ ...x, score: x.r.confidence + liqBonus(x.c.rank) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (!buys.length) return lang === "ar" ? "لا توجد فرص شراء واضحة الآن — السوق في وضع حذر." : "No clean buy setups right now — the market is risk-off.";
  const lines = buys.map((x, i) => {
    const tp1 = ((x.r.targets[0] - x.r.entry) / x.r.entry) * 100;
    return `${i + 1}. ${x.c.symbol} · ${lang === "ar" ? "ثقة" : "conf"} ${x.r.confidence}% · ${lang === "ar" ? "هدف" : "TP1"} +${tp1.toFixed(1)}%`;
  });
  return (lang === "ar" ? "🎯 أفضل فرص الشراء الآن:\n" : "🎯 Top buy setups now:\n") + lines.join("\n");
}

function movers(coins: Coin[], lang: Lang, dir: "up" | "down"): string {
  const list = coins
    .filter((c) => !isStable(c.symbol))
    .sort((a, b) => (dir === "up" ? b.change24h - a.change24h : a.change24h - b.change24h))
    .slice(0, 5)
    .map((c) => `${c.symbol} ${formatPercent(c.change24h)} · ${formatUsd(c.price)}`);
  const head = lang === "ar" ? (dir === "up" ? "📈 أكبر الرابحين (٢٤س):\n" : "📉 أكبر الخاسرين (٢٤س):\n") : dir === "up" ? "📈 Top gainers (24h):\n" : "📉 Top losers (24h):\n";
  return head + list.join("\n");
}

function marketSummary(coins: Coin[], lang: Lang): string {
  const ns = coins.filter((c) => !isStable(c.symbol));
  const buys = ns.map((c) => scanCoin(c, "day", "spot")).filter((r) => r.signal === "LONG").length;
  const avg = ns.reduce((a, c) => a + c.change24h, 0) / (ns.length || 1);
  const top = [...ns].sort((a, b) => b.change24h - a.change24h)[0];
  return lang === "ar"
    ? `🧭 حالة السوق: ${buys} فرصة شراء · متوسط التغيّر ٢٤س ${formatPercent(avg)} · الأقوى ${top.symbol} ${formatPercent(top.change24h)}`
    : `🧭 Market: ${buys} buy setups · avg 24h ${formatPercent(avg)} · top mover ${top.symbol} ${formatPercent(top.change24h)}`;
}

async function sentiment(lang: Lang): Promise<string> {
  try {
    const fg = (await (await fetch("/api/feargreed")).json()) as { value: number; classification: string };
    const arMap: Record<string, string> = { "Extreme Fear": "خوف شديد", Fear: "خوف", Neutral: "محايد", Greed: "طمع", "Extreme Greed": "طمع شديد" };
    return lang === "ar"
      ? `😨 مؤشّر الخوف والطمع: ${fg.value} (${arMap[fg.classification] ?? fg.classification})`
      : `😨 Fear & Greed: ${fg.value} (${fg.classification})`;
  } catch {
    return lang === "ar" ? "تعذّر جلب مؤشّر الخوف والطمع الآن." : "Couldn't fetch the Fear & Greed index right now.";
  }
}

function help(lang: Lang): string {
  return lang === "ar"
    ? "أقدر أساعدك بأشياء حقيقية من السوق المباشر:\n• تحليل أي عملة — اكتب رمزها (مثل: حلّل SOL)\n• أفضل فرص الشراء الآن\n• أكبر الرابحين / الخاسرين\n• حالة السوق العامة\n• مؤشّر الخوف والطمع"
    : "I answer with live market data:\n• Analyze any coin — type its symbol (e.g. analyze SOL)\n• Best buy setups now\n• Top gainers / losers\n• Overall market state\n• Fear & Greed sentiment";
}

/** Compact live-market context (used to ground the LLM / as a fallback brief). */
export function marketContext(coins: Coin[], lang: Lang): string {
  return `${marketSummary(coins, lang)}\n${bestBuys(coins, lang)}`;
}

/** Main entry — returns a real answer string. */
export async function answer(q: string, coins: Coin[], lang: Lang): Promise<string> {
  const query = q.toLowerCase();
  const symbol = detectSymbol(q, coins);

  const wantBest = has(query, ["best", "top", "recommend", "signal", "أفضل", "افضل", "فرص", "توصيات", "توصية", "اشتري", "شو اشتري"]);
  const wantGainers = has(query, ["gainer", "winners", "الرابح", "ارباح", "ارتفاع", "صعود", "الاكثر ربح"]);
  const wantLosers = has(query, ["loser", "الخاسر", "خساره", "انخفاض", "هبوط", "الاكثر خساره"]);
  const wantFear = has(query, ["fear", "greed", "sentiment", "خوف", "طمع", "معنويات", "مشاعر"]);
  const wantMarket = has(query, ["market", "overview", "حالة السوق", "وضع السوق", "نظره", "السوق كيف", "كيف السوق"]);
  const wantHelp = has(query, ["help", "what can you", "capab", "مساعده", "مساعدة", "ماذا تستطيع", "شو تقدر", "وش تسوي"]);

  // A named coin always wins — the user is asking about THAT coin.
  if (symbol) return analyzeCoin(symbol, lang);
  if (wantFear) return sentiment(lang);
  if (wantGainers) return movers(coins, lang, "up");
  if (wantLosers) return movers(coins, lang, "down");
  if (wantBest) return bestBuys(coins, lang);
  if (wantMarket) return marketSummary(coins, lang);
  if (wantHelp) return help(lang);
  return lang === "ar"
    ? "لم ألتقط عملة محدّدة. " + help("ar")
    : "I didn't catch a specific coin. " + help("en");
}
