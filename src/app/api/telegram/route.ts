import { NextResponse } from "next/server";

/**
 * Telegram bridge (no backend needed — calls the Bot API directly).
 * Setup: create a bot with @BotFather, put TELEGRAM_BOT_TOKEN in .env.local,
 * send /start to your bot once. TELEGRAM_CHAT_ID is optional — if missing we
 * auto-detect it from getUpdates (your last message to the bot).
 *
 * GET  → config status { configured, bot, reason }
 * POST → { text } → sends the message to your chat.
 */
export const dynamic = "force-dynamic";

const API = (t: string) => `https://api.telegram.org/bot${t}`;

async function detectChatId(token: string): Promise<string | null> {
  try {
    const r = await fetch(`${API(token)}/getUpdates?limit=10`, { cache: "no-store" });
    const j = (await r.json()) as { result?: { message?: { chat?: { id?: number } }; channel_post?: { chat?: { id?: number } } }[] };
    const ups = j?.result ?? [];
    for (let i = ups.length - 1; i >= 0; i--) {
      const id = ups[i]?.message?.chat?.id ?? ups[i]?.channel_post?.chat?.id;
      if (id) return String(id);
    }
  } catch {
    /* network */
  }
  return null;
}

export async function GET() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return NextResponse.json({ configured: false, reason: "no-token" });
  try {
    const me = (await (await fetch(`${API(token)}/getMe`, { cache: "no-store" })).json()) as { ok?: boolean; result?: { username?: string } };
    if (!me?.ok) return NextResponse.json({ configured: false, reason: "bad-token" });
    const chatId = process.env.TELEGRAM_CHAT_ID || (await detectChatId(token));
    return NextResponse.json({
      configured: !!chatId,
      bot: me.result?.username ?? null,
      reason: chatId ? null : "no-chat", // user must send /start to the bot once
    });
  } catch {
    return NextResponse.json({ configured: false, reason: "network" });
  }
}

export async function POST(req: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return NextResponse.json({ ok: false, reason: "no-token" });
  let text = "";
  try {
    ({ text } = (await req.json()) as { text: string });
  } catch {
    /* bad body */
  }
  if (!text) return NextResponse.json({ ok: false, reason: "no-text" });
  const chatId = process.env.TELEGRAM_CHAT_ID || (await detectChatId(token));
  if (!chatId) return NextResponse.json({ ok: false, reason: "no-chat" });
  try {
    const r = await fetch(`${API(token)}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    const j = (await r.json()) as { ok?: boolean };
    return NextResponse.json({ ok: !!j?.ok });
  } catch {
    return NextResponse.json({ ok: false, reason: "send-failed" });
  }
}
