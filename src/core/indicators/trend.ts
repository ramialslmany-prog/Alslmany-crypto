/**
 * Trend strength and direction: ADX / DMI and Ichimoku.
 */
import { rma } from "@/core/indicators/moving-averages";
import { trueRange } from "@/core/indicators/volatility";
import { type Series, filled, highest, lowest, shift } from "@/core/indicators/series";
import type { Candle } from "@/core/types";

export interface AdxResult {
  readonly adx: Series;
  readonly plusDi: Series;
  readonly minusDi: Series;
}

/**
 * Wilder's ADX / Directional Movement.
 *
 * ADX measures how TRENDING the market is, never which way — +DI/-DI carry
 * direction. Below ~20 the market is ranging, and that is the single most
 * important input to Stage 8's regime call: reversal indicators are worthless
 * in a strong trend, breakout indicators are worthless in a range.
 */
export function adx(candles: readonly Candle[], period = 14, adxPeriod = period): AdxResult {
  const n = candles.length;
  const plusDm = filled(n);
  const minusDm = filled(n);

  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    // Only the LARGER of the two directional moves counts, and only if positive.
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }

  const tr = trueRange(candles);
  // Wilder smooths TR from index 1 so it aligns with the DM series.
  const trForDm = filled(n);
  for (let i = 1; i < n; i++) trForDm[i] = tr[i];

  const smoothTr = rma(trForDm, period);
  const smoothPlus = rma(plusDm, period);
  const smoothMinus = rma(minusDm, period);

  const plusDi = filled(n);
  const minusDi = filled(n);
  const dx = filled(n);

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(smoothTr[i]) || smoothTr[i] === 0) continue;
    if (!Number.isFinite(smoothPlus[i]) || !Number.isFinite(smoothMinus[i])) continue;
    plusDi[i] = (100 * smoothPlus[i]) / smoothTr[i];
    minusDi[i] = (100 * smoothMinus[i]) / smoothTr[i];
    const sum = plusDi[i] + minusDi[i];
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDi[i] - minusDi[i])) / sum;
  }

  return { adx: rma(dx, adxPeriod), plusDi, minusDi };
}

export interface IchimokuResult {
  /** Tenkan-sen — the fast midpoint. */
  readonly conversion: Series;
  /** Kijun-sen — the slow midpoint, and a common stop reference. */
  readonly base: Series;
  /** Senkou Span A, plotted `displacement` bars AHEAD. */
  readonly leadingSpanA: Series;
  /** Senkou Span B, plotted `displacement` bars AHEAD. */
  readonly leadingSpanB: Series;
  /** Chikou — close plotted `displacement` bars BEHIND. */
  readonly laggingSpan: Series;
  /**
   * The cloud AS IT SITS UNDER EACH BAR — i.e. the spans computed 26 bars ago
   * and projected onto now. This is the series you compare price against.
   */
  readonly cloudTop: Series;
  readonly cloudBottom: Series;
}

/**
 * Ichimoku Kinko Hyo (9 / 26 / 52, displacement 26).
 *
 * The displacement is the part that is easy to get wrong. The cloud drawn
 * under today's candle was computed 26 bars ago. Comparing today's price to
 * today's undisplaced span would be reading a cloud that does not exist on the
 * chart — so both the forward-plotted spans and the under-price cloud are
 * returned explicitly, and callers cannot accidentally pick the wrong one.
 */
export function ichimoku(
  candles: readonly Candle[],
  conversionPeriod = 9,
  basePeriod = 26,
  spanBPeriod = 52,
  displacement = 26,
): IchimokuResult {
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const n = candles.length;

  const midpoint = (period: number): Series => {
    const hh = highest(high, period);
    const ll = lowest(low, period);
    const out = filled(n);
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(hh[i]) && Number.isFinite(ll[i])) out[i] = (hh[i] + ll[i]) / 2;
    }
    return out;
  };

  const conversion = midpoint(conversionPeriod);
  const base = midpoint(basePeriod);

  const rawSpanA = filled(n);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(conversion[i]) && Number.isFinite(base[i])) {
      rawSpanA[i] = (conversion[i] + base[i]) / 2;
    }
  }
  const rawSpanB = midpoint(spanBPeriod);

  // Plotted ahead: value computed at bar i appears at bar i + displacement.
  const leadingSpanA = shift(rawSpanA, displacement);
  const leadingSpanB = shift(rawSpanB, displacement);
  const laggingSpan = shift(candles.map((c) => c.close), -displacement);

  const cloudTop = filled(n);
  const cloudBottom = filled(n);
  for (let i = 0; i < n; i++) {
    const a = leadingSpanA[i];
    const b = leadingSpanB[i];
    if (Number.isFinite(a) && Number.isFinite(b)) {
      cloudTop[i] = Math.max(a, b);
      cloudBottom[i] = Math.min(a, b);
    }
  }

  return { conversion, base, leadingSpanA, leadingSpanB, laggingSpan, cloudTop, cloudBottom };
}

export type CloudPosition = "above" | "inside" | "below" | "unknown";

/** Where price sits against the cloud that is actually drawn under it. */
export function cloudPosition(price: number, top: number, bottom: number): CloudPosition {
  if (![price, top, bottom].every(Number.isFinite)) return "unknown";
  if (price > top) return "above";
  if (price < bottom) return "below";
  return "inside";
}
