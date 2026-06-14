import { NextResponse } from "next/server";
import { fetchMarkets } from "@/lib/coingecko";
import { fetchCandles } from "@/lib/candles";
import { analyzeTimeframe, buildRecommendation, STYLE_TF } from "@/lib/signal-engine";

/**
 * Server-side autonomous scan → Telegram. Runs WITHOUT a browser open, so the
 * best spot setups reach the user 24/7 when triggered by a scheduler
 * (Vercel Cron, cron-job.org, GitHub Actions…). Stateless by design: each run
 * pushes the current top setups. Protected by CRON_SECRET.
 *
 * Trigger:  GET /api/cron/scan?key=YOUR_CRON_SECRET
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STABLES = new Set(["USDT", "USDC", "DAI", "TUSD", "FDUSD", "USDE", "USDS", "BUSD", "PYUSD"]);
const MIN_CONF = 65;
const TOP_N = 3;
const SCAN_UNIVERSE = 18; // most-liquid coins we deep-scan per run

function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return Number(n.toPrecision(4)).toString();
}

function entryCard(symbol: string, entry: number, stop: number, targets: number[], conf: number): string {
  return (
    `#${symbol}/USDT - طويل🟢\n\n` +
    `الثقة: ${conf}%\n` +
    `نقطة الدخول: ${fmtPrice(entry)}\n` +
    `وقف الخسارة: ${fmtPrice(stop)}\n\n` +
    `الهدف 1: ${fmtPrice(targets[0])}\n` +
    `الهدف 2: ${fmtPrice(targets[1])}\n` +
    `الهدف 3: ${fmtPrice(targets[2])}`
  );
}

async function sendTelegram(token: string, chatId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  }).catch(() => {});
}

async function detectChatId(token: string): Promise<string | null> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=10`, { cache: "no-store" });
    const j = (await r.json()) as { result?: { message?: { chat?: { id?: number } } }[] };
    const ups = j?.result ?? [];
    for (let i = ups.length - 1; i >= 0; i--) {
      const id = ups[i]?.message?.chat?.id;
      if (id) return String(id);
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");
  const secret = process.env.CRON_SECRET;
  // If a secret is configured, require it. (Vercel Cron also sends this header.)
  const authHeader = req.headers.get("authorization");
  const viaVercel = secret && authHeader === `Bearer ${secret}`;
  if (secret && key !== secret && !viaVercel) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return NextResponse.json({ ok: false, error: "no-telegram-token" });
  const chatId = process.env.TELEGRAM_CHAT_ID || (await detectChatId(token));
  if (!chatId) return NextResponse.json({ ok: false, error: "no-chat" });

  // Pick the most-liquid, non-stable coins to deep-scan.
  const markets = await fetchMarkets();
  const universe = markets
    .filter((c) => !STABLES.has(c.symbol))
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
    .slice(0, SCAN_UNIVERSE);

  const { ltf, htf } = STYLE_TF.day;
  const recs = await Promise.all(
    universe.map(async (c) => {
      try {
        const [l, h] = await Promise.all([fetchCandles(c.symbol, ltf, 220), fetchCandles(c.symbol, htf, 220)]);
        const rec = buildRecommendation(c.symbol, "day", analyzeTimeframe(ltf, l.candles), analyzeTimeframe(htf, h.candles), l.source, "spot");
        return rec;
      } catch {
        return null;
      }
    })
  );

  const picks = recs
    .filter((r): r is NonNullable<typeof r> => !!r && r.signal === "LONG" && r.confidence >= MIN_CONF)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, TOP_N);

  if (picks.length === 0) {
    await sendTelegram(token, chatId, "🔍 Alslmany Crypto — مسح آلي\nلا توجد فرص شراء عالية الجودة الآن. ننتظر إعداداً أنظف.");
    return NextResponse.json({ ok: true, sent: 0, scanned: universe.length });
  }

  await sendTelegram(token, chatId, `🤖 Alslmany Crypto — مسح آلي (24/7)\nأفضل ${picks.length} فرص شراء الآن:`);
  for (const p of picks) {
    await sendTelegram(token, chatId, entryCard(p.symbol, p.entry, p.stop, p.targets, p.confidence));
  }
  await sendTelegram(token, chatId, "⚠️ ليست نصيحة مالية · إدارة المخاطر مسؤوليتك.");

  return NextResponse.json({
    ok: true,
    sent: picks.length,
    scanned: universe.length,
    picks: picks.map((p) => ({ symbol: p.symbol, confidence: p.confidence })),
  });
}
