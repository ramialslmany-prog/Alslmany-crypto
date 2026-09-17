/**
 * Telegram transport.
 *
 * Deliberately thin: it formats, applies the policy, and posts. It does NOT
 * decide what is worth telling the user — the worker does that — and it never
 * throws into the caller. A notification failure must not be able to stop the
 * bot: a trading loop that dies because a chat server was slow is a far worse
 * bug than a missed message, so every failure is logged and swallowed.
 *
 * With no token configured, `send` reports `skipped` rather than failing.
 * Notifications are optional; the bot runs without them.
 */
import { createLogger } from "@/shared/logger";
import type { AppConfig } from "@/shared/config";
import {
  afterSend, decide, emptyPolicyState, parseQuietHours,
  type Notification, type PolicyConfig, type PolicyState,
} from "@/notify/policy";

const log = createLogger("telegram");

export type SendResult =
  | { status: "sent" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/** Telegram's own hard limit on a message body. */
const MAX_LENGTH = 4_096;

/**
 * Escape for Telegram's MarkdownV2.
 *
 * Every one of these characters is special there, and an unescaped one makes
 * the API reject the whole message — which in practice means the alert about
 * a circuit breaker silently never arrives because a price contained a dot.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

export class TelegramNotifier {
  private state: PolicyState = emptyPolicyState();
  private readonly policy: PolicyConfig;
  private readonly token: string | undefined;
  private readonly chatId: string | undefined;

  constructor(private readonly cfg: AppConfig) {
    this.token = cfg.TELEGRAM_BOT_TOKEN;
    this.chatId = cfg.TELEGRAM_CHAT_ID;
    this.policy = {
      quietHours: parseQuietHours(cfg.TELEGRAM_QUIET_HOURS),
      maxPerHour: cfg.TELEGRAM_MAX_PER_HOUR,
      // A day: the same target on the same recommendation is one event, and
      // the worker re-reads it on every candle for as long as it is open.
      dedupeWindowMs: 86_400_000,
    };
  }

  get enabled(): boolean {
    return Boolean(this.token && this.chatId);
  }

  /** Expose the policy decision so the worker can log WHY nothing was sent. */
  async send(notification: Notification): Promise<SendResult> {
    if (!this.enabled) {
      return { status: "skipped", reason: "لا توجد إعدادات تيليجرام (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)" };
    }

    const decision = decide(notification, this.state, this.policy);
    if (!decision.send) {
      log.debug("suppressed", { kind: notification.kind, reason: decision.reason });
      return { status: "skipped", reason: decision.arabic };
    }

    const body = notification.text.length > MAX_LENGTH
      ? `${notification.text.slice(0, MAX_LENGTH - 20)}\n…`
      : notification.text;

    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: body,
          parse_mode: "MarkdownV2",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(this.cfg.HTTP_TIMEOUT_MS),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        log.warn("send failed", { status: res.status, detail: detail.slice(0, 200) });
        return { status: "failed", reason: `HTTP ${res.status}` };
      }

      // State advances only on a CONFIRMED send. Marking it sent on a failure
      // would let the dedupe rule permanently suppress a message that never
      // actually arrived.
      this.state = afterSend(notification, this.state);
      return { status: "sent" };
    } catch (err) {
      log.warn("send threw", { error: String(err) });
      return { status: "failed", reason: String(err) };
    }
  }
}
