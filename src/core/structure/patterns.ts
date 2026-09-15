/**
 * Chart patterns, detected from confirmed pivots.
 *
 * Every pattern here reports a COMPLETION FRACTION rather than a yes/no,
 * because a head and shoulders that has not broken its neckline is not a head
 * and shoulders — it is four swings that might become one. Trading an
 * incomplete pattern as though it were finished is one of the most reliable
 * ways to lose money on otherwise correct analysis.
 *
 * Targets are MEASURED FROM THE PATTERN'S OWN GEOMETRY — the height of the
 * formation projected from the break point — never from a fixed percentage.
 */
import { type Pivot, findPivots } from "@/core/indicators/pivots";
import { atr } from "@/core/indicators/volatility";
import type { Candle } from "@/core/types";

export type PatternKind =
  | "double_top"
  | "double_bottom"
  | "head_and_shoulders"
  | "inverse_head_and_shoulders"
  | "ascending_triangle"
  | "descending_triangle"
  | "symmetrical_triangle"
  | "bull_flag"
  | "bear_flag"
  | "rising_wedge"
  | "falling_wedge";

export const PATTERN_AR: Record<PatternKind, string> = {
  double_top: "قمة مزدوجة",
  double_bottom: "قاع مزدوج",
  head_and_shoulders: "رأس وكتفان",
  inverse_head_and_shoulders: "رأس وكتفان مقلوبة",
  ascending_triangle: "مثلث صاعد",
  descending_triangle: "مثلث هابط",
  symmetrical_triangle: "مثلث متماثل",
  bull_flag: "علم صاعد",
  bear_flag: "علم هابط",
  rising_wedge: "وتد صاعد",
  falling_wedge: "وتد هابط",
};

export interface ChartPattern {
  readonly kind: PatternKind;
  readonly direction: "bullish" | "bearish";
  /** Index of the first and last pivot forming the pattern. */
  readonly startIndex: number;
  readonly endIndex: number;
  /** The level whose break confirms the pattern. */
  readonly triggerLevel: number;
  /** Where the pattern is invalidated. */
  readonly invalidationLevel: number;
  /** Projected from the pattern's own height. */
  readonly target: number;
  /** 0..1. 1 means the trigger level has been broken on a close. */
  readonly completion: number;
  readonly confirmed: boolean;
  /** 0..100, from symmetry and how cleanly the pivots fit. */
  readonly quality: number;
  readonly pivots: readonly { index: number; price: number }[];
  readonly arabic: string;
}

export interface PatternOptions {
  readonly pivotLeft?: number;
  readonly pivotRight?: number;
  readonly lookback?: number;
  /** Two prices within this many ATR count as "the same level". */
  readonly equalToleranceAtr?: number;
  readonly minQuality?: number;
}

export function findPatterns(candles: readonly Candle[], opts: PatternOptions = {}): ChartPattern[] {
  const left = opts.pivotLeft ?? 3;
  const right = opts.pivotRight ?? 3;
  const lookback = opts.lookback ?? 200;
  const equalTol = opts.equalToleranceAtr ?? 0.6;
  const minQuality = opts.minQuality ?? 40;

  if (candles.length < 40) return [];

  const endIndex = candles.length - 1;
  const from = Math.max(0, candles.length - lookback);
  const atrSeries = atr(candles, 14);
  const atrAt = (i: number): number => {
    const v = atrSeries[i];
    return Number.isFinite(v) && v > 0 ? v : candles[i].close * 0.01;
  };

  const pivots = findPivots(candles, left, right).filter(
    (p) => p.confirmedAt <= endIndex && p.index >= from,
  );
  if (pivots.length < 4) return [];

  const found: ChartPattern[] = [
    ...doubleTopsBottoms(candles, pivots, atrAt, equalTol),
    ...headAndShoulders(candles, pivots, atrAt, equalTol),
    ...triangles(candles, pivots, atrAt),
    ...flagsAndWedges(candles, pivots, atrAt),
  ];

  return found
    .filter((p) => p.quality >= minQuality)
    .sort((a, b) => b.endIndex - a.endIndex || b.quality - a.quality);
}

// ── double top / bottom ──────────────────────────────────────────────────────

function doubleTopsBottoms(
  candles: readonly Candle[],
  pivots: readonly Pivot[],
  atrAt: (i: number) => number,
  equalTol: number,
): ChartPattern[] {
  const out: ChartPattern[] = [];
  const highs = pivots.filter((p) => p.kind === "high");
  const lows = pivots.filter((p) => p.kind === "low");

  const scan = (
    peaks: readonly Pivot[],
    troughs: readonly Pivot[],
    kind: "double_top" | "double_bottom",
  ) => {
    for (let i = 1; i < peaks.length; i++) {
      const first = peaks[i - 1];
      const second = peaks[i];
      const tolerance = atrAt(second.index) * equalTol;
      if (Math.abs(second.price - first.price) > tolerance) continue;
      // Needs real separation, or it is one swing with a noisy top.
      if (second.index - first.index < 8) continue;

      // The neckline is the extreme BETWEEN the two peaks.
      const between = troughs.filter((t) => t.index > first.index && t.index < second.index);
      if (between.length === 0) continue;
      const neck =
        kind === "double_top"
          ? between.reduce((lo, t) => (t.price < lo.price ? t : lo))
          : between.reduce((hi, t) => (t.price > hi.price ? t : hi));

      const height = Math.abs(first.price - neck.price);
      if (height < atrAt(second.index) * 1.2) continue; // too shallow to matter

      const bearish = kind === "double_top";
      const trigger = neck.price;
      const target = bearish ? trigger - height : trigger + height;
      const invalidation = bearish ? Math.max(first.price, second.price) : Math.min(first.price, second.price);

      const completion = completionOf(candles, second.index, trigger, bearish ? "below" : "above");
      const symmetry = 1 - Math.abs(second.price - first.price) / Math.max(tolerance, 1e-9);
      const quality = Math.round(Math.min(100, 45 + symmetry * 35 + Math.min(20, height / atrAt(second.index) * 4)));

      out.push({
        kind,
        direction: bearish ? "bearish" : "bullish",
        startIndex: first.index,
        endIndex: second.index,
        triggerLevel: trigger,
        invalidationLevel: invalidation,
        target,
        completion,
        confirmed: completion >= 1,
        quality,
        pivots: [first, neck, second].map((p) => ({ index: p.index, price: p.price })),
        arabic: describePattern(kind, completion, trigger, target, invalidation),
      });
    }
  };

  scan(highs, lows, "double_top");
  scan(lows, highs, "double_bottom");
  return out;
}

// ── head and shoulders ───────────────────────────────────────────────────────

function headAndShoulders(
  candles: readonly Candle[],
  pivots: readonly Pivot[],
  atrAt: (i: number) => number,
  equalTol: number,
): ChartPattern[] {
  const out: ChartPattern[] = [];
  const highs = pivots.filter((p) => p.kind === "high");
  const lows = pivots.filter((p) => p.kind === "low");

  const scan = (
    peaks: readonly Pivot[],
    troughs: readonly Pivot[],
    inverse: boolean,
  ) => {
    for (let i = 2; i < peaks.length; i++) {
      const leftShoulder = peaks[i - 2];
      const head = peaks[i - 1];
      const rightShoulder = peaks[i];

      // The head must genuinely exceed both shoulders.
      const headIsExtreme = inverse
        ? head.price < leftShoulder.price && head.price < rightShoulder.price
        : head.price > leftShoulder.price && head.price > rightShoulder.price;
      if (!headIsExtreme) continue;

      // Shoulders should be roughly level; badly uneven ones are not the pattern.
      const shoulderDiff = Math.abs(leftShoulder.price - rightShoulder.price);
      const tolerance = atrAt(rightShoulder.index) * equalTol * 2;
      if (shoulderDiff > tolerance) continue;

      const necks = troughs.filter((t) => t.index > leftShoulder.index && t.index < rightShoulder.index);
      if (necks.length < 2) continue;
      const neckline = average(necks.map((n) => n.price));

      const height = Math.abs(head.price - neckline);
      if (height < atrAt(head.index) * 1.5) continue;

      const bearish = !inverse;
      const target = bearish ? neckline - height : neckline + height;
      const completion = completionOf(candles, rightShoulder.index, neckline, bearish ? "below" : "above");
      const symmetry = 1 - Math.min(1, shoulderDiff / Math.max(tolerance, 1e-9));
      const quality = Math.round(Math.min(100, 40 + symmetry * 40 + Math.min(20, (height / atrAt(head.index)) * 3)));

      out.push({
        kind: inverse ? "inverse_head_and_shoulders" : "head_and_shoulders",
        direction: bearish ? "bearish" : "bullish",
        startIndex: leftShoulder.index,
        endIndex: rightShoulder.index,
        triggerLevel: neckline,
        invalidationLevel: head.price,
        target,
        completion,
        confirmed: completion >= 1,
        quality,
        pivots: [leftShoulder, head, rightShoulder].map((p) => ({ index: p.index, price: p.price })),
        arabic: describePattern(
          inverse ? "inverse_head_and_shoulders" : "head_and_shoulders",
          completion, neckline, target, head.price,
        ),
      });
    }
  };

  scan(highs, lows, false);
  scan(lows, highs, true);
  return out;
}

// ── triangles ────────────────────────────────────────────────────────────────

function triangles(
  candles: readonly Candle[],
  pivots: readonly Pivot[],
  atrAt: (i: number) => number,
): ChartPattern[] {
  const out: ChartPattern[] = [];
  const highs = pivots.filter((p) => p.kind === "high").slice(-4);
  const lows = pivots.filter((p) => p.kind === "low").slice(-4);
  if (highs.length < 2 || lows.length < 2) return out;

  const highSlope = slopeOf(highs);
  const lowSlope = slopeOf(lows);
  const endIndex = candles.length - 1;
  const scale = atrAt(endIndex);

  // "Flat" means the trendline moves less than a fraction of an ATR per bar.
  const flat = scale * 0.04;
  const highFlat = Math.abs(highSlope) < flat;
  const lowFlat = Math.abs(lowSlope) < flat;

  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  const height = lastHigh.price - lastLow.price;
  if (height <= scale) return out;

  const startIndex = Math.min(highs[0].index, lows[0].index);
  const endPivot = Math.max(lastHigh.index, lastLow.index);

  let kind: PatternKind | null = null;
  let direction: "bullish" | "bearish" = "bullish";
  let trigger = 0;
  let invalidation = 0;

  if (highFlat && lowSlope > flat) {
    // Flat resistance, rising support: buyers keep paying up.
    kind = "ascending_triangle";
    direction = "bullish";
    trigger = lastHigh.price;
    invalidation = lastLow.price;
  } else if (lowFlat && highSlope < -flat) {
    kind = "descending_triangle";
    direction = "bearish";
    trigger = lastLow.price;
    invalidation = lastHigh.price;
  } else if (highSlope < -flat && lowSlope > flat) {
    // Converging from both sides — direction unknown until it breaks.
    kind = "symmetrical_triangle";
    direction = highSlope + lowSlope >= 0 ? "bullish" : "bearish";
    trigger = direction === "bullish" ? lastHigh.price : lastLow.price;
    invalidation = direction === "bullish" ? lastLow.price : lastHigh.price;
  }
  if (!kind) return out;

  const target = direction === "bullish" ? trigger + height : trigger - height;
  const completion = completionOf(candles, endPivot, trigger, direction === "bullish" ? "above" : "below");
  const touches = highs.length + lows.length;
  const quality = Math.round(Math.min(100, 35 + touches * 7 + Math.min(20, (height / scale) * 3)));

  out.push({
    kind, direction, startIndex, endIndex: endPivot,
    triggerLevel: trigger, invalidationLevel: invalidation, target,
    completion, confirmed: completion >= 1, quality,
    pivots: [...highs, ...lows].sort((a, b) => a.index - b.index).map((p) => ({ index: p.index, price: p.price })),
    arabic: describePattern(kind, completion, trigger, target, invalidation),
  });
  return out;
}

// ── flags and wedges ─────────────────────────────────────────────────────────

function flagsAndWedges(
  candles: readonly Candle[],
  pivots: readonly Pivot[],
  atrAt: (i: number) => number,
): ChartPattern[] {
  const out: ChartPattern[] = [];
  const highs = pivots.filter((p) => p.kind === "high").slice(-3);
  const lows = pivots.filter((p) => p.kind === "low").slice(-3);
  if (highs.length < 2 || lows.length < 2) return out;

  const endIndex = candles.length - 1;
  const scale = atrAt(endIndex);
  const highSlope = slopeOf(highs);
  const lowSlope = slopeOf(lows);

  const startIndex = Math.min(highs[0].index, lows[0].index);
  const consolidationLength = endIndex - startIndex;
  if (consolidationLength < 6) return out;

  // The pole: the move INTO the consolidation. A flag without a pole is just
  // a range, and its measured target would be meaningless.
  const poleStart = Math.max(0, startIndex - consolidationLength * 2);
  const poleWindow = candles.slice(poleStart, startIndex + 1);
  if (poleWindow.length < 5) return out;
  const poleLow = Math.min(...poleWindow.map((c) => c.low));
  const poleHigh = Math.max(...poleWindow.map((c) => c.high));
  const poleHeight = poleHigh - poleLow;
  if (poleHeight < scale * 3) return out; // no real impulse

  const poleUp = poleWindow[poleWindow.length - 1].close > poleWindow[0].close;
  const bothDown = highSlope < 0 && lowSlope < 0;
  const bothUp = highSlope > 0 && lowSlope > 0;
  const converging = Math.abs(highSlope) > 0 && Math.abs(lowSlope) > 0 &&
    Math.abs(highSlope - lowSlope) > Math.abs(highSlope) * 0.35;

  let kind: PatternKind | null = null;
  let direction: "bullish" | "bearish" = "bullish";

  if (poleUp && bothDown) {
    // Drifting down against an up-impulse.
    kind = converging && highSlope < lowSlope ? "falling_wedge" : "bull_flag";
    direction = "bullish";
  } else if (!poleUp && bothUp) {
    kind = converging && highSlope > lowSlope ? "rising_wedge" : "bear_flag";
    direction = "bearish";
  }
  if (!kind) return out;

  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  const trigger = direction === "bullish" ? lastHigh.price : lastLow.price;
  const invalidation = direction === "bullish" ? lastLow.price : lastHigh.price;
  // Measured move: the pole projected from the breakout.
  const target = direction === "bullish" ? trigger + poleHeight : trigger - poleHeight;

  const completion = completionOf(candles, Math.max(lastHigh.index, lastLow.index), trigger,
    direction === "bullish" ? "above" : "below");
  const quality = Math.round(Math.min(100, 40 + Math.min(30, (poleHeight / scale) * 4) + (converging ? 10 : 0)));

  out.push({
    kind, direction, startIndex, endIndex: Math.max(lastHigh.index, lastLow.index),
    triggerLevel: trigger, invalidationLevel: invalidation, target,
    completion, confirmed: completion >= 1, quality,
    pivots: [...highs, ...lows].sort((a, b) => a.index - b.index).map((p) => ({ index: p.index, price: p.price })),
    arabic: describePattern(kind, completion, trigger, target, invalidation),
  });
  return out;
}

// ── shared ───────────────────────────────────────────────────────────────────

/**
 * How close the pattern is to triggering, 0..1.
 *
 * 1 requires a CLOSE beyond the trigger — a wick through it is not a break,
 * for the same reason it is not a structure break.
 */
function completionOf(
  candles: readonly Candle[],
  fromIndex: number,
  trigger: number,
  side: "above" | "below",
): number {
  const endIndex = candles.length - 1;
  for (let i = fromIndex + 1; i <= endIndex; i++) {
    const closed = side === "above" ? candles[i].close > trigger : candles[i].close < trigger;
    if (closed) return 1;
  }
  // Not triggered: report how near price has come, so a pattern 95% of the way
  // there is visibly different from one that has barely formed.
  const price = candles[endIndex].close;
  const reference = candles[fromIndex].close;
  const span = Math.abs(trigger - reference);
  if (span <= 0) return 0.99;
  const travelled = side === "above" ? price - reference : reference - price;
  return Math.max(0, Math.min(0.99, travelled / span));
}

function slopeOf(pivots: readonly Pivot[]): number {
  if (pivots.length < 2) return 0;
  const first = pivots[0];
  const last = pivots[pivots.length - 1];
  const bars = last.index - first.index;
  return bars === 0 ? 0 : (last.price - first.price) / bars;
}

function describePattern(
  kind: PatternKind,
  completion: number,
  trigger: number,
  target: number,
  invalidation: number,
): string {
  const name = PATTERN_AR[kind];
  const pct = Math.round(completion * 100);
  const status =
    completion >= 1
      ? "مكتمل ومؤكّد بإغلاق خارج مستوى التفعيل"
      : `مكتمل ${pct}% — لم يُفعّل بعد، والنمط غير المكتمل ليس فرصة`;
  return (
    `${name}: ${status}. ` +
    `مستوى التفعيل ${trigger.toFixed(4)}، والهدف المحسوب من ارتفاع النمط ${target.toFixed(4)}، ` +
    `والإبطال عند ${invalidation.toFixed(4)}.`
  );
}

const average = (v: readonly number[]): number =>
  v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length;
