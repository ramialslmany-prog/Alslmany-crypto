"use client";

/**
 * Autonomous trading engine — shared by the global watcher (auto mode) and
 * the AI Trader page (manual re-run buttons).
 *
 * Strategy (strict, profit-oriented):
 *   • spot LONG only, confirmed uptrend, healthy dip entry (scan engine)
 *   • confidence ≥ adaptive bar (tightens after losses)
 *   • liquidity guard: top-200 market cap only — no illiquid microcaps
 *   • risk management: max 3 concurrent positions, ~4h between entries
 *   • lessons from past self-reviews injected into every entry decision
 * Telegram is notified on every entry, exit and self-review.
 */
import { scanCoin } from "@/lib/scan-engine";
import { qualityScore } from "@/lib/signal-engine";
import { isStable, liqBonus } from "@/lib/coin-meta";
import { issueTrades, journalStats, adaptiveMinConf, getLessons, setLessons, type JTrade } from "@/lib/ai-journal";
import type { Coin } from "@/lib/mock-data";
import { formatUsd } from "@/lib/format";

const ISSUE_KEY = "quantum.aitrader.lastIssue";
const REVIEWED_KEY = "quantum.aitrader.reviewed";
export const ISSUE_EVERY_MS = 4 * 3600e3; // a new entry round at most every ~4h
export const MAX_OPEN = 3; // risk management: never more than 3 open positions

type Lang = "en" | "ar";

/** Plain signal-channel price format (no $): 0.03126 / 63,482.15 */
export function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return Number(n.toPrecision(4)).toString();
}

/** Arabic duration: "٧ ساعة ٤ دقيقة" style (days/hours/minutes). */
export function durAr(ms: number): string {
  const mTot = Math.max(1, Math.floor(ms / 60000));
  const d = Math.floor(mTot / 1440);
  const h = Math.floor((mTot % 1440) / 60);
  const m = mTot % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d} يوم`);
  if (h) parts.push(`${h} ساعة`);
  if (m || !parts.length) parts.push(`${m} دقيقة`);
  return parts.join(" ");
}

/** Professional signal-channel entry card. */
export function entryCard(symbol: string, entry: number, stop: number, targets: number[]): string {
  return (
    `#${symbol}/USDT - طويل🟢\n\n` +
    `نقطة الدخول: ${fmtPrice(entry)}\n` +
    `وقف الخسارة: ${fmtPrice(stop)}\n\n` +
    `الهدف 1: ${fmtPrice(targets[0])}\n` +
    `الهدف 2: ${fmtPrice(targets[1])}\n` +
    `الهدف 3: ${fmtPrice(targets[2])}`
  );
}

export const tgSend = (text: string): Promise<boolean> =>
  fetch("/api/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) })
    .then((r) => r.json())
    .then((j) => !!(j as { ok?: boolean })?.ok)
    .catch(() => false);

async function aiText(messages: { role: string; content: string }[]): Promise<string | null> {
  try {
    const j = (await (
      await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }) })
    ).json()) as { text?: string | null };
    return j?.text ?? null;
  } catch {
    return null;
  }
}

/**
 * Market-regime guard: don't open new longs into a broad selloff. Risk-off when
 * BTC is down >4% on the day OR more than 70% of the top-50 are red.
 */
export function marketRiskOff(coins: Coin[]): { off: boolean; redPct: number; btc: number } {
  const top = coins.filter((c) => (c.rank ?? 999) <= 50);
  const btc = coins.find((c) => c.symbol === "BTC")?.change24h ?? 0;
  if (!top.length) return { off: false, redPct: 0, btc };
  const redPct = (top.filter((c) => (c.change24h ?? 0) < 0).length / top.length) * 100;
  return { off: btc < -4 || redPct > 70, redPct, btc };
}

/** The strategy filter: strict, liquid, trend-following dip entries. */
export function selectPicks(coins: Coin[], minConf: number) {
  return coins
    .filter((c) => !isStable(c.symbol) && (c.rank ?? 999) <= 200)
    .map((c) => ({ c, r: scanCoin(c, "day", "spot") }))
    .filter((x) => x.r.signal === "LONG" && x.r.confidence >= minConf && x.r.trend === "up")
    .map((x) => ({ ...x, score: qualityScore(x.r) + liqBonus(x.c.rank) }))
    .sort((a, b) => b.score - a.score);
}

export type IssueResult = { issued: number; comment: string; provider: "ai" | "local" };

/**
 * Enter new positions automatically. Throttled (~4h) unless `force` (manual
 * button). Fills only the free slots of MAX_OPEN. Notifies Telegram.
 */
export async function autoIssue(coins: Coin[], journal: JTrade[], lang: Lang, force = false): Promise<IssueResult> {
  const stats = journalStats(journal);
  const minConf = adaptiveMinConf(stats);
  const openCount = journal.filter((t) => t.status === "open").length;
  const slots = MAX_OPEN - openCount;
  const last = Number(localStorage.getItem(ISSUE_KEY) || "0");
  const none: IssueResult = { issued: 0, comment: "", provider: "local" };

  if (!force && (Date.now() - last < ISSUE_EVERY_MS || slots <= 0)) return none;
  if (!coins.length) return none;

  // Capital protection: skip entirely on risk-off days (no throttle burn — re-checks next tick).
  const regime = marketRiskOff(coins);
  if (regime.off) {
    return force
      ? {
          issued: 0,
          comment:
            lang === "ar"
              ? `السوق في وضع تجنّب المخاطرة (بيتكوين ${regime.btc.toFixed(1)}% · ${regime.redPct.toFixed(0)}% من الكبار بالأحمر). أوقفت الدخول لحماية رأس المال — أفضل صفقة أحياناً هي عدم الدخول.`
              : `Market is risk-off (BTC ${regime.btc.toFixed(1)}% · ${regime.redPct.toFixed(0)}% of majors red). Holding back — sometimes the best trade is no trade.`,
          provider: "local",
        }
      : none;
  }

  const picks = selectPicks(coins, minConf).slice(0, Math.max(slots, force ? 1 : 0));
  try {
    localStorage.setItem(ISSUE_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
  if (!picks.length) {
    return force
      ? { issued: 0, comment: lang === "ar" ? "لا توجد فرص مطابقة للاستراتيجية الآن — ننتظر إعداداً نظيفاً." : "No setups match the strategy right now — waiting for a clean entry.", provider: "local" }
      : none;
  }

  const n = issueTrades(picks.map((p) => p.r));
  if (n === 0) return none;

  const facts = picks
    .map((p, i) => `${i + 1}. ${p.c.symbol} (${p.c.name}) conf ${p.r.confidence}% entry ${formatUsd(p.r.entry)} stop ${formatUsd(p.r.stop)} TPs ${p.r.targets.map((x) => formatUsd(x)).join("/")} RSI ${p.r.indicators.rsi.toFixed(0)}`)
    .join("\n");
  const lsn = getLessons();
  const sys =
    lang === "ar"
      ? "أنت متداول كريبتو آلي يطبّق استراتيجية صارمة: شراء التصحيحات في الاتجاهات الصاعدة، عملات سائلة فقط، بحدّ أقصى ٣ صفقات. اشرح في ٣–٥ جمل لماذا دخلت هذه الصفقات الآن وكيف ستديرها (الوقف والأهداف)، دامجاً معرفتك عن المشاريع. إن وُجدت دروس سابقة فطبّقها. ليست نصيحة مالية."
      : "You are an autonomous crypto trader running a strict strategy: buy dips in uptrends, liquid coins only, max 3 positions. Explain in 3–5 sentences why you entered these now and how you'll manage them (stop/targets), blending your project knowledge. Apply past lessons if any. Not financial advice.";
  const text = await aiText([
    { role: "system", content: sys },
    { role: "system", content: (lang === "ar" ? "الصفقات:\n" : "Entries:\n") + facts + (lsn ? `\n\n${lang === "ar" ? "دروسك السابقة:" : "Past lessons:"}\n${lsn}` : "") },
    { role: "user", content: lang === "ar" ? "لماذا دخلت هذه الصفقات؟" : "Why did you enter these?" },
  ]);
  const comment = text || (lang === "ar" ? `دخلت ${n} صفقات وفق حدّ ثقة ${minConf}%.` : `Entered ${n} positions at a ${minConf}% confidence bar.`);

  // One clean signal card per entry (pro channel style), then the strategy note.
  for (const p of picks) {
    await tgSend(entryCard(p.c.symbol, p.r.entry, p.r.stop, p.r.targets));
  }
  tgSend(`🧠 الاستراتيجية:\n${comment.slice(0, 400)}\n\n⚠️ ليست نصيحة مالية`);

  return { issued: n, comment, provider: text ? "ai" : "local" };
}

export type ReviewResult = { review: string; provider: "ai" | "local" };

/**
 * Self-review: runs automatically when new positions have closed since the
 * last review (or `force` from the page button). Saves lessons + Telegram.
 */
export async function maybeSelfReview(journal: JTrade[], lang: Lang, force = false): Promise<ReviewResult | null> {
  const closed = journal.filter((t) => t.status !== "open");
  if (!closed.length) return null;
  const last = Number(localStorage.getItem(REVIEWED_KEY) || "0");
  if (!force && closed.length <= last) return null;
  try {
    localStorage.setItem(REVIEWED_KEY, String(closed.length)); // one attempt per closure batch
  } catch {
    /* ignore */
  }

  const stats = journalStats(journal);
  const rows = closed.slice(0, 20).map((x) => `${x.symbol} · ${x.status} · ${(x.retPct ?? 0).toFixed(2)}% · conf ${x.confidence}%`).join("\n");
  const summary = `winRate ${stats.winRate.toFixed(0)}% · trades ${stats.closed} · total ${stats.totalPct.toFixed(2)}% · PF ${stats.profitFactor.toFixed(2)}`;
  const sys =
    lang === "ar"
      ? "أنت متداول آلي تراجع صفقاتك المغلقة بنفسك بصراحة تامة. قيّم أداءك: ما الذي نجح؟ ما الذي فشل ولماذا؟ هل هناك نمط في الخسائر؟ ثم اكتب «الدروس:» متبوعة بـ٣–٥ دروس مرقّمة عملية ستطبّقها على صفقاتك القادمة. بالعربية."
      : "You are an autonomous trader candidly reviewing your own closed trades. What worked? What failed and why? Any loss pattern? Then write 'Lessons:' followed by 3–5 numbered actionable lessons for your next entries.";
  const text = await aiText([
    { role: "system", content: sys },
    { role: "system", content: `${summary}\n${rows}` },
    { role: "user", content: lang === "ar" ? "قيّم تداولاتك واستخرج الدروس." : "Review your trades and extract the lessons." },
  ]);
  if (text) {
    const lsn = (text.split(/الدروس:|Lessons:/i)[1] || text).trim();
    setLessons(lsn);
    tgSend(`📊 Alslmany Crypto — تقييم ذاتي تلقائي\n${summary}\n\n📚 الدروس الجديدة:\n${lsn.slice(0, 600)}`);
    return { review: text, provider: "ai" };
  }
  return { review: summary, provider: "local" };
}
