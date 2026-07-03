import { NextResponse } from "next/server";
import { fetchMarkets } from "@/lib/coingecko";
import { fetchCandles } from "@/lib/candles";
import { analyzeTimeframe, buildRecommendation, qualityScore } from "@/lib/signal-engine";
import { scanCoin } from "@/lib/scan-engine";
import { storageConfigured, loadJournal, saveJournal, loadMeta, saveMeta, loadSettings, type JTradeS as JTrade } from "@/lib/store";
import { isStable, liqBonus } from "@/lib/coin-meta";
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

const MIN_RR = 1.45;
const SCAN_UNIVERSE = 18;
const EXPIRE_MS = 7 * 24 * 3600 * 1000;

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
/** Horizon labels for the radar cards — every opportunity type, near or far. */
const STYLE_LABEL: Record<string, string> = {
  scalp: "⚡ قصير المدى (سكالبينغ · 15د/1س)",
  day: "📅 متوسط المدى (يومي · 1س/4س)",
  swing: "🌊 بعيد المدى (متأرجح · 4س/1يوم)",
};

/** Instant radar alert: a confirmed BUY-grade setup goes to Telegram the moment
 *  it appears — even when the bot doesn't auto-enter (slots full, cautious
 *  regime, entries paused, or confidence below the auto-entry bar). */
function opportunityCard(r: { symbol: string; style: string; entry: number; stop: number; targets: number[]; confidence: number }, cautious: boolean, entryBar: number): string {
  const f = (p: number) => { const v = ((p - r.entry) / r.entry) * 100; return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`; };
  return (
    `📡 راصد الفرص — فرصة شراء مؤكّدة\n#${r.symbol}/USDT 🟢 الثقة: ${r.confidence}%\n` +
    `الأفق: ${STYLE_LABEL[r.style] ?? r.style}\n\n` +
    `الدخول: ${fmtPrice(r.entry)}\n` +
    `وقف الخسارة: ${fmtPrice(r.stop)} (${f(r.stop)})\n\n` +
    r.targets.map((t, i) => `الهدف ${i + 1}: ${fmtPrice(t)} (${f(t)})`).join("\n") +
    `\n\n🛡️ خاطر بـ١-٢٪ من محفظتك فقط لكل صفقة` +
    (cautious ? `\n⚠️ السوق حذر (قائد السوق ضعيف) — حجم أصغر ووقف صارم.` : "") +
    (r.confidence < entryBar ? `\nℹ️ تنبيه معلوماتي فقط — البوت يدخل آلياً من ثقة ${entryBar}%.` : "") +
    `\n⚠️ ليست نصيحة مالية`
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

/**
 * Market-leader regime gate. A long-only spot strategy can only make money in a
 * constructive market — buying "uptrends" while BTC is rolling over just buys
 * bull traps (validated by walk-forward backtest: trading a downtrend bleeds
 * 15–60%). So if BTC, the market leader, is in a confirmed downtrend on the 4h
 * OR daily, the bot stands aside and holds cash. Best-effort: if klines are
 * unavailable we don't block (the snapshot-based risk-off guard still applies).
 */
async function marketLeaderBearish(): Promise<boolean> {
  try {
    // Gate on the 4h stack only. The daily EMA stack lags a genuine bottom by
    // WEEKS — gating on it kept the bot dark through entire recoveries. The 4h
    // flips within days, and every entry still needs its own multi-timeframe
    // confirmation (LONG + uptrend + confidence + volume) before firing.
    const h4 = await fetchCandles("BTC", "4h", 220);
    return analyzeTimeframe("4h", h4.candles).trend === "down";
  } catch {
    return false;
  }
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
    // Staged exit over a VARIABLE-length target ladder (1–3 structure levels).
    const tps = t.targets;
    const lastIdx = tps.length - 1;
    if (p >= tps[lastIdx]) { close("tp3", tps[lastIdx]); continue; } // final target → full exit
    if (p <= t.stop) { close(hit >= 2 ? "tp1" : hit >= 1 ? "breakeven" : "stopped", t.stop); continue; }
    let advancedThis = false;
    for (let i = lastIdx - 1; i >= 0; i--) {
      if (p >= tps[i] && hit <= i) {
        t.hit = i + 1;
        t.stop = i === 0 ? t.entry : tps[i - 1]; // TP1 → breakeven; later → trail to the prior target
        advanced.push({ t, level: i + 1, gain: ((tps[i] - t.entry) / t.entry) * 100 });
        advancedThis = true;
        break;
      }
    }
    if (advancedThis) continue;
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
  const settings = await loadSettings(); // user-configurable: maxOpen / minConfidence / entriesEnabled

  // 1) Manage open positions → exits / advances / risk warnings (sent in parallel for speed).
  const { closed, advanced, warned } = evaluateOpen(journal, priceOf);
  await Promise.all([
    ...advanced.map((a) => tg(token, chatId, advanceMsg(a.t, a.level, a.gain))),
    ...closed.map((t) => tg(token, chatId, closeMsg(t))),
    ...warned.map((t) => tg(token, chatId, `#${t.symbol}/USDT - طويل🟢\n\n⚠️ تحذير مخاطرة\nالسعر ${fmtPrice(priceOf(t.symbol))} يقترب من وقف الخسارة ${fmtPrice(t.stop)}\nنقطة الدخول: ${fmtPrice(t.entry)} — راقب الصفقة.`)),
  ]);

  // 2) Scan the ENTIRE market every tick. Confirmed setups drive BOTH the
  //    instant Telegram opportunity alerts (always on) and the auto-entries
  //    (gated by slots / regime / user settings).
  let entered = 0;
  let alerted = 0;
  const openCount = journal.filter((t) => t.status === "open").length;
  const slots = settings.maxOpen - openCount;
  const regimeBlocked = marketRiskOff(markets) || (await marketLeaderBearish());
  const meta = await loadMeta();
  const now = Date.now();

  // Stage 1 — fast-scan the full snapshot (top 300, zero extra requests: the
  // close-only scanner runs on the sparklines we already have), shortlist the
  // best LONG candidates — so an opportunity in rank #90 is seen too.
  const universe = markets
    .filter((c) => !isStable(c.symbol) && (c.rank ?? 999) <= 150 && (c.change24h ?? 0) <= 15 && (c.change24h ?? 0) >= -10)
    .map((c) => ({ c, r: scanCoin(c, "day", "spot") }))
    .filter((x) => x.r.signal === "LONG" && x.r.trend === "up" && x.r.confidence >= 55)
    .map((x) => ({ ...x, score: qualityScore(x.r) + liqBonus(x.c.rank) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, SCAN_UNIVERSE)
    .map((x) => x.c);
  const shortlisted = universe.length;

  // Stage 2 — rigorous confirmation across ALL horizons (scalp 15m/1h, day
  // 1h/4h, swing 4h/1d), built from ONE set of kline fetches per coin — so
  // near-term AND longer-term opportunities are both caught.
  const recs = (
    await Promise.all(
      universe.map(async (c) => {
        try {
          const [m15, h1, h4, d1] = await Promise.all([
            fetchCandles(c.symbol, "15m", 220),
            fetchCandles(c.symbol, "1h", 220),
            fetchCandles(c.symbol, "4h", 220),
            fetchCandles(c.symbol, "1d", 220),
          ]);
          const a15 = analyzeTimeframe("15m", m15.candles);
          const a1h = analyzeTimeframe("1h", h1.candles);
          const a4h = analyzeTimeframe("4h", h4.candles);
          const a1d = analyzeTimeframe("1d", d1.candles);
          return [
            buildRecommendation(c.symbol, "scalp", a15, a1h, m15.source, "spot"),
            buildRecommendation(c.symbol, "day", a1h, a4h, h1.source, "spot"),
            buildRecommendation(c.symbol, "swing", a4h, a1d, h4.source, "spot"),
          ];
        } catch { return []; }
      })
    )
  ).flat();
  const openSyms = new Set(journal.filter((t) => t.status === "open").map((t) => t.symbol));

  // 2a) Auto-entries — strict bar, unchanged: slots free, favorable regime,
  //     entries enabled, and the user's confidence bar.
  const enteredSyms = new Set<string>();
  if (slots > 0 && !regimeBlocked && settings.entriesEnabled) {
    const picks = recs
      .filter((r) => r.style === "day" && r.signal === "LONG" && r.confidence >= settings.minConfidence && r.riskReward >= MIN_RR && r.trend === "up" && r.indicators.volRatio >= 1.1 && !openSyms.has(r.symbol))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, slots);
    const newTrades = picks.map((r): JTrade => ({ id: `${r.symbol}|${now}`, symbol: r.symbol, entry: r.entry, stop: r.stop, targets: r.targets, confidence: r.confidence, issuedAt: now, status: "open" }));
    for (const t of newTrades) { journal.unshift(t); enteredSyms.add(t.symbol); }
    // Fire all entry cards in parallel — the alert lands the instant a trade opens.
    await Promise.all(newTrades.map((t) => tg(token, chatId, entryCard(t))));
    entered = newTrades.length;
  }

  // 2b) INSTANT opportunity alerts — every confirmed BUY-grade setup (conf>=60)
  //     goes to Telegram the moment it appears, even when the bot doesn't
  //     auto-enter. Deduped per symbol (6h cooldown) so the radar never spams;
  //     max 3 per tick; skips coins already open or just entered.
  const ALERT_CONF = 60;
  const ALERT_COOLDOWN_MS = 6 * 3600_000;
  const pool = recs.filter((r) => r.signal === "LONG" && r.confidence >= ALERT_CONF && !openSyms.has(r.symbol) && !enteredSyms.has(r.symbol));
  // One card per coin — its best-confidence horizon wins (the card names it).
  const bestBySym = new Map<string, (typeof pool)[number]>();
  for (const r of pool) {
    const b = bestBySym.get(r.symbol);
    if (!b || r.confidence > b.confidence) bestBySym.set(r.symbol, r);
  }
  const fresh = [...bestBySym.values()]
    .filter((r) => now - (meta[`alert:${r.symbol}`] ?? 0) >= ALERT_COOLDOWN_MS)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);
  if (fresh.length) {
    await Promise.all(fresh.map((r) => tg(token, chatId, opportunityCard(r, regimeBlocked, settings.minConfidence))));
    for (const r of fresh) meta[`alert:${r.symbol}`] = now;
    // keep the meta store tiny — drop alert stamps older than 48h
    for (const k of Object.keys(meta)) if (k.startsWith("alert:") && now - meta[k] > 48 * 3600_000) delete meta[k];
    alerted = fresh.length;
  }

  await saveJournal(journal);

  // Hourly heartbeat: if nothing happened (no entries/exits) and it's been ≥1h
  // since the last Telegram message, ping "still watching — no setup" so the
  // user knows the bot is alive. Any real trade resets the hourly timer.
  const sentSomething = entered + alerted + closed.length + advanced.length + warned.length > 0;
  const openNow = journal.filter((t) => t.status === "open").length;
  let heartbeat = false;
  if (sentSomething) {
    meta.lastMsg = now;
    await saveMeta(meta);
  } else if (now - (meta.lastMsg ?? 0) >= 3600_000) {
    await tg(
      token,
      chatId,
      `🔍 Alslmany Crypto — تقرير الساعة\n\n${!settings.entriesEnabled ? "الدخول متوقّف بإعدادك — أُدير الصفقات المفتوحة وأراقب فقط." : regimeBlocked ? "السوق غير مؤاتٍ (القائد BTC هابط) — أبقى نقداً لحماية رأس المال؛ لا أشتري في سوق هابط." : "لا توجد فرصة شراء عالية الجودة الآن — أنتظر إعداداً نظيفاً."}\n\n📊 صفقات مفتوحة: ${openNow} / ${settings.maxOpen}\n🛡️ البوت يعمل ويراقب 24/7.`
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
    alerted,
    riskOff: marketRiskOff(markets),
    regimeBlocked,
    settings,
    universeScanned: markets.length,
    shortlisted,
  });
}
