/**
 * Support and resistance as ZONES, not lines.
 *
 * Price does not turn at 43,218.40. It turns somewhere in a band around it,
 * and treating a level as an infinitely thin line is why stops get placed two
 * ticks inside the noise and taken out by a wick that respected the level.
 * Every zone here has a width derived from ATR at the time the level formed.
 *
 * STRENGTH is ranked by the four things the spec names, because a level
 * touched five times on heavy volume that has held every time is a different
 * object from one touched once in passing:
 *
 *   touches   how many times price came back to it
 *   volume    how much traded there (real participation, not a random wick)
 *   holds     how often it actually reversed price vs how often it broke
 *   recency   how long ago it last mattered — old levels decay
 *
 * These zones are what Stage 4 uses to place entries, stops and targets. That
 * is the whole point: a stop belongs behind a real invalidation level, never
 * at "entry minus 2%".
 */
import { type Pivot, findPivots } from "@/core/indicators/pivots";
import { atr } from "@/core/indicators/volatility";
import type { Candle } from "@/core/types";

export type LevelKind = "support" | "resistance" | "flipped_support" | "flipped_resistance";

export const LEVEL_KIND_AR: Record<LevelKind, string> = {
  support: "دعم",
  resistance: "مقاومة",
  flipped_support: "مقاومة سابقة تحوّلت دعماً",
  flipped_resistance: "دعم سابق تحوّل مقاومة",
};

export interface LevelTouch {
  readonly index: number;
  readonly time: number;
  readonly price: number;
  readonly volume: number;
  /** True when price reversed away from the zone rather than passing through. */
  readonly held: boolean;
}

export interface LevelZone {
  /** Volume-weighted centre of the zone. */
  readonly price: number;
  readonly low: number;
  readonly high: number;
  readonly kind: LevelKind;
  readonly touches: readonly LevelTouch[];
  readonly touchCount: number;
  readonly holdCount: number;
  readonly breakCount: number;
  /** Total volume traded on the touching bars. */
  readonly volume: number;
  /** Bars since the zone last mattered. */
  readonly barsSinceTouch: number;
  /** 0..100. Higher is a level worth trading against. */
  readonly strength: number;
  /** Distance from current price, in percent (signed: + is above). */
  readonly distancePct: number;
  /** Distance in ATR units — the number that decides if it is reachable. */
  readonly distanceAtr: number;
  readonly arabic: string;
}

export interface LevelOptions {
  readonly pivotLeft?: number;
  readonly pivotRight?: number;
  readonly lookback?: number;
  /** Pivots within this many ATR of each other merge into one zone. */
  readonly clusterAtr?: number;
  /** Half-width of a zone, in ATR. */
  readonly zoneWidthAtr?: number;
  /** Levels older than this many bars are dropped entirely. */
  readonly maxAgeBars?: number;
  readonly maxZones?: number;
}

export function findLevels(candles: readonly Candle[], opts: LevelOptions = {}): LevelZone[] {
  const left = opts.pivotLeft ?? 3;
  const right = opts.pivotRight ?? 3;
  const lookback = opts.lookback ?? 400;
  const clusterAtr = opts.clusterAtr ?? 0.5;
  const zoneWidthAtr = opts.zoneWidthAtr ?? 0.3;
  const maxAge = opts.maxAgeBars ?? 400;
  const maxZones = opts.maxZones ?? 12;

  if (candles.length < 30) return [];

  const endIndex = candles.length - 1;
  const price = candles[endIndex].close;
  const atrSeries = atr(candles, 14);
  const currentAtr =
    Number.isFinite(atrSeries[endIndex]) && atrSeries[endIndex] > 0
      ? atrSeries[endIndex]
      : price * 0.01;

  const atrAt = (i: number): number => {
    const v = atrSeries[i];
    return Number.isFinite(v) && v > 0 ? v : price * 0.01;
  };

  const from = Math.max(0, candles.length - lookback);
  const pivots = findPivots(candles, left, right)
    .filter((p) => p.confirmedAt <= endIndex && p.index >= from);

  if (pivots.length === 0) return [];

  // ── cluster pivots into zones ────────────────────────────────────────────
  const clusters = clusterPivots(pivots, atrAt, clusterAtr);

  const zones: LevelZone[] = [];
  for (const cluster of clusters) {
    const centre = weightedCentre(cluster);
    const halfWidth = Math.max(atrAt(cluster[cluster.length - 1].index) * zoneWidthAtr, centre * 0.0008);
    const low = centre - halfWidth;
    const high = centre + halfWidth;

    // Every bar that entered the zone counts as a touch, not just the pivots.
    const touches = collectTouches(candles, low, high, from);
    if (touches.length === 0) continue;

    const lastTouch = touches[touches.length - 1];
    const barsSince = endIndex - lastTouch.index;
    if (barsSince > maxAge) continue;

    const holdCount = touches.filter((t) => t.held).length;
    const breakCount = touches.length - holdCount;
    const volume = touches.reduce((s, t) => s + t.volume, 0);
    const avgVolume = average(candles.slice(from).map((c) => c.volume));

    const kind = classifyKind(centre, price, touches, candles);
    const strength = scoreStrength({
      touchCount: touches.length,
      holdCount,
      breakCount,
      volume,
      avgVolume,
      barsSince,
      maxAge,
      kind,
    });

    zones.push({
      price: centre,
      low,
      high,
      kind,
      touches,
      touchCount: touches.length,
      holdCount,
      breakCount,
      volume,
      barsSinceTouch: barsSince,
      strength,
      distancePct: ((centre - price) / price) * 100,
      distanceAtr: (centre - price) / currentAtr,
      arabic: describeZone(centre, kind, touches.length, holdCount, breakCount, barsSince, strength),
    });
  }

  zones.sort((a, b) => b.strength - a.strength);
  return zones.slice(0, maxZones);
}

function clusterPivots(
  pivots: readonly Pivot[],
  atrAt: (i: number) => number,
  clusterAtr: number,
): Pivot[][] {
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: Pivot[][] = [];
  let current: Pivot[] = [];

  for (const p of sorted) {
    if (current.length === 0) {
      current = [p];
      continue;
    }
    const reference = current[current.length - 1];
    const tolerance = atrAt(p.index) * clusterAtr;
    if (Math.abs(p.price - reference.price) <= tolerance) {
      current.push(p);
    } else {
      clusters.push(current);
      current = [p];
    }
  }
  if (current.length) clusters.push(current);
  return clusters;
}

/** Volume-weighted, so the price where size actually traded anchors the zone. */
function weightedCentre(cluster: readonly Pivot[]): number {
  const totalVolume = cluster.reduce((s, p) => s + p.volume, 0);
  if (totalVolume <= 0) return average(cluster.map((p) => p.price));
  return cluster.reduce((s, p) => s + p.price * p.volume, 0) / totalVolume;
}

/**
 * A touch is a bar whose range intersects the zone. It HELD if the bar closed
 * back out of the zone on the side it came from; it BROKE if it closed through.
 */
function collectTouches(
  candles: readonly Candle[],
  low: number,
  high: number,
  from: number,
): LevelTouch[] {
  const out: LevelTouch[] = [];
  let lastTouchIndex = -99;

  for (let i = from; i < candles.length; i++) {
    const c = candles[i];
    if (c.high < low || c.low > high) continue;
    // Collapse consecutive bars into one touch: price sitting inside a zone
    // for six bars is one visit, not six tests.
    if (i - lastTouchIndex < 3) {
      lastTouchIndex = i;
      continue;
    }
    lastTouchIndex = i;

    const approachedFromBelow = i > 0 ? candles[i - 1].close < low : c.open < low;
    const held = approachedFromBelow ? c.close < high : c.close > low;

    out.push({ index: i, time: c.openTime, price: c.close, volume: c.volume, held });
  }
  return out;
}

function classifyKind(
  centre: number,
  price: number,
  touches: readonly LevelTouch[],
  candles: readonly Candle[],
): LevelKind {
  const above = centre > price;

  // Did price spend time on the OTHER side of this level earlier? If so the
  // level has flipped, which is a stronger level than one that never broke.
  const firstTouch = touches[0];
  if (firstTouch) {
    const before = candles.slice(Math.max(0, firstTouch.index - 20), firstTouch.index);
    if (before.length > 0) {
      const wasAbove = before.filter((c) => c.close > centre).length / before.length;
      if (above && wasAbove < 0.25) return "resistance";
      if (!above && wasAbove > 0.75) return "flipped_support";
      if (above && wasAbove > 0.75) return "flipped_resistance";
    }
  }
  return above ? "resistance" : "support";
}

function scoreStrength(x: {
  touchCount: number;
  holdCount: number;
  breakCount: number;
  volume: number;
  avgVolume: number;
  barsSince: number;
  maxAge: number;
  kind: LevelKind;
}): number {
  // 1. Touches — real but saturating. The 8th test is not 8× the 1st.
  const touchScore = Math.min(30, x.touchCount * 9);

  // 2. Volume relative to the market's own normal.
  const volumeRatio = x.avgVolume > 0 ? x.volume / (x.avgVolume * Math.max(1, x.touchCount)) : 1;
  const volumeScore = Math.min(25, volumeRatio * 14);

  // 3. Hold ratio — the most informative of the four. A level that broke every
  //    time it was tested is not a level, it is a line on a chart.
  const holdRatio = x.touchCount > 0 ? x.holdCount / x.touchCount : 0;
  const holdScore = holdRatio * 25;

  // 4. Recency, decaying smoothly rather than by cliff.
  const recency = Math.max(0, 1 - x.barsSince / x.maxAge);
  const recencyScore = recency * 15;

  // A flipped level has already proved itself in both roles.
  const flipBonus = x.kind.startsWith("flipped") ? 5 : 0;

  return Math.round(Math.min(100, touchScore + volumeScore + holdScore + recencyScore + flipBonus));
}

function describeZone(
  centre: number,
  kind: LevelKind,
  touches: number,
  holds: number,
  breaks: number,
  barsSince: number,
  strength: number,
): string {
  const parts: string[] = [
    `${LEVEL_KIND_AR[kind]} عند ${centre.toFixed(4)} بقوّة ${strength} من 100.`,
    `اختُبر ${touches} ${touches === 1 ? "مرة" : "مرات"}، صمد ${holds} وكُسر ${breaks}.`,
  ];
  if (barsSince <= 5) parts.push("وهو قريب زمنياً — اختُبر قبل شمعات قليلة.");
  else if (barsSince > 200) parts.push(`لكنه قديم (${barsSince} شمعة) وقلّ وزنه.`);
  if (breaks > holds) parts.push("كُسر أكثر مما صمد — لا يُعتمد عليه كحاجز.");
  return parts.join(" ");
}

const average = (v: readonly number[]): number =>
  v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length;

/** Nearest zone above the price — a target candidate. */
export function nearestResistance(zones: readonly LevelZone[], price: number): LevelZone | null {
  return zones.filter((z) => z.low > price).sort((a, b) => a.low - b.low)[0] ?? null;
}

/** Nearest zone below the price — a stop-placement candidate. */
export function nearestSupport(zones: readonly LevelZone[], price: number): LevelZone | null {
  return zones.filter((z) => z.high < price).sort((a, b) => b.high - a.high)[0] ?? null;
}

/** All zones above the price, nearest first — the ladder of targets. */
export function resistancesAbove(zones: readonly LevelZone[], price: number): LevelZone[] {
  return zones.filter((z) => z.low > price).sort((a, b) => a.low - b.low);
}

/** All zones below the price, nearest first. */
export function supportsBelow(zones: readonly LevelZone[], price: number): LevelZone[] {
  return zones.filter((z) => z.high < price).sort((a, b) => b.high - a.high);
}

/** Is the price currently inside a zone? Entry timing depends on this. */
export function zoneContaining(zones: readonly LevelZone[], price: number): LevelZone | null {
  return zones.find((z) => price >= z.low && price <= z.high) ?? null;
}
