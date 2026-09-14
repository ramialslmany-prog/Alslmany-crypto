/**
 * NON-NEGOTIABLE RULE #3: never invent a value for a source that is not
 * available. Every provider returns this envelope, so "I don't know" is a
 * first-class value that the type system forces callers to handle — it can
 * never silently decay into 0, null, or a plausible-looking default.
 *
 * `unavailable` also carries a machine-readable reason so the health page and
 * the confidence penalty can both explain themselves in Arabic.
 */

export type UnavailableReason =
  | "not_configured" // no API key / provider disabled in settings
  | "rate_limited"
  | "network_error"
  | "http_error"
  | "bad_response" // reached it, could not parse it
  | "unsupported_symbol"
  | "stale" // we have data, but it is too old to trust
  | "insufficient_history"
  | "timeout"
  | "not_implemented";

/** Arabic copy for the health page and the recommendation report. */
export const REASON_AR: Record<UnavailableReason, string> = {
  not_configured: "غير مُفعَّل — لا يوجد مفتاح في الإعدادات",
  rate_limited: "تجاوز حدّ الطلبات",
  network_error: "تعذّر الاتصال بالشبكة",
  http_error: "المصدر ردّ بخطأ",
  bad_response: "ردّ غير مفهوم من المصدر",
  unsupported_symbol: "العملة غير مدعومة في هذا المصدر",
  stale: "البيانات متأخّرة أكثر من الحدّ المسموح",
  insufficient_history: "التاريخ المتاح غير كافٍ للحساب",
  timeout: "انتهت مهلة الانتظار",
  not_implemented: "غير مُنفَّذ بعد",
};

export interface Available<T> {
  readonly available: true;
  readonly value: T;
  /** When the underlying data was produced (not when we fetched it). */
  readonly asOf: number;
  /** Where it came from — shown verbatim on the health page. */
  readonly source: string;
}

export interface Unavailable {
  readonly available: false;
  readonly reason: UnavailableReason;
  /** Free-text detail for logs; never shown as if it were data. */
  readonly detail?: string;
  readonly source: string;
}

export type Availability<T> = Available<T> | Unavailable;

export function available<T>(value: T, source: string, asOf: number): Available<T> {
  return { available: true, value, asOf, source };
}

export function unavailable(
  source: string,
  reason: UnavailableReason,
  detail?: string,
): Unavailable {
  return { available: false, reason, detail, source };
}

export function isAvailable<T>(a: Availability<T>): a is Available<T> {
  return a.available;
}

/** Arabic one-liner describing why something is missing. */
export function describeUnavailable(u: Unavailable): string {
  return `${u.source}: ${REASON_AR[u.reason]}`;
}

/** Map the value while preserving the unavailable branch untouched. */
export function mapAvailability<T, U>(
  a: Availability<T>,
  fn: (value: T, asOf: number) => U,
): Availability<U> {
  return a.available ? available(fn(a.value, a.asOf), a.source, a.asOf) : a;
}

/** The value, or `undefined`. Use ONLY where absence is genuinely optional. */
export function valueOrUndefined<T>(a: Availability<T>): T | undefined {
  return a.available ? a.value : undefined;
}

/**
 * Mark an available value as stale if it is older than `maxAgeMs`.
 * Freshness is an input to the confidence score, so it is enforced centrally.
 */
export function requireFresh<T>(
  a: Availability<T>,
  maxAgeMs: number,
  now: number,
): Availability<T> {
  if (!a.available) return a;
  const age = now - a.asOf;
  if (age > maxAgeMs) {
    return unavailable(
      a.source,
      "stale",
      `عمر البيانات ${Math.round(age / 1000)}ث والحدّ ${Math.round(maxAgeMs / 1000)}ث`,
    );
  }
  return a;
}
