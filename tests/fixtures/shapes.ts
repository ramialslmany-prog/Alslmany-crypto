/**
 * Hand-built price shapes.
 *
 * Detectors are easy to fool with random data — "it found something" proves
 * nothing. These build the exact geometry of each pattern from named turning
 * points, so a test can assert that a double top IS detected in a double top
 * and is NOT detected in a clean trend.
 */
import type { Candle } from "@/core/types";

const HOUR = 3_600_000;
const START = Date.UTC(2024, 0, 1);

export interface ShapeOptions {
  /** Wick size as a fraction of the bar's move. */
  readonly wick?: number;
  readonly volume?: number;
}

/**
 * Build candles that walk through `path` — a list of prices — interpolating
 * `barsPerLeg` bars between each pair.
 */
export function fromPath(
  path: readonly number[],
  barsPerLeg = 6,
  opts: ShapeOptions = {},
): Candle[] {
  const wickFactor = opts.wick ?? 0.25;
  const baseVolume = opts.volume ?? 100;
  const out: Candle[] = [];
  let index = 0;

  for (let leg = 0; leg < path.length - 1; leg++) {
    const from = path[leg];
    const to = path[leg + 1];
    for (let step = 0; step < barsPerLeg; step++) {
      const t0 = step / barsPerLeg;
      const t1 = (step + 1) / barsPerLeg;
      const open = from + (to - from) * t0;
      const close = from + (to - from) * t1;
      const move = Math.abs(close - open);
      const wick = Math.max(move * wickFactor, Math.abs(open) * 0.0004);
      out.push({
        openTime: START + index * HOUR,
        closeTime: START + (index + 1) * HOUR,
        open,
        high: Math.max(open, close) + wick,
        low: Math.min(open, close) - wick,
        close,
        volume: baseVolume + move * 2,
        quoteVolume: (baseVolume + move * 2) * close,
        trades: 20,
        takerBuyBase: (baseVolume + move * 2) * (close > open ? 0.6 : 0.4),
        takerBuyQuote: 0,
        ...({} as Record<string, never>),
      });
      index++;
    }
  }
  return out;
}

/** Flat lead-in so indicators warm up before the shape begins. */
export function withWarmup(shape: readonly Candle[], bars = 60, price?: number): Candle[] {
  const first = shape[0];
  const base = price ?? first.open;
  const warm: Candle[] = [];
  for (let i = 0; i < bars; i++) {
    const wobble = base * 0.0015 * (i % 2 === 0 ? 1 : -1);
    const open = base + wobble;
    const close = base - wobble;
    warm.push({
      openTime: first.openTime - (bars - i) * HOUR,
      closeTime: first.openTime - (bars - i - 1) * HOUR,
      open,
      high: Math.max(open, close) + base * 0.002,
      low: Math.min(open, close) - base * 0.002,
      close,
      volume: 100,
      quoteVolume: 100 * close,
      trades: 20,
      takerBuyBase: 50,
      takerBuyQuote: 0,
    });
  }
  // Re-stamp the shape so times stay contiguous.
  return [...warm, ...shape].map((c, i) => ({
    ...c,
    openTime: START + i * HOUR,
    closeTime: START + (i + 1) * HOUR,
  }));
}

/** Two equal peaks with a trough between, then a break below the trough. */
export const doubleTop = (): Candle[] =>
  withWarmup(fromPath([100, 120, 108, 120.3, 104], 10));

/** Two equal troughs with a peak between, then a break above the peak. */
export const doubleBottom = (): Candle[] =>
  withWarmup(fromPath([120, 100, 112, 99.8, 116], 10));

/** Left shoulder, higher head, right shoulder, break of the neckline. */
export const headAndShoulders = (): Candle[] =>
  withWarmup(fromPath([100, 118, 108, 132, 107, 118.5, 100], 8));

export const inverseHeadAndShoulders = (): Candle[] =>
  withWarmup(fromPath([130, 112, 122, 98, 123, 111.5, 130], 8));

/** Flat resistance, rising lows, then a break upward. */
export const ascendingTriangle = (): Candle[] =>
  withWarmup(fromPath([100, 120, 106, 119.8, 111, 120.1, 115, 128], 7));

/** Flat support, falling highs, then a break downward. */
export const descendingTriangle = (): Candle[] =>
  withWarmup(fromPath([130, 110, 125, 110.2, 119, 110.1, 115, 100], 7));

/** A strong impulse, then a shallow drift down, then continuation. */
export const bullFlag = (): Candle[] =>
  withWarmup(fromPath([100, 140, 134, 137, 131, 134, 129, 150], 6));

/**
 * A clean uptrend: higher highs AND higher lows.
 *
 * It zigzags on purpose. A monotonic ramp has no swing points at all — every
 * bar is higher than the last — so it is not an uptrend in the structural
 * sense, it is a straight line, and no pivot detector should find anything
 * in it. Real trends pull back.
 */
export const cleanUptrend = (): Candle[] =>
  withWarmup(fromPath([100, 114, 107, 126, 118, 138, 129, 152], 8));

export const cleanDowntrend = (): Candle[] =>
  withWarmup(fromPath([152, 138, 145, 126, 133, 114, 121, 100], 8));

/** A literal straight line — used to prove pivot detection stays silent. */
export const straightRamp = (): Candle[] =>
  withWarmup(fromPath([100, 110, 120, 130, 140, 150], 10));

/** A tight range: no trend, repeated tests of the same two levels. */
export const range = (): Candle[] =>
  withWarmup(fromPath([100, 110, 100.2, 109.8, 100.1, 110.1, 100.3, 109.9], 8));

/** Append one bar with a chosen shape, for candlestick tests. */
export function appendCandle(
  candles: readonly Candle[],
  shape: { open: number; high: number; low: number; close: number; volume?: number },
): Candle[] {
  const last = candles[candles.length - 1];
  return [
    ...candles,
    {
      openTime: last.openTime + HOUR,
      closeTime: last.openTime + 2 * HOUR,
      open: shape.open,
      high: shape.high,
      low: shape.low,
      close: shape.close,
      volume: shape.volume ?? 150,
      quoteVolume: (shape.volume ?? 150) * shape.close,
      trades: 30,
      takerBuyBase: (shape.volume ?? 150) * 0.5,
      takerBuyQuote: 0,
    },
  ];
}
