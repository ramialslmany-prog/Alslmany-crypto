/**
 * Pivot (swing) detection — the primitive that structure, levels, patterns and
 * divergence are all built on.
 *
 * A pivot high at index i means i's high is the highest within `left` bars
 * before and `right` bars after it.
 *
 * CONFIRMATION LAG IS NOT A BUG. A pivot cannot be known until `right` bars
 * have closed after it. Code that "detects" a pivot on the current bar is
 * reading the future, and it is the single most common source of backtests
 * that cannot be reproduced live. `confirmedAt` records when we were
 * genuinely allowed to know, and the backtester must honour it.
 */
import type { Candle } from "@/core/types";

export type PivotKind = "high" | "low";

export interface Pivot {
  readonly index: number;
  readonly kind: PivotKind;
  readonly price: number;
  readonly time: number;
  /** Index at which this pivot became knowable: index + right. */
  readonly confirmedAt: number;
  /** Volume traded on the pivot bar — feeds level strength in Stage 3. */
  readonly volume: number;
}

export function findPivots(
  candles: readonly Candle[],
  left = 3,
  right = 3,
): Pivot[] {
  const out: Pivot[] = [];
  if (candles.length < left + right + 1) return out;

  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];

    let isHigh = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      // Strict on the left, non-strict on the right: an exact double top
      // registers its FIRST bar, so equal highs do not produce two pivots.
      if (j < i ? candles[j].high >= c.high : candles[j].high > c.high) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) {
      out.push({
        index: i, kind: "high", price: c.high, time: c.openTime,
        confirmedAt: i + right, volume: c.volume,
      });
    }

    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (j < i ? candles[j].low <= c.low : candles[j].low < c.low) {
        isLow = false;
        break;
      }
    }
    if (isLow) {
      out.push({
        index: i, kind: "low", price: c.low, time: c.openTime,
        confirmedAt: i + right, volume: c.volume,
      });
    }
  }

  out.sort((a, b) => a.index - b.index);
  return out;
}

/** Only the pivots we were allowed to know about at `asOfIndex`. */
export function confirmedPivots(pivots: readonly Pivot[], asOfIndex: number): Pivot[] {
  return pivots.filter((p) => p.confirmedAt <= asOfIndex);
}

export const pivotHighs = (p: readonly Pivot[]): Pivot[] => p.filter((x) => x.kind === "high");
export const pivotLows = (p: readonly Pivot[]): Pivot[] => p.filter((x) => x.kind === "low");
