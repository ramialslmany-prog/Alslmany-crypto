/**
 * Market structure: the sequence of swing highs and lows, and what it means
 * when one of them breaks.
 *
 *   uptrend    higher highs AND higher lows
 *   downtrend  lower highs AND lower lows
 *   range      anything else
 *
 * Two kinds of break, and conflating them is a classic and expensive error:
 *
 *   BOS  (Break of Structure)     — price breaks the swing in the SAME
 *                                   direction as the trend. Continuation.
 *                                   An uptrend taking out its last high.
 *   CHoCH (Change of Character)   — price breaks the swing AGAINST the trend.
 *                                   The first warning the trend may be over.
 *                                   An uptrend losing its last higher low.
 *
 * A BOS is a reason to stay in. A CHoCH is a reason to get out. Treating them
 * the same means adding to a position exactly as it turns.
 *
 * BREAKS ARE MEASURED ON CLOSES, not wicks, by default. A wick through a level
 * that closes back inside is a liquidity sweep — often the exact opposite
 * signal — and counting it as a break is how a stop-hunt gets traded as a
 * breakout. Both readings are returned so Stage 8 can tell them apart.
 */
import { type Pivot, findPivots, pivotHighs, pivotLows } from "@/core/indicators/pivots";
import { atr } from "@/core/indicators/volatility";
import type { Candle } from "@/core/types";

export type StructureState = "uptrend" | "downtrend" | "range";

export const STRUCTURE_AR: Record<StructureState, string> = {
  uptrend: "قمم أعلى وقيعان أعلى",
  downtrend: "قمم أدنى وقيعان أدنى",
  range: "هيكل مختلط — لا تسلسل واضح",
};

export type BreakKind = "bos" | "choch";

export interface StructureBreak {
  readonly kind: BreakKind;
  readonly direction: "up" | "down";
  /** Index of the candle that broke it. */
  readonly index: number;
  readonly time: number;
  /** The swing level that was broken. */
  readonly level: number;
  /** Index of the pivot that formed that level. */
  readonly pivotIndex: number;
  /** True when the close cleared the level; false when only the wick did. */
  readonly closedBeyond: boolean;
  /** How far beyond, in ATR units — a 0.05-ATR break is barely a break. */
  readonly displacementAtr: number;
  readonly arabic: string;
}

export interface SwingPoint {
  readonly index: number;
  readonly price: number;
  readonly time: number;
  readonly kind: "high" | "low";
  /** Compared with the previous swing of the same kind. */
  readonly relation: "higher" | "lower" | "equal" | "first";
}

export interface MarketStructure {
  readonly state: StructureState;
  /** Swings in time order, labelled HH / HL / LH / LL. */
  readonly swings: readonly SwingPoint[];
  /** The most recent confirmed swing high and low. */
  readonly lastHigh: SwingPoint | null;
  readonly lastLow: SwingPoint | null;
  /** All breaks found in the lookback, oldest first. */
  readonly breaks: readonly StructureBreak[];
  /** The most recent break of any kind. */
  readonly lastBreak: StructureBreak | null;
  /** How many consecutive swings confirm the current state. */
  readonly consistency: number;
  readonly arabic: string;
}

export interface StructureOptions {
  readonly pivotLeft?: number;
  readonly pivotRight?: number;
  /** Only consider this many bars back. */
  readonly lookback?: number;
  /**
   * Swings within this fraction of ATR are treated as EQUAL rather than as a
   * new high or low. Without it, a 0.01% higher high reads as a genuine
   * continuation when it is really a double top.
   */
  readonly equalTolerancAtr?: number;
}

export function analyzeStructure(
  candles: readonly Candle[],
  opts: StructureOptions = {},
): MarketStructure {
  const left = opts.pivotLeft ?? 3;
  const right = opts.pivotRight ?? 3;
  const lookback = opts.lookback ?? 250;
  const equalTol = opts.equalTolerancAtr ?? 0.15;

  const endIndex = candles.length - 1;
  const from = Math.max(0, candles.length - lookback);

  const atrSeries = atr(candles, 14);
  const atrAt = (i: number): number => {
    const v = atrSeries[i];
    return Number.isFinite(v) && v > 0 ? v : candles[i].close * 0.01;
  };

  // Confirmed pivots only — an unconfirmed swing is a swing that may not exist.
  const pivots = findPivots(candles, left, right)
    .filter((p) => p.confirmedAt <= endIndex && p.index >= from);

  const swings = labelSwings(pivots, atrAt, equalTol);
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  const lastHigh = highs[highs.length - 1] ?? null;
  const lastLow = lows[lows.length - 1] ?? null;

  const state = classify(highs, lows);
  const consistency = countConsistent(swings, state);
  const breaks = findBreaks(candles, swings, state, atrAt, from);
  const lastBreak = breaks.length ? breaks[breaks.length - 1] : null;

  return {
    state,
    swings,
    lastHigh,
    lastLow,
    breaks,
    lastBreak,
    consistency,
    arabic: narrate(state, swings, lastHigh, lastLow, lastBreak, consistency),
  };
}

function labelSwings(
  pivots: readonly Pivot[],
  atrAt: (i: number) => number,
  equalTol: number,
): SwingPoint[] {
  const out: SwingPoint[] = [];
  let prevHigh: number | null = null;
  let prevLow: number | null = null;

  for (const p of pivots) {
    const tolerance = atrAt(p.index) * equalTol;
    let relation: SwingPoint["relation"];

    if (p.kind === "high") {
      if (prevHigh === null) relation = "first";
      else if (Math.abs(p.price - prevHigh) <= tolerance) relation = "equal";
      else relation = p.price > prevHigh ? "higher" : "lower";
      prevHigh = p.price;
    } else {
      if (prevLow === null) relation = "first";
      else if (Math.abs(p.price - prevLow) <= tolerance) relation = "equal";
      else relation = p.price > prevLow ? "higher" : "lower";
      prevLow = p.price;
    }

    out.push({ index: p.index, price: p.price, time: p.time, kind: p.kind, relation });
  }
  return out;
}

/**
 * Classify from the LAST TWO swings of each kind. Older structure is history;
 * what matters is whether the most recent high and low are still stacking in
 * the same direction.
 */
function classify(highs: readonly SwingPoint[], lows: readonly SwingPoint[]): StructureState {
  const h = highs[highs.length - 1];
  const l = lows[lows.length - 1];
  if (!h || !l || h.relation === "first" || l.relation === "first") return "range";

  if (h.relation === "higher" && l.relation === "higher") return "uptrend";
  if (h.relation === "lower" && l.relation === "lower") return "downtrend";
  return "range";
}

/** How many of the trailing swings agree with the classification. */
function countConsistent(swings: readonly SwingPoint[], state: StructureState): number {
  if (state === "range") return 0;
  const want = state === "uptrend" ? "higher" : "lower";
  let n = 0;
  for (let i = swings.length - 1; i >= 0; i--) {
    if (swings[i].relation === want) n++;
    else if (swings[i].relation !== "first") break;
  }
  return n;
}

/**
 * Walk forward looking for the first candle that takes out each swing, and
 * decide whether that break continues the trend (BOS) or contradicts it
 * (CHoCH).
 */
function findBreaks(
  candles: readonly Candle[],
  swings: readonly SwingPoint[],
  state: StructureState,
  atrAt: (i: number) => number,
  from: number,
): StructureBreak[] {
  const out: StructureBreak[] = [];

  for (const swing of swings) {
    // A swing can only be broken by a bar AFTER it was confirmed.
    for (let i = swing.index + 1; i < candles.length; i++) {
      if (i < from) continue;
      const c = candles[i];

      const brokenByWick = swing.kind === "high" ? c.high > swing.price : c.low < swing.price;
      if (!brokenByWick) continue;

      const closedBeyond = swing.kind === "high" ? c.close > swing.price : c.close < swing.price;
      const direction: "up" | "down" = swing.kind === "high" ? "up" : "down";

      // Continuation when the break runs WITH the structure.
      const kind: BreakKind =
        (state === "uptrend" && direction === "up") || (state === "downtrend" && direction === "down")
          ? "bos"
          : "choch";

      const displacement = Math.abs(c.close - swing.price) / atrAt(i);

      out.push({
        kind,
        direction,
        index: i,
        time: c.openTime,
        level: swing.price,
        pivotIndex: swing.index,
        closedBeyond,
        displacementAtr: displacement,
        arabic: describeBreak(kind, direction, closedBeyond, displacement),
      });
      break; // only the FIRST break of each swing matters
    }
  }

  out.sort((a, b) => a.index - b.index);
  return out;
}

function describeBreak(
  kind: BreakKind,
  direction: "up" | "down",
  closedBeyond: boolean,
  displacementAtr: number,
): string {
  const what = direction === "up" ? "كسر لقمة" : "كسر لقاع";
  if (!closedBeyond) {
    return `${what} بالظل فقط دون إغلاق — هذا كنس سيولة لا كسر حقيقي، وغالباً يعني العكس.`;
  }
  const weak = displacementAtr < 0.25;
  const label = kind === "bos"
    ? "كسر هيكلي مؤكّد في اتجاه الهيكل — استمرار"
    : "تغيّر في الطابع ضدّ الهيكل — أول إنذار بانتهاء الاتجاه";
  return `${what} بإغلاق. ${label}.` +
    (weak ? ` لكن الاختراق ضعيف (${displacementAtr.toFixed(2)} من ATR) وقد يُلغى.` : "");
}

function narrate(
  state: StructureState,
  swings: readonly SwingPoint[],
  lastHigh: SwingPoint | null,
  lastLow: SwingPoint | null,
  lastBreak: StructureBreak | null,
  consistency: number,
): string {
  const parts: string[] = [];

  if (swings.length < 2) {
    return "لا توجد نقاط محورية مؤكّدة كافية لتصنيف الهيكل على هذا الإطار.";
  }

  parts.push(`الهيكل: ${STRUCTURE_AR[state]}.`);
  if (state !== "range" && consistency >= 2) {
    parts.push(`و${consistency} تأرجحات متتالية تؤكّده.`);
  }

  if (lastHigh && lastLow) {
    const order = lastHigh.index > lastLow.index ? "قمة" : "قاع";
    parts.push(
      `آخر قمة مؤكّدة عند ${lastHigh.price.toFixed(4)} وآخر قاع عند ${lastLow.price.toFixed(4)}، وآخرهما تشكّلاً هو ال${order}.`,
    );
  }

  if (lastBreak) {
    parts.push(`آخر حدث هيكلي: ${lastBreak.arabic}`);
  } else {
    parts.push("لم يُكسر أي تأرجح مؤكّد بعد داخل نافذة التحليل.");
  }

  // The equal-highs case is worth calling out: it is a double top forming.
  const equalHighs = swings.filter((s) => s.kind === "high" && s.relation === "equal").length;
  const equalLows = swings.filter((s) => s.kind === "low" && s.relation === "equal").length;
  if (equalHighs >= 1) parts.push("توجد قمم متساوية — سيولة متراكمة فوقها.");
  if (equalLows >= 1) parts.push("توجد قيعان متساوية — سيولة متراكمة تحتها.");

  return parts.join(" ");
}
