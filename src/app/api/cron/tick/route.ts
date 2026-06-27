import { NextResponse } from "next/server";
import { fetchMarkets } from "@/lib/coingecko";
import { fetchCandles } from "@/lib/candles";
import { analyzeTimeframe, buildRecommendation, STYLE_TF } from "@/lib/signal-engine";
import { storageConfigured, loadJournal, saveJournal, loadMeta, saveMeta, type JTradeS as JTrade } from "@/lib/store";
import type { Coin } from "@/lib/mock-data";

/**
 * FULL autonomous trading loop — runs entirely server-side, so it works 24/7
 * even with no browser open. Triggered by an external scheduler (cron-job.org)
 * every ~1 min. Persists open positions in Upstash/Vercel KV, so it can:
 *   • evaluate every open trade vs live prices → 🎯 target / 🛑 stop / ⚖️ breakeven / ⏰ expiry → Telegram
 *   • enter new high-quality, dual-confirmed setups when slots are free (and the market isn't risk-off) → Telegram
 * Same strategy & quality bars as the in-app trader. Protected by CRON_SECRET.
 *
 * Trigger:  GET /api/cron/tick?key=YOUR_CRON_SECRET
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_OPEN = 3;
const MIN_CONF = 70;
const MIN_RR = 1.45;
const SCAN_UNIVERSE = 18;
const EXPIRE_MS = 7 * 24 * 3600 * 1000;
const STABLES = new Set(["USDT", "USDC", "DAI", "TUSD", "FDUSD", "USDE", "USDS", "BUSD", "PYUSD"]);

/* ---------------- Telegram ---------------- */
async function tg(token: string, chatId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  }).catch(() => {});
}
function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return Number(n.toPrecision(4)).toString();
}
function durAr(ms: number): string {
  const m = Math.max(1, Math.floor(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  const p: string[] = [];
  if (d) p.push(`${d} يوم`);
  if (h) p.push(`${h} ساعة`);
  if (mm || !p.length) p.push(`${mm} دقيقة`);
  return p.join(" ");
}
function entryCard(t: JTrade): string {
  const f = (p: number) => { const v = ((p - t.entry) / t.entry) * 100; return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`; };
  return (
    `#${t.symbol}/USDT - طويل🟢\nالثقة: ${t.confidence}%\n\n` +
    `نقطة الدخول: ${fmtPrice(t.entry)}\n` +
    `وقف الخسارة: ${fmtPrice(t.stop)} (${f(t.stop)})\n\n` +
    `الهدف 1: ${fmtPrice(t.targets[0])} (${f(t.targets[0])})\n` +
    `الهدف 2: ${fmtPrice(t.targets[1])} (${f(t.targets[1])})\n` +
    `الهدف 3: ${fmtPrice(t.targets[2])} (${f(t.targets[2])})\n\n` +
    `🛡️ خاطر بـ١-٢٪ من محفظتك فقط لكل صفقة\n⚠️ ليست نصيحة مالية`
  );
}
function closeMsg(t: JTrade): string {
  const head = `#${t.symbol}/USDT - طويل🟢\n\n`;
  const ret = t.retPct ?? 0;
  const dur = durAr((t.closedAt ?? Date.now()) - t.issuedAt);
  if (t.status === "tp3") return head + `🎯 إغلاق كامل على الهدف 3 ✅\n\nالربح: +${ret.toFixed(2)}% 📈\nفي: ${dur} ⏰`;
  if (t.status === "tp1") return head + `🔒 أُغلقت بربح مضمون (وقف متحرّك على الهدف 1) ✅\n\nالربح: +${ret.toFixed(2)}% 📈\nفي: ${dur} ⏰`;
  if (t.status === "breakeven") return head + `⚖️ أُغلقت عند نقطة الدخول — بلا ربح أو خسارة\n\nفي: ${dur} ⏰`;
  if (t.status === "expired") return head + `⏰ إغلاق زمني (انتهت مهلة ٧ أيام)\n\nالنتيجة: ${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%\nفي: ${dur}`;
  return head + `🛑 تم ضرب وقف الخسارة\n\nالخسارة: ${ret.toFixed(2)}% 📉\nفي: ${dur} ⏰`;
}
function advanceMsg(t: JTrade, level: number, gainPct: number): string {
  const dur = durAr(Date.now() - t.issuedAt);
  const top = `#${t.symbol}/USDT - طويل🟢\n\nتم الوصول إلى الهدف ${level} ✅\n\nالربح حتى الآن: +${gainPct.toFixed(2)}% 📈\nفي: ${dur} ⏰\n\n`;
  return level === 1
    ? top + `🔒 رُفع وقف الخسارة إلى نقطة الدخول — الصفقة الآن بلا مخاطرة.\nمستمرّون نحو الهدف 2 🚀`
    : top + `🔒 رُفع وقف الخسارة إلى الهدف 1 — الربح مضمون.\nمستمرّون نحو الهدف 3 🚀`;
}

/* ---------------- strategy helpers ---------------- */
function marketRiskOff(coins: Coin[]): boolean {
  const top = coins.filter((c) => (c.rank ?? 999) <= 50);
  const btc = coins.find((c) => c.symbol === "BTC")?.change24h ?? 0;
  if (!top.length) return false;
  const redPct = (top.filter((c) => (c.change24h ?? 0) < 0).length / top.length) * 100;
  return btc < -4 || redPct > 70;
}

/** Staged take-profit evaluation (mirrors the in-app evaluateOpen). Mutates journal. */
function evaluateOpen(journal: JTrade[], priceOf: (s: string) => number) {
  const closed: JTrade[] = [];
  const advanced: { t: JTrade; level: number; gain: number }[] = [];
  const warned: JTrade[] = [];
  const now = Date.now();
  for (const t of journal) {
    if (t.status !== "open") continue;
    const p = priceOf(t.symbol);
    if (!p) continue;
    const hit = t.hit ?? 0;
    const close = (status: JTrade["status"], exit: number) => {
      t.status = status; t.closedAt = now; t.exitPrice = exit; t.retPct = ((exit - t.entry) / t.entry) * 100;
      closed.push(t);
    };
    if (p >= t.targets[2]) { close("tp3", t.targets[2]); continue; }
    if (p <= t.stop) { close(hit >= 2 ? "tp1" : hit >= 1 ? "breakeven" : "stopped", t.stop); continue; }
    if (p >= t.targets[1] && hit < 2) { t.hit = 2; t.stop = t.targets[0]; advanced.push({ t, level: 2, gain: ((t.targets[1] - t.entry) / t.entry) * 100 }); continue; }
    if (p >= t.targets[0] && hit < 1) { t.hit = 1; t.stop = t.entry; advanced.push({ t, level: 1, gain: ((t.targets[0] - t.entry) / t.entry) * 100 }); continue; }
    if (now - t.issuedAt > EXPIRE_MS) { close("expired", p); continue; }
    if (!t.warned && hit < 1) {
      const dist = t.entry - t.stop;
      if (dist > 0 && t.entry - p >= dist * 0.7) { t.warned = true; warned.push(t); }
    }
  }
  return { closed, advanced, warned };
}

/* ---------------- main loop ---------------- */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (secret && searchParams.get("key") !== secret && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return NextResponse.json({ ok: false, error: "telegram-not-configured (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)" });
  if (!storageConfigured()) return NextResponse.json({ ok: false, error: "storage-not-configured (set KV_* or GITHUB_STORAGE_TOKEN+GIST_ID)" });

  const markets = await fetchMarkets();
  const priceOf = (s: string) => markets.find((c) => c.symbol === s)?.price ?? 0;
  const journal = await loadJournal();

  // 1) Manage open positions → exits / advances / risk warnings (sent in parallel for speed).
  const { closed, advanced, warned } = evaluateOpen(journal, priceOf);
  await Promise.all([
    ...advanced.map((a) => tg(token, chatId, advanceMsg(a.t, a.level, a.gain))),
    ...closed.map((t) => tg(token, chatId, closeMsg(t))),
    ...warned.map((t) => tg(token, chatId, `#${t.symbol}/USDT - طويل🟢\n\n⚠️ تحذير مخاطرة\nالسعر ${fmtPrice(priceOf(t.symbol))} يقترب من وقف الخسارة ${fmtPrice(t.stop)}\nنقطة الدخول: ${fmtPrice(t.entry)} — راقب الصفقة.`)),
  ]);

  // 2) Enter new high-quality setups when slots are free and market isn't risk-off.
  let entered = 0;
  const openCount = journal.filter((t) => t.status === "open").length;
  const slots = MAX_OPEN - openCount;
  if (slots > 0 && !marketRiskOff(markets)) {
    const universe = markets
      .filter((c) => !STABLES.has(c.symbol) && (c.change24h ?? 0) <= 15 && (c.change24h ?? 0) >= -10)
      .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
      .slice(0, SCAN_UNIVERSE);
    const { ltf, htf } = STYLE_TF.day;
    const recs = await Promise.all(
      universe.map(async (c) => {
        try {
          const [l, h] = await Promise.all([fetchCandles(c.symbol, ltf, 220), fetchCandles(c.symbol, htf, 220)]);
          return buildRecommendation(c.symbol, "day", analyzeTimeframe(ltf, l.candles), analyzeTimeframe(htf, h.candles), l.source, "spot");
        } catch { return null; }
      })
    );
    const openSyms = new Set(journal.filter((t) => t.status === "open").map((t) => t.symbol));
    const picks = recs
      .filter((r): r is NonNullable<typeof r> => !!r && r.signal === "LONG" && r.confidence >= MIN_CONF && r.riskReward >= MIN_RR && r.trend === "up" && !openSyms.has(r.symbol))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, slots);
    const now = Date.now();
    const newTrades = picks.map((r): JTrade => ({ id: `${r.symbol}|${now}`, symbol: r.symbol, entry: r.entry, stop: r.stop, targets: r.targets, confidence: r.confidence, issuedAt: now, status: "open" }));
    for (const t of newTrades) journal.unshift(t);
    // Fire all entry cards in parallel — the alert lands the instant a trade opens.
    await Promise.all(newTrades.map((t) => tg(token, chatId, entryCard(t))));
    entered = newTrades.length;
  }

  await saveJournal(journal);

  // Hourly heartbeat: if nothing happened (no entries/exits) and it's been ≥1h
  // since the last Telegram message, ping "still watching — no setup" so the
  // user knows the bot is alive. Any real trade resets the hourly timer.
  const sentSomething = entered + closed.length + advanced.length + warned.length > 0;
  const openNow = journal.filter((t) => t.status === "open").length;
  let heartbeat = false;
  const meta = await loadMeta();
  const now = Date.now();
  if (sentSomething) {
    meta.lastMsg = now;
    await saveMeta(meta);
  } else if (now - (meta.lastMsg ?? 0) >= 3600_000) {
    const ro = marketRiskOff(markets);
    await tg(
      token,
      chatId,
      `🔍 Alslmany Crypto — تقرير الساعة\n\n${ro ? "السوق هابط عام — أحجم عن الدخول لحماية رأس المال." : "لا توجد فرصة شراء عالية الجودة الآن — أنتظر إعداداً نظيفاً."}\n\n📊 صفقات مفتوحة: ${openNow}\n🛡️ البوت يعمل ويراقب 24/7.`
    );
    meta.lastMsg = now;
    await saveMeta(meta);
    heartbeat = true;
  }

  return NextResponse.json({
    ok: true,
    open: openNow,
    entered,
    closed: closed.length,
    advanced: advanced.length,
    heartbeat,
    riskOff: marketRiskOff(markets),
  });
}
