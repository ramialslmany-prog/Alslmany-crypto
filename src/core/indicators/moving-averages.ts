/**
 * Moving averages.
 *
 * Three smoothings, and the difference between them is not cosmetic — using
 * the wrong one makes our RSI disagree with every chart the user can see:
 *   SMA  — plain window mean
 *   EMA  — weight 2/(n+1), seeded with the SMA of the first n values
 *   RMA  — Wilder's smoothing, weight 1/n, also SMA-seeded. RSI, ATR and ADX
 *          are all defined in terms of RMA, never EMA.
 */
import { type Series, filled } from "@/core/indicators/series";

/** Simple moving average. First value at index `period - 1`. */
export function sma(values: readonly number[], period: number): Series {
  const out = filled(values.length);
  if (period <= 0) return out;

  let sum = 0;
  let count = 0; // finite values currently inside the window

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      sum += v;
      count++;
    }
    if (i >= period) {
      const drop = values[i - period];
      if (Number.isFinite(drop)) {
        sum -= drop;
        count--;
      }
    }
    // Only emit once the whole window is finite — a partial window would be
    // an average of fewer bars than advertised.
    if (i >= period - 1 && count === period) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period`
 * finite values (TradingView's behaviour).
 *
 * Leading NaNs are tolerated so this composes: the MACD signal line is an EMA
 * of the MACD line, which itself starts with NaNs.
 */
export function ema(values: readonly number[], period: number): Series {
  const out = filled(values.length);
  if (period <= 0) return out;

  const k = 2 / (period + 1);
  let prev = NaN;
  let seedSum = 0;
  let seedCount = 0;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;

    if (!Number.isFinite(prev)) {
      seedSum += v;
      seedCount++;
      if (seedCount === period) {
        prev = seedSum / period;
        out[i] = prev;
      }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/**
 * Wilder's smoothing (RMA / SMMA). Equivalent to an EMA with alpha = 1/period,
 * seeded with an SMA.
 *
 * This is the one that matters for matching a chart: RSI(14) built on EMA(14)
 * instead of RMA(14) is a different, more jittery indicator that will disagree
 * with TradingView by several points at turning points.
 */
export function rma(values: readonly number[], period: number): Series {
  const out = filled(values.length);
  if (period <= 0) return out;

  const alpha = 1 / period;
  let prev = NaN;
  let seedSum = 0;
  let seedCount = 0;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;

    if (!Number.isFinite(prev)) {
      seedSum += v;
      seedCount++;
      if (seedCount === period) {
        prev = seedSum / period;
        out[i] = prev;
      }
    } else {
      prev = v * alpha + prev * (1 - alpha);
      out[i] = prev;
    }
  }
  return out;
}

/** Linearly weighted moving average — heaviest weight on the newest bar. */
export function wma(values: readonly number[], period: number): Series {
  const out = filled(values.length);
  if (period <= 0) return out;
  const denom = (period * (period + 1)) / 2;

  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let ok = true;
    for (let k = 0; k < period; k++) {
      const v = values[i - period + 1 + k];
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      sum += v * (k + 1);
    }
    if (ok) out[i] = sum / denom;
  }
  return out;
}

export type MaKind = "sma" | "ema" | "rma" | "wma";

export function movingAverage(values: readonly number[], period: number, kind: MaKind): Series {
  switch (kind) {
    case "sma":
      return sma(values, period);
    case "ema":
      return ema(values, period);
    case "rma":
      return rma(values, period);
    case "wma":
      return wma(values, period);
  }
}
