/**
 * Volatility: True Range / ATR, Bollinger Bands, and the squeeze detector.
 */
import { ema, rma, sma } from "@/core/indicators/moving-averages";
import { type Series, filled, percentileRank, stdev } from "@/core/indicators/series";
import type { Candle } from "@/core/types";

/**
 * True Range. Index 0 is high - low, because there is no previous close to
 * gap from.
 */
export function trueRange(candles: readonly Candle[]): Series {
  const out = filled(candles.length);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      out[i] = c.high - c.low;
      continue;
    }
    const prevClose = candles[i - 1].close;
    out[i] = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
  }
  return out;
}

/** Wilder's ATR: RMA of true range. NOT an EMA. */
export function atr(candles: readonly Candle[], period = 14): Series {
  return rma(trueRange(candles), period);
}

/** ATR as a percentage of price — comparable across assets of any price. */
export function atrPercent(candles: readonly Candle[], period = 14): Series {
  const a = atr(candles, period);
  const out = filled(candles.length);
  for (let i = 0; i < candles.length; i++) {
    const close = candles[i].close;
    if (Number.isFinite(a[i]) && close > 0) out[i] = (a[i] / close) * 100;
  }
  return out;
}

/**
 * Where current ATR sits inside its own trailing history, 0..1.
 *
 * The raw number is meaningless on its own. "ATR is 350" says nothing;
 * "ATR is in the 4th percentile of the last year" says this market is coiled.
 */
export function atrPercentile(
  candles: readonly Candle[],
  period = 14,
  lookback = 252,
): Series {
  const a = atr(candles, period);
  const out = filled(candles.length);
  for (let i = 0; i < candles.length; i++) {
    if (!Number.isFinite(a[i])) continue;
    const from = Math.max(0, i - lookback + 1);
    const window = a.slice(from, i + 1).filter(Number.isFinite);
    // Demand a meaningful sample before claiming a percentile.
    if (window.length < Math.min(30, lookback)) continue;
    out[i] = percentileRank(window, a[i]);
  }
  return out;
}

export interface BollingerResult {
  readonly upper: Series;
  readonly middle: Series;
  readonly lower: Series;
  /** (upper - lower) / middle — the width that defines a squeeze. */
  readonly bandwidth: Series;
  /** 0 at the lower band, 1 at the upper. Can exceed [0,1] on a breakout. */
  readonly percentB: Series;
}

/** Bollinger Bands. Population stdev, matching TradingView. */
export function bollinger(
  values: readonly number[],
  period = 20,
  multiplier = 2,
): BollingerResult {
  const middle = sma(values, period);
  const sd = stdev(values, period);

  const upper = filled(values.length);
  const lower = filled(values.length);
  const bandwidth = filled(values.length);
  const percentB = filled(values.length);

  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(middle[i]) || !Number.isFinite(sd[i])) continue;
    upper[i] = middle[i] + multiplier * sd[i];
    lower[i] = middle[i] - multiplier * sd[i];
    if (middle[i] !== 0) bandwidth[i] = (upper[i] - lower[i]) / middle[i];
    const span = upper[i] - lower[i];
    percentB[i] = span === 0 ? 0.5 : (values[i] - lower[i]) / span;
  }
  return { upper, middle, lower, bandwidth, percentB };
}

export interface SqueezeResult {
  /** True where bandwidth sits in the tightest `threshold` of its history. */
  readonly squeezed: boolean[];
  /** Bandwidth percentile, 0..1. Low = coiled. */
  readonly bandwidthPercentile: Series;
  /** Consecutive bars the squeeze has held. Longer coil, bigger release. */
  readonly barsInSqueeze: number[];
}

/**
 * Bollinger squeeze — contraction that precedes an expansion in range.
 *
 * A squeeze says a move is COMING, never which way. Treating a squeeze as
 * directional is one of the most common ways to lose money with it, so
 * nothing here emits a direction.
 */
export function bollingerSqueeze(
  values: readonly number[],
  period = 20,
  multiplier = 2,
  lookback = 120,
  threshold = 0.2,
): SqueezeResult {
  const { bandwidth } = bollinger(values, period, multiplier);
  const pct = filled(values.length);
  const squeezed = new Array<boolean>(values.length).fill(false);
  const barsInSqueeze = new Array<number>(values.length).fill(0);

  let run = 0;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(bandwidth[i])) continue;
    const from = Math.max(0, i - lookback + 1);
    const window = bandwidth.slice(from, i + 1).filter(Number.isFinite);
    if (window.length < Math.min(30, lookback)) continue;

    pct[i] = percentileRank(window, bandwidth[i]);
    if (pct[i] <= threshold) {
      run++;
      squeezed[i] = true;
    } else {
      run = 0;
    }
    barsInSqueeze[i] = run;
  }
  return { squeezed, bandwidthPercentile: pct, barsInSqueeze };
}

export interface KeltnerResult {
  readonly upper: Series;
  readonly middle: Series;
  readonly lower: Series;
}

/** Keltner Channels — ATR-based envelope, used to qualify a squeeze. */
export function keltner(
  candles: readonly Candle[],
  period = 20,
  multiplier = 1.5,
  atrPeriod = 10,
): KeltnerResult {
  const closeSeries = candles.map((c) => c.close);
  const middle = ema(closeSeries, period);
  const a = atr(candles, atrPeriod);

  const upper = filled(candles.length);
  const lower = filled(candles.length);
  for (let i = 0; i < candles.length; i++) {
    if (!Number.isFinite(middle[i]) || !Number.isFinite(a[i])) continue;
    upper[i] = middle[i] + multiplier * a[i];
    lower[i] = middle[i] - multiplier * a[i];
  }
  return { upper, middle, lower };
}
