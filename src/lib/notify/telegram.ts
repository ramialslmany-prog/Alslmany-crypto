import "server-only";
import { fmtPrice } from "@/lib/format";
import type { Position, PositionEvent } from "@/lib/bot/types";

/**
 * Telegram delivery.
 *
 * Entirely optional. Without TELEGRAM_BOT_TOKEN every function here becomes a
 * no-op and the product is unaffected — a missing integration must never turn
 * into a failed request or a broken page.
 *
 * The token is read server-side only and is never sent to the browser.
 */

const API = "https://api.telegram.org";

export type TelegramStatus = {
  configured: boolean;
  chatResolved: boolean;
  note: string;
};

function token(): string | null {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  return value && value.trim().length > 10 ? value.trim() : null;
}

/**
 * Resolve the destination chat.
 * An explicit TELEGRAM_CHAT_ID wins; otherwise we look it up from the most
 * recent update, which is what lets a user simply press Start on their bot
 * and be done.
 */
async function resolveChatId(botToken: string): Promise<string | null> {
  const explicit = process.env.TELEGRAM_CHAT_ID?.trim();
  if (explicit) return explicit;

  try {
    const res = await fetch(`${API}/bot${botToken}/getUpdates?limit=1&offset=-1`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      ok: boolean;
      result?: { message?: { chat?: { id?: number } } }[];
    };
    const id = body.result?.[0]?.message?.chat?.id;
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

export async function telegramStatus(): Promise<TelegramStatus> {
  const botToken = token();
  if (!botToken) {
    return { configured: false, chatResolved: false, note: "TELEGRAM_BOT_TOKEN not set" };
  }
  const chatId = await resolveChatId(botToken);
  return {
    configured: true,
    chatResolved: chatId !== null,
    note: chatId ? "ready" : "press Start on your bot once so it can find your chat",
  };
}

async function send(text: string): Promise<boolean> {
  const botToken = token();
  if (!botToken) return false;
  const chatId = await resolveChatId(botToken);
  if (!chatId) return false;

  try {
    const res = await fetch(`${API}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    // A messaging outage is not a trading error. Swallow it.
    return false;
  }
}

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Entry card. Carries the invalidation level, never just the upside. */
export function formatEntry(position: Position): string {
  const targets = position.targets
    .map((t, i) => `الهدف ${i + 1}: <code>${fmtPrice(t.price)}</code>  (${t.rMultiple}R · ${t.allocationPct}%)`)
    .join("\n");

  return [
    `🟢 <b>#${escape(position.symbol)}/USDT — دخول</b>`,
    "",
    `الدخول: <code>${fmtPrice(position.entry)}</code>`,
    `وقف الخسارة: <code>${fmtPrice(position.initialStop)}</code>`,
    "",
    targets,
    "",
    `التصنيف: ${position.thesis.grade} · الثقة: ${position.thesis.confidence}%`,
    `المخاطرة: ${position.riskPct}% من المحفظة · الحجم: ${position.sizePct}%`,
    position.thesis.warnings.length ? `\n⚠️ ${position.thesis.warnings.length} تنبيه — راجعها في المنصة` : "",
    "",
    "<i>تداول ورقي تعليمي — ليست نصيحة مالية</i>",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Exit card. Losses are reported exactly as prominently as wins. */
export function formatExit(position: Position): string {
  const won = position.realizedR > 0.02;
  const flat = Math.abs(position.realizedR) <= 0.02;
  const icon = flat ? "⚪" : won ? "✅" : "🔻";
  const hours = position.closedAt
    ? Math.round((position.closedAt - position.openedAt) / 3_600_000)
    : 0;

  const reasonAr: Record<string, string> = {
    target: "بلوغ الهدف",
    stop: "وقف الخسارة",
    breakeven: "نقطة التعادل",
    trailing: "الوقف المتحرك",
    time: "خروج زمني",
    regime: "تغيّر حالة السوق",
    manual: "إغلاق يدوي",
  };

  return [
    `${icon} <b>#${escape(position.symbol)}/USDT — إغلاق</b>`,
    "",
    `النتيجة: <code>${position.realizedR > 0 ? "+" : ""}${position.realizedR.toFixed(2)}R</code>  (${position.realizedPct > 0 ? "+" : ""}${position.realizedPct.toFixed(2)}%)`,
    `السبب: ${reasonAr[position.exitReason ?? "manual"] ?? position.exitReason}`,
    `المدة: ${hours} ساعة`,
    "",
    "<i>تداول ورقي تعليمي — ليست نصيحة مالية</i>",
  ].join("\n");
}

export async function notifyEntry(position: Position): Promise<boolean> {
  return send(formatEntry(position));
}

export async function notifyExit(position: Position): Promise<boolean> {
  return send(formatExit(position));
}

/** Batch a tick's events into one message rather than a burst of pings. */
export async function notifyTick(
  opened: Position[],
  closed: Position[],
  _events: PositionEvent[],
): Promise<number> {
  if (!token()) return 0;
  let sent = 0;
  for (const position of opened) if (await notifyEntry(position)) sent++;
  for (const position of closed) if (await notifyExit(position)) sent++;
  return sent;
}

export async function sendTest(): Promise<boolean> {
  return send(
    [
      "🔔 <b>السلماني كريبتو</b>",
      "",
      "تم ربط البوت بنجاح. ستصلك بطاقات الدخول والخروج هنا.",
      "",
      "<i>تداول ورقي تعليمي — ليست نصيحة مالية</i>",
    ].join("\n"),
  );
}
