/**
 * Shared conventions for every indicator in this system.
 *
 * ALIGNMENT CONTRACT: every function returns an array the SAME LENGTH as its
 * input, with `NaN` for the warm-up period. Index i of any output therefore
 * always refers to candle i. Returning a shortened array is the classic way
 * indicator values silently drift one bar against the price — and a one-bar
 * drift on a 200-period average corrupts every decision built on top of it
 * without ever looking wrong.
 *
 * SEEDING: the recursive averages (EMA, Wilder's RMA) are seeded with a simple
 * average of the first `period` values, which is what TradingView does. Seeding
 * with the first value instead — a common shortcut — produces visibly different
 * numbers for hundreds of bars and would make our readings disagree with the
 * chart the user is looking at.
 */
import type { Candle } from "@/core/types";

/** A same-length numeric series, NaN during warm-up. */
export type Series = number[];

export function filled(length: number): Series {
  return new Array<number>(length).fill(NaN);
}

export const closes = (c: readonly Candle[]): Series => c.map((x) => x.close);
export const highs = (c: readonly Candle[]): Series => c.map((x) => x.high);
export const lows = (c: readonly Candle[]): Series => c.map((x) => x.low);
export const opens = (c: readonly Candle[]): Series => c.map((x) => x.open);
export const volumes = (c: readonly Candle[]): Series => c.map((x) => x.volume);

/** (high + low + close) / 3 — the "typical price" used by VWAP and MFI. */
export const hlc3 = (c: readonly Candle[]): Series =>
  c.map((x) => (x.high + x.low + x.close) / 3);

/** (high + low) / 2 — the midpoint Ichimoku is built from. */
export const hl2 = (c: readonly Candle[]): Series => c.map((x) => (x.high + x.low) / 2);

/** Last finite value of a series, or NaN when it never warmed up. */
export function lastValue(s: Series): number {
  for (let i = s.length - 1; i >= 0; i--) {
    if (Number.isFinite(s[i])) return s[i];
  }
  return NaN;
}

/** Value `n` bars back from the end. `at(s, 0)` is the last bar. */
export function at(s: Series, n: number): number {
  const i = s.length - 1 - n;
  return i >= 0 ? s[i] : NaN;
}

/** Highest value in the trailing `period` window ending at each index. */
export function highest(values: readonly number[], period: number): Series {
  const out = filled(values.length);
  if (period <= 0) return out;
  for (let i = period - 1; i < values.length; i++) {
    let max = -Infinity;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      if (v > max) max = v;
    }
    if (ok) out[i] = max;
  }
  return out;
}

/** Lowest value in the trailing `period` window ending at each index. */
export function lowest(values: readonly number[], period: number): Series {
  const out = filled(values.length);
  if (period <= 0) return out;
  for (let i = period - 1; i < values.length; i++) {
    let min = Infinity;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      if (v < min) min = v;
    }
    if (ok) out[i] = min;
  }
  return out;
}

/**
 * Shift a series forward (positive) or backward (negative) in time.
 * Ichimoku's cloud is the reason this exists: leading spans are plotted 26
 * bars ahead, lagging span 26 bars behind.
 */
export function shift(values: readonly number[], by: number): Series {
  const out = filled(values.length);
  for (let i = 0; i < values.length; i++) {
    const src = i - by;
    if (src >= 0 && src < values.length) out[i] = values[src];
  }
  return out;
}

/** Bar-over-bar change. Index 0 is NaN (there is no previous bar). */
export function change(values: readonly number[]): Series {
  const out = filled(values.length);
  for (let i = 1; i < values.length; i++) out[i] = values[i] - values[i - 1];
  return out;
}

/** Percentage change over `period` bars (Rate of Change). */
export function roc(values: readonly number[], period: number): Series {
  const out = filled(values.length);
  for (let i = period; i < values.length; i++) {
    const prev = values[i - period];
    if (Number.isFinite(prev) && prev !== 0 && Number.isFinite(values[i])) {
      out[i] = ((values[i] - prev) / prev) * 100;
    }
  }
  return out;
}

/**
 * Where `value` sits inside its own trailing history, as 0..1.
 *
 * Used everywhere a raw reading is meaningless without context: an ATR of 350
 * says nothing, "ATR in the 92nd percentile of the last year" says the market
 * is unusually volatile for THIS asset.
 */
export function percentileRank(history: readonly number[], value: number): number {
  const finite = history.filter(Number.isFinite);
  if (finite.length === 0 || !Number.isFinite(value)) return NaN;
  let below = 0;
  for (const v of finite) if (v < value) below++;
  return below / finite.length;
}

/** Population standard deviation over a trailing window (TradingView's ta.stdev). */
export function stdev(values: readonly number[], period: number): Series {
  const out = filled(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      if (!Number.isFinite(values[j])) {
        ok = false;
        break;
      }
      sum += values[j];
    }
    if (!ok) continue;
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (values[j] - mean) ** 2;
    // Population (divide by N), not sample (N-1) — this is what Bollinger
    // Bands use, and a sample stdev would make our bands visibly wider.
    out[i] = Math.sqrt(sq / period);
  }
  return out;
}

/**
 * Slope of a least-squares fit over the trailing window, expressed as PERCENT
 * OF PRICE PER BAR so it is comparable across assets priced at $0.40 and
 * $70,000.
 */
export function slopePct(values: readonly number[], period: number): Series {
  const out = filled(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    let ok = true;
    for (let k = 0; k < period; k++) {
      const y = values[i - period + 1 + k];
      if (!Number.isFinite(y)) {
        ok = false;
        break;
      }
      sumX += k;
      sumY += y;
      sumXY += k * y;
      sumXX += k * k;
    }
    if (!ok) continue;
    const denom = period * sumXX - sumX * sumX;
    if (denom === 0) continue;
    const slope = (period * sumXY - sumX * sumY) / denom;
    const mean = sumY / period;
    if (mean !== 0) out[i] = (slope / mean) * 100;
  }
  return out;
}
