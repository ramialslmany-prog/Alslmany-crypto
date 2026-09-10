import type { Candle } from "@/lib/market/types";
import { atr, last } from "./indicators";

/**
 * Market structure.
 *
 * Where the indicator module answers "how fast", this module answers "where":
 * the swing points price actually turned on, the levels it respects, and the
 * moment its character changed. A stop placed at a real structural level is a
 * thesis; a stop placed at a round percentage is a guess, so every level the
 * recommendation engine quotes is derived here.
 */

export type SwingKind = "high" | "low";

export type Swing = {
  index: number;
  price: number;
  time: number;
  kind: SwingKind;
};

export type TrendLabel = "up" | "down" | "range";

export type StructureBreak = {
  /** BOS continues the existing trend; CHoCH is the first break against it. */
  kind: "BOS" | "CHoCH";
  direction: "bullish" | "bearish";
  price: number;
  time: number;
  index: number;
};

export type Level = {
  price: number;
  kind: "support" | "resistance";
  /** How many independent swings formed at this price. */
  touches: number;
  /** 0–100: touches, recency and proximity combined. */
  strength: number;
  lastTouchIndex: number;
};

/** An imbalance the market left behind — a candle whose neighbours never overlap. */
export type FairValueGap = {
  top: number;
  bottom: number;
  direction: "bullish" | "bearish";
  index: number;
  time: number;
  filled: boolean;
};

export type StructureRead = {
  swings: Swing[];
  trend: TrendLabel;
  /** Plain-language reason the trend was labelled this way. */
  trendBasis: string;
  lastBreak: StructureBreak | null;
  breaks: StructureBreak[];
  levels: Level[];
  nearestSupport: Level | null;
  nearestResistance: Level | null;
  fvgs: FairValueGap[];
  /** Retracement of the most recent impulse leg. */
  fib: { from: number; to: number; direction: "up" | "down"; levels: { ratio: number; price: number }[] } | null;
  /** Where price sits inside its recent range, 0 = low, 100 = high. */
  rangePosition: number | null;
};

/**
 * Fractal pivots: a bar is a swing high when no bar within `strength` on
 * either side traded higher. Larger `strength` yields fewer, more meaningful
 * turning points.
 *
 * The comparison is deliberately asymmetric — strict to the left, permissive
 * to the right. A symmetric strict test throws away every plateau, so a double
 * top printing two identical highs would register no swing at all, and the
 * level price was rejected from twice would never enter the analysis.
 * This way a plateau resolves to its first bar.
 */
export function findSwings(candles: Candle[], strength = 3): Swing[] {
  const out: Swing[] = [];
  if (candles.length < strength * 2 + 1) return out;

  for (let i = strength; i < candles.length - strength; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (j < i) {
        if (candles[j].h >= candles[i].h) isHigh = false;
        if (candles[j].l <= candles[i].l) isLow = false;
      } else {
        if (candles[j].h > candles[i].h) isHigh = false;
        if (candles[j].l < candles[i].l) isLow = false;
      }
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ index: i, price: candles[i].h, time: candles[i].t, kind: "high" });
    if (isLow) out.push({ index: i, price: candles[i].l, time: candles[i].t, kind: "low" });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Classify trend from the sequence of swings.
 * Higher highs *and* higher lows is an uptrend; anything mixed is a range.
 * We deliberately refuse to call a trend on partial evidence — a false trend
 * label is what turns a range-bound chop into a string of losing breakouts.
 */
export function classifyTrend(swings: Swing[]): { trend: TrendLabel; basis: string } {
  const highs = swings.filter((s) => s.kind === "high").slice(-3);
  const lows = swings.filter((s) => s.kind === "low").slice(-3);

  if (highs.length < 2 || lows.length < 2) {
    return { trend: "range", basis: "not enough swing points to establish structure" };
  }

  const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
  const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
  const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
  const ll = lows[lows.length - 1].price < lows[lows.length - 2].price;

  if (hh && hl) return { trend: "up", basis: "higher highs and higher lows" };
  if (lh && ll) return { trend: "down", basis: "lower highs and lower lows" };
  if (hh && ll) return { trend: "range", basis: "expanding range — highs and lows both widening" };
  if (lh && hl) return { trend: "range", basis: "contracting range — coiling into a decision" };
  return { trend: "range", basis: "mixed structure, no clean sequence" };
}

/**
 * Walk the series forward and record each structural break.
 * A break in the direction of the prevailing structure is a BOS
 * (continuation); the first break against it is a CHoCH — the earliest
 * evidence that the character of the market has changed.
 */
export function findBreaks(candles: Candle[], swings: Swing[]): StructureBreak[] {
  const out: StructureBreak[] = [];
  if (swings.length < 4) return out;

  let bias: "bullish" | "bearish" | null = null;

  for (let i = 0; i < candles.length; i++) {
    const priorHighs = swings.filter((s) => s.kind === "high" && s.index < i - 1);
    const priorLows = swings.filter((s) => s.kind === "low" && s.index < i - 1);
    const lastHigh = priorHighs[priorHighs.length - 1];
    const lastLow = priorLows[priorLows.length - 1];
    const close = candles[i].c;

    // Only a close beyond the level counts. Wicks through structure are noise
    // and are the single most common source of false breakout signals.
    if (lastHigh && close > lastHigh.price) {
      const kind = bias === "bearish" ? "CHoCH" : "BOS";
      if (out[out.length - 1]?.price !== lastHigh.price || out[out.length - 1]?.direction !== "bullish") {
        out.push({ kind, direction: "bullish", price: lastHigh.price, time: candles[i].t, index: i });
        bias = "bullish";
      }
    } else if (lastLow && close < lastLow.price) {
      const kind = bias === "bullish" ? "CHoCH" : "BOS";
      if (out[out.length - 1]?.price !== lastLow.price || out[out.length - 1]?.direction !== "bearish") {
        out.push({ kind, direction: "bearish", price: lastLow.price, time: candles[i].t, index: i });
        bias = "bearish";
      }
    }
  }

  return out;
}

/**
 * Cluster swing prices into levels. Two swings that turned within a fraction
 * of ATR of each other are the same level being defended twice, and a level
 * defended repeatedly is worth more than one touched once.
 */
export function findLevels(candles: Candle[], swings: Swing[], maxLevels = 8): Level[] {
  if (candles.length === 0 || swings.length === 0) return [];
  const price = candles[candles.length - 1].c;
  const atrValue = last(atr(candles, 14)) ?? price * 0.01;
  const tolerance = Math.max(atrValue * 0.6, price * 0.0015);

  type Cluster = { prices: number[]; kind: SwingKind; lastIndex: number };
  const clusters: Cluster[] = [];

  for (const swing of swings) {
    const found = clusters.find(
      (c) =>
        c.kind === swing.kind &&
        Math.abs(c.prices.reduce((a, b) => a + b, 0) / c.prices.length - swing.price) <= tolerance,
    );
    if (found) {
      found.prices.push(swing.price);
      found.lastIndex = Math.max(found.lastIndex, swing.index);
    } else {
      clusters.push({ prices: [swing.price], kind: swing.kind, lastIndex: swing.index });
    }
  }

  const total = candles.length;
  const levels: Level[] = clusters.map((c) => {
    const mean = c.prices.reduce((a, b) => a + b, 0) / c.prices.length;
    const recency = c.lastIndex / Math.max(total - 1, 1);
    const distance = Math.abs(mean - price) / price;
    const touchScore = Math.min(c.prices.length / 4, 1) * 45;
    const recencyScore = recency * 35;
    // A level 40% away is real but irrelevant to a decision made today.
    const proximityScore = Math.max(0, 1 - distance / 0.25) * 20;
    return {
      price: mean,
      // Classify by where the level sits now, not by how it originally formed:
      // broken resistance becomes support, and the chart does not care what we
      // used to call it.
      kind: mean >= price ? ("resistance" as const) : ("support" as const),
      touches: c.prices.length,
      strength: Math.round(touchScore + recencyScore + proximityScore),
      lastTouchIndex: c.lastIndex,
    };
  });

  return levels.sort((a, b) => b.strength - a.strength).slice(0, maxLevels);
}

/**
 * Fair value gaps: a three-bar imbalance where the first and third bars do not
 * overlap. Price frequently returns to fill them, which makes an unfilled gap
 * both a magnet and a plausible entry zone.
 */
export function findFairValueGaps(candles: Candle[], lookback = 120): FairValueGap[] {
  const out: FairValueGap[] = [];
  const start = Math.max(1, candles.length - lookback);

  for (let i = start; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];

    if (next.l > prev.h) {
      out.push({
        top: next.l, bottom: prev.h, direction: "bullish", index: i, time: candles[i].t,
        filled: candles.slice(i + 2).some((c) => c.l <= prev.h),
      });
    } else if (next.h < prev.l) {
      out.push({
        top: prev.l, bottom: next.h, direction: "bearish", index: i, time: candles[i].t,
        filled: candles.slice(i + 2).some((c) => c.h >= prev.l),
      });
    }
  }

  // Unfilled gaps are the ones that still matter; keep the most recent few.
  return out.filter((g) => !g.filled).slice(-6);
}

const FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786];

/**
 * Retracement levels across the most recent impulse leg.
 *
 * The leg runs from the latest swing back to the most recent swing of the
 * opposite kind — not simply the last two pivots, since two highs can print in
 * a row and that would leave a real completed leg unmeasured.
 */
export function fibonacci(swings: Swing[]) {
  if (swings.length < 2) return null;
  const b = swings[swings.length - 1];
  let a: Swing | undefined;
  for (let i = swings.length - 2; i >= 0; i--) {
    if (swings[i].kind !== b.kind) {
      a = swings[i];
      break;
    }
  }
  if (!a) return null;

  const from = a.price;
  const to = b.price;
  const direction = to > from ? ("up" as const) : ("down" as const);
  const span = to - from;

  return {
    from,
    to,
    direction,
    levels: FIB_RATIOS.map((ratio) => ({ ratio, price: to - span * ratio })),
  };
}

/** Full structural read for one series. */
export function readStructure(candles: Candle[], swingStrength = 3): StructureRead {
  const swings = findSwings(candles, swingStrength);
  const { trend, basis } = classifyTrend(swings);
  const breaks = findBreaks(candles, swings);
  const levels = findLevels(candles, swings);
  const price = candles[candles.length - 1]?.c ?? 0;

  const supports = levels.filter((l) => l.kind === "support").sort((a, b) => b.price - a.price);
  const resistances = levels.filter((l) => l.kind === "resistance").sort((a, b) => a.price - b.price);

  const window = candles.slice(-60);
  const hi = Math.max(...window.map((c) => c.h));
  const lo = Math.min(...window.map((c) => c.l));

  return {
    swings,
    trend,
    trendBasis: basis,
    lastBreak: breaks[breaks.length - 1] ?? null,
    breaks: breaks.slice(-8),
    levels,
    nearestSupport: supports[0] ?? null,
    nearestResistance: resistances[0] ?? null,
    fvgs: findFairValueGaps(candles),
    fib: fibonacci(swings),
    rangePosition: hi > lo ? ((price - lo) / (hi - lo)) * 100 : null,
  };
}
