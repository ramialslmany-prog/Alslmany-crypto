/**
 * Momentum indicators: RSI, MACD, Stochastic.
 *
 * All three are defined here exactly as TradingView computes them, because the
 * user will compare our readings against a chart. A "close enough"
 * implementation that disagrees by two points destroys trust in every number
 * on the site, however sound the logic above it is.
 */
import { ema, rma, sma } from "@/core/indicators/moving-averages";
import { type Series, change, filled, highest, lowest } from "@/core/indicators/series";

/**
 * Wilder's RSI.
 *
 *   RSI = 100 - 100 / (1 + RMA(gain, n) / RMA(loss, n))
 *
 * First value lands at index `period` — gains start at index 1, and the RMA
 * seed consumes `period` of them.
 *
 * The zero-loss case is 100 by definition (an unbroken run of up bars), not a
 * division by infinity.
 */
export function rsi(values: readonly number[], period = 14): Series {
  const out = filled(values.length);
  const ch = change(values);

  const gains = ch.map((c) => (Number.isFinite(c) ? Math.max(0, c) : NaN));
  const losses = ch.map((c) => (Number.isFinite(c) ? Math.max(0, -c) : NaN));

  const avgGain = rma(gains, period);
  const avgLoss = rma(losses, period);

  for (let i = 0; i < values.length; i++) {
    const g = avgGain[i];
    const l = avgLoss[i];
    if (!Number.isFinite(g) || !Number.isFinite(l)) continue;
    if (l === 0) {
      out[i] = g === 0 ? 50 : 100; // flat stretch reads neutral, not overbought
      continue;
    }
    out[i] = 100 - 100 / (1 + g / l);
  }
  return out;
}

export interface MacdResult {
  readonly macd: Series;
  readonly signal: Series;
  readonly histogram: Series;
}

/**
 * MACD. Default 12/26/9 on EMAs (not RMAs).
 *
 * The histogram's own slope is kept by callers as "acceleration": a shrinking
 * positive histogram means the trend is still up but decelerating, which is a
 * different message from a negative one.
 */
export function macd(
  values: readonly number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);

  const line = filled(values.length);
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(fast[i]) && Number.isFinite(slow[i])) line[i] = fast[i] - slow[i];
  }

  const signal = ema(line, signalPeriod);

  const histogram = filled(values.length);
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(line[i]) && Number.isFinite(signal[i])) histogram[i] = line[i] - signal[i];
  }

  return { macd: line, signal, histogram };
}

export interface StochasticResult {
  readonly k: Series;
  readonly d: Series;
}

/**
 * Stochastic oscillator.
 *
 *   raw %K = 100 * (close - lowest(low, n)) / (highest(high, n) - lowest(low, n))
 *   %K     = SMA(raw %K, smoothK)
 *   %D     = SMA(%K, smoothD)
 *
 * A perfectly flat window (high === low) has no defined position, so it reads
 * 50 rather than dividing by zero.
 */
export function stochastic(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  period = 14,
  smoothK = 3,
  smoothD = 3,
): StochasticResult {
  const hh = highest(high, period);
  const ll = lowest(low, period);
  const raw = filled(close.length);

  for (let i = 0; i < close.length; i++) {
    if (!Number.isFinite(hh[i]) || !Number.isFinite(ll[i]) || !Number.isFinite(close[i])) continue;
    const span = hh[i] - ll[i];
    raw[i] = span === 0 ? 50 : ((close[i] - ll[i]) / span) * 100;
  }

  const k = smoothK > 1 ? sma(raw, smoothK) : raw;
  return { k, d: sma(k, smoothD) };
}

/** Momentum as a plain difference over `period` bars. */
export function momentum(values: readonly number[], period = 10): Series {
  const out = filled(values.length);
  for (let i = period; i < values.length; i++) {
    if (Number.isFinite(values[i]) && Number.isFinite(values[i - period])) {
      out[i] = values[i] - values[i - period];
    }
  }
  return out;
}

export type CrossDirection = "bullish" | "bearish" | "none";

/**
 * Did `fast` cross `slow` on the LAST bar of the series?
 *
 * Deliberately answers about one bar only. "Crossed at some point recently" is
 * a different question, and conflating them is how a stale crossover gets
 * traded three bars late.
 */
export function crossAt(fast: Series, slow: Series, index: number): CrossDirection {
  if (index < 1) return "none";
  const f0 = fast[index - 1];
  const s0 = slow[index - 1];
  const f1 = fast[index];
  const s1 = slow[index];
  if (![f0, s0, f1, s1].every(Number.isFinite)) return "none";
  if (f0 <= s0 && f1 > s1) return "bullish";
  if (f0 >= s0 && f1 < s1) return "bearish";
  return "none";
}

/** Bars since the most recent cross, or null if none within `lookback`. */
export function barsSinceCross(
  fast: Series,
  slow: Series,
  lookback = 50,
): { direction: CrossDirection; barsAgo: number } | null {
  const end = fast.length - 1;
  for (let i = end; i > Math.max(0, end - lookback); i--) {
    const c = crossAt(fast, slow, i);
    if (c !== "none") return { direction: c, barsAgo: end - i };
  }
  return null;
}
