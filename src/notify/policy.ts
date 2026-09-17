/**
 * When a notification is allowed through.
 *
 * Pure and time-injected, so every rule below is testable without waiting an
 * hour or waiting for midnight. The policy is deliberately separate from the
 * transport: a bug in "should we send this" must be findable without a
 * network, and a Telegram outage must not change which messages were
 * *supposed* to go out.
 *
 * Four rules, in priority order:
 *
 *  1. CRITICAL ALWAYS PASSES. A circuit breaker or a stop being hit reaches
 *     the user at 3am. A notification system that can silently swallow the
 *     message saying the bot has halted is worse than no notifications.
 *  2. DEDUPLICATION. The same event for the same recommendation is sent once.
 *     The worker re-evaluates every candle, so without this the user gets the
 *     same "target 1 hit" every hour until the trade closes.
 *  3. QUIET HOURS. Non-critical messages inside the window are DROPPED, not
 *     queued: a batch of stale alerts arriving at 07:00 about prices from
 *     02:00 is noise that looks like signal.
 *  4. RATE CAP. At most N non-critical messages per rolling hour.
 */

export type NotificationKind =
  | "new_recommendation"
  | "entry_filled"
  | "target_hit"
  | "stop_hit"
  | "invalidated"
  | "expired"
  | "circuit_breaker"
  | "source_failure"
  | "daily_report";

/** The kinds that ignore quiet hours and the rate cap. */
export const CRITICAL: ReadonlySet<NotificationKind> = new Set([
  "circuit_breaker",
  "stop_hit",
]);

export interface Notification {
  readonly kind: NotificationKind;
  /** Stable identity for deduplication, e.g. `target_hit:REC123:2`. */
  readonly dedupeKey: string;
  readonly text: string;
  readonly at: number;
}

export interface PolicyState {
  /** Dedupe keys already sent, with when. */
  readonly sent: ReadonlyMap<string, number>;
  /** Timestamps of non-critical sends, for the rolling hour. */
  readonly recent: readonly number[];
}

export interface QuietHours {
  /** Minutes from UTC midnight. */
  readonly startMinute: number;
  readonly endMinute: number;
}

export interface PolicyConfig {
  readonly quietHours: QuietHours | null;
  readonly maxPerHour: number;
  /** How long a dedupe key is remembered. */
  readonly dedupeWindowMs: number;
}

export type Decision =
  | { send: true }
  | { send: false; reason: "duplicate" | "quiet_hours" | "rate_capped"; arabic: string };

/**
 * Parse "23:00-07:00" into minutes. Returns null for an empty or malformed
 * value — an unparseable quiet-hours setting must mean "no quiet hours",
 * never "silence everything".
 */
export function parseQuietHours(raw: string): QuietHours | null {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [sh, sm, eh, em] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
  const startMinute = sh * 60 + sm;
  const endMinute = eh * 60 + em;
  // An identical start and end would otherwise mean "the whole day".
  return startMinute === endMinute ? null : { startMinute, endMinute };
}

/** True when `at` falls inside the window, handling a window that wraps midnight. */
export function inQuietHours(at: number, q: QuietHours): boolean {
  const d = new Date(at);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  return q.startMinute < q.endMinute
    ? minute >= q.startMinute && minute < q.endMinute
    : minute >= q.startMinute || minute < q.endMinute;
}

export function decide(
  notification: Notification,
  state: PolicyState,
  cfg: PolicyConfig,
): Decision {
  const previous = state.sent.get(notification.dedupeKey);
  if (previous !== undefined && notification.at - previous < cfg.dedupeWindowMs) {
    return {
      send: false,
      reason: "duplicate",
      arabic: `أُرسل هذا الإشعار من قبل (${notification.dedupeKey}) — لا يُكرَّر.`,
    };
  }

  if (CRITICAL.has(notification.kind)) return { send: true };

  if (cfg.quietHours && inQuietHours(notification.at, cfg.quietHours)) {
    return {
      send: false,
      reason: "quiet_hours",
      arabic: "داخل ساعات الصمت — يُسقَط ولا يُؤجَّل، فتنبيه قديم يصل صباحاً يبدو إشارة وهو ضجيج.",
    };
  }

  const hourAgo = notification.at - 3_600_000;
  const inHour = state.recent.filter((t) => t > hourAgo).length;
  if (inHour >= cfg.maxPerHour) {
    return {
      send: false,
      reason: "rate_capped",
      arabic: `بلغ سقف ${cfg.maxPerHour} إشعارات في الساعة — يُسقَط هذا الإشعار غير الحرج.`,
    };
  }

  return { send: true };
}

/** The state after a send. Kept pure so the worker owns persistence. */
export function afterSend(
  notification: Notification,
  state: PolicyState,
): PolicyState {
  const sent = new Map(state.sent);
  sent.set(notification.dedupeKey, notification.at);

  // Only non-critical sends count against the cap — a flood of breakers is a
  // flood the user needs.
  const recent = CRITICAL.has(notification.kind)
    ? state.recent
    : [...state.recent, notification.at];

  const hourAgo = notification.at - 3_600_000;
  return { sent, recent: recent.filter((t) => t > hourAgo) };
}

export const emptyPolicyState = (): PolicyState => ({ sent: new Map(), recent: [] });
