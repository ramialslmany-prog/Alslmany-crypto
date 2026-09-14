/**
 * Candle-time arithmetic.
 *
 * NON-NEGOTIABLE RULE #1: every calculation in this system runs on CLOSED
 * candles only. The in-flight candle is display-only. A single leaked
 * forming candle silently biases every indicator above it, so the boundary
 * between "closed" and "forming" lives here and nowhere else.
 *
 * All timestamps are epoch milliseconds, UTC. No local timezone ever enters.
 */

export const TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d", "1w"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Ordered low → high. Used by the flow rule: higher TF dictates direction. */
export const TF_ORDER: readonly Timeframe[] = TIMEFRAMES;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Epoch (1970-01-01) was a Thursday, but exchange weekly candles open on
 * Monday 00:00 UTC. 1970-01-05 was the first Monday.
 */
const MONDAY_EPOCH_OFFSET = 4 * DAY;

const TF_MS: Record<Timeframe, number> = {
  "5m": 5 * MINUTE,
  "15m": 15 * MINUTE,
  "1h": HOUR,
  "4h": 4 * HOUR,
  "1d": DAY,
  "1w": WEEK,
};

export function tfMillis(tf: Timeframe): number {
  return TF_MS[tf];
}

export function isTimeframe(v: string): v is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(v);
}

/** Index of a timeframe in the low→high ladder. */
export function tfIndex(tf: Timeframe): number {
  return TF_ORDER.indexOf(tf);
}

/** How many ladder steps apart two timeframes are (always >= 0). */
export function tfDistance(a: Timeframe, b: Timeframe): number {
  return Math.abs(tfIndex(a) - tfIndex(b));
}

/**
 * The open time of the candle that CONTAINS `ts`.
 *
 * 5m/15m/1h/4h/1d all tile cleanly from the epoch (which is 00:00 UTC), so a
 * plain floor is correct. 1w needs the Monday offset.
 */
export function candleOpenTime(ts: number, tf: Timeframe): number {
  const size = TF_MS[tf];
  if (tf === "1w") {
    return Math.floor((ts - MONDAY_EPOCH_OFFSET) / size) * size + MONDAY_EPOCH_OFFSET;
  }
  return Math.floor(ts / size) * size;
}

/** Exclusive end of the candle containing `ts` — i.e. the next candle's open. */
export function candleCloseTime(ts: number, tf: Timeframe): number {
  return candleOpenTime(ts, tf) + TF_MS[tf];
}

/**
 * Open time of the most recent candle that has FULLY CLOSED at `now`.
 *
 * A candle is closed once wall-clock has passed its close time. The candle
 * containing `now` is still forming, so we step back exactly one.
 */
export function lastClosedOpenTime(now: number, tf: Timeframe): number {
  return candleOpenTime(now, tf) - TF_MS[tf];
}

/**
 * True when a candle opened at `openTime` has fully closed at `now`.
 * Strict `<=` on the close boundary: a candle that closes at exactly `now`
 * IS closed, because its interval is [open, close).
 */
export function isCandleClosed(openTime: number, tf: Timeframe, now: number): boolean {
  return openTime + TF_MS[tf] <= now;
}

/**
 * Drop any not-yet-closed candle from the tail of a series.
 *
 * This is the single chokepoint every data path must pass through before an
 * indicator sees a series. Exchanges happily return the forming candle as the
 * last element; this removes it.
 */
export function dropUnclosed<T extends { openTime: number }>(
  candles: T[],
  tf: Timeframe,
  now: number,
): T[] {
  let end = candles.length;
  while (end > 0 && !isCandleClosed(candles[end - 1].openTime, tf, now)) end--;
  return end === candles.length ? candles : candles.slice(0, end);
}

/**
 * How many candles of `tf` are missing between two open times.
 * 0 means contiguous. Used by the gap detector on the health page.
 */
export function candleGap(prevOpen: number, nextOpen: number, tf: Timeframe): number {
  const step = TF_MS[tf];
  return Math.round((nextOpen - prevOpen) / step) - 1;
}

/** Age of the freshest closed candle, in candle-widths. >1 means we are behind. */
export function stalenessInBars(latestOpenTime: number, tf: Timeframe, now: number): number {
  return (lastClosedOpenTime(now, tf) - latestOpenTime) / TF_MS[tf];
}

/** UTC "YYYY-MM-DD" — the key format used by the Binance Vision daily archive. */
export function utcDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** UTC "YYYY-MM" — the key format used by the Binance Vision monthly archive. */
export function utcMonthKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

/** Start-of-month timestamp (UTC) for a "YYYY-MM" key. */
export function monthKeyToTs(key: string): number {
  return Date.parse(`${key}-01T00:00:00.000Z`);
}

/** Every "YYYY-MM" key from `from` to `to` inclusive. */
export function monthKeysBetween(from: number, to: number): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), 1));
  const end = new Date(Date.UTC(new Date(to).getUTCFullYear(), new Date(to).getUTCMonth(), 1));
  while (d.getTime() <= end.getTime()) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

/** Every "YYYY-MM-DD" key from `from` to `to` inclusive. */
export function dayKeysBetween(from: number, to: number): string[] {
  const out: string[] = [];
  for (let t = candleOpenTime(from, "1d"); t <= to; t += DAY) out.push(utcDateKey(t));
  return out;
}
