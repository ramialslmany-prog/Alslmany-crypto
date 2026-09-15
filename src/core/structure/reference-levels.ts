/**
 * Reference levels that exist independently of swing structure:
 * Fibonacci on the last swing, prior period highs/lows, price gaps, and the
 * volume profile's point of control.
 *
 * These matter because they are levels OTHER PARTICIPANTS are watching. The
 * previous day's high is not special because of any property of price — it is
 * special because a large number of stops and orders sit there.
 */
import { atr } from "@/core/indicators/volatility";
import { type Pivot, findPivots } from "@/core/indicators/pivots";
import { type Timeframe, candleOpenTime } from "@/shared/time";
import type { Candle } from "@/core/types";

// ── Fibonacci ────────────────────────────────────────────────────────────────

/** The retracement levels worth drawing. 0.5 is not a Fibonacci number but is
 *  watched by enough participants to behave like one. */
export const FIB_RETRACEMENTS = [0.236, 0.382, 0.5, 0.618, 0.786] as const;
/** Extensions used as target candidates once a swing is exceeded. */
export const FIB_EXTENSIONS = [1.272, 1.414, 1.618, 2.0] as const;

export interface FibLevel {
  readonly ratio: number;
  readonly price: number;
  readonly kind: "retracement" | "extension";
  readonly label: string;
}

export interface FibonacciResult {
  /** The swing the levels are measured from. */
  readonly swingHigh: number;
  readonly swingLow: number;
  readonly swingHighIndex: number;
  readonly swingLowIndex: number;
  /** "up" when the low came first — retracements measured down from the high. */
  readonly direction: "up" | "down";
  readonly levels: readonly FibLevel[];
  /** Where price currently sits as a fraction of the swing, 0..1. */
  readonly currentRetracement: number;
  /** The golden-pocket band, 0.618–0.65, where continuation entries cluster. */
  readonly inGoldenPocket: boolean;
  readonly arabic: string;
}

/**
 * Fibonacci on the most recent completed swing.
 *
 * "Most recent completed" means the last confirmed pivot high and pivot low,
 * whichever pair is newest. Anchoring to an arbitrary window would produce
 * levels nobody else is looking at, which defeats the purpose.
 */
export function fibonacci(candles: readonly Candle[], lookback = 150): FibonacciResult | null {
  if (candles.length < 20) return null;
  const endIndex = candles.length - 1;
  const from = Math.max(0, candles.length - lookback);

  const pivots = findPivots(candles, 3, 3).filter(
    (p) => p.confirmedAt <= endIndex && p.index >= from,
  );
  const highs = pivots.filter((p) => p.kind === "high");
  const lows = pivots.filter((p) => p.kind === "low");
  if (highs.length === 0 || lows.length === 0) return null;

  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];

  // Direction is decided by which extreme formed LAST.
  const direction: "up" | "down" = lastLow.index < lastHigh.index ? "up" : "down";
  const span = lastHigh.price - lastLow.price;
  if (span <= 0) return null;

  const levels: FibLevel[] = [];
  for (const r of FIB_RETRACEMENTS) {
    // An up-swing retraces DOWN from the high; a down-swing retraces UP.
    const price = direction === "up" ? lastHigh.price - span * r : lastLow.price + span * r;
    levels.push({ ratio: r, price, kind: "retracement", label: `${(r * 100).toFixed(1)}%` });
  }
  for (const r of FIB_EXTENSIONS) {
    const price = direction === "up" ? lastLow.price + span * r : lastHigh.price - span * r;
    levels.push({ ratio: r, price, kind: "extension", label: `${(r * 100).toFixed(1)}%` });
  }
  levels.sort((a, b) => a.price - b.price);

  const price = candles[endIndex].close;
  const currentRetracement =
    direction === "up" ? (lastHigh.price - price) / span : (price - lastLow.price) / span;
  const inGoldenPocket = currentRetracement >= 0.618 && currentRetracement <= 0.65;

  return {
    swingHigh: lastHigh.price,
    swingLow: lastLow.price,
    swingHighIndex: lastHigh.index,
    swingLowIndex: lastLow.index,
    direction,
    levels,
    currentRetracement,
    inGoldenPocket,
    arabic:
      `التأرجح الأخير ${direction === "up" ? "صاعد" : "هابط"} من ${lastLow.price.toFixed(4)} إلى ${lastHigh.price.toFixed(4)}. ` +
      `السعر مرتدّ ${(currentRetracement * 100).toFixed(1)}% منه` +
      (inGoldenPocket
        ? "، وهو داخل الجيب الذهبي 61.8–65% حيث تتجمّع عادةً صفقات استمرار الاتجاه."
        : currentRetracement > 1
          ? "، أي أنه تجاوز التأرجح بالكامل — الهيكل تغيّر."
          : "."),
  };
}

// ── prior period extremes ────────────────────────────────────────────────────

export type PeriodKind = "day" | "week" | "month";

export interface PeriodExtreme {
  readonly period: PeriodKind;
  readonly which: "high" | "low";
  readonly price: number;
  readonly periodStart: number;
  readonly label: string;
}

/**
 * Previous day / week / month highs and lows.
 *
 * The PREVIOUS period, not the current one: the current day's high is still
 * moving and cannot act as a reference. Built from whatever timeframe of
 * candles we have by grouping them.
 */
export function periodExtremes(
  candles: readonly Candle[],
  timeframe: Timeframe,
): PeriodExtreme[] {
  if (candles.length === 0) return [];
  const out: PeriodExtreme[] = [];

  const groupStart = (ts: number, period: PeriodKind): number => {
    if (period === "day") return candleOpenTime(ts, "1d");
    if (period === "week") return candleOpenTime(ts, "1w");
    const d = new Date(ts);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  };

  // Only meaningful for timeframes finer than the period itself.
  const periods: PeriodKind[] =
    timeframe === "1w" ? ["month"] : timeframe === "1d" ? ["week", "month"] : ["day", "week", "month"];

  for (const period of periods) {
    const groups = new Map<number, { high: number; low: number }>();
    for (const c of candles) {
      const key = groupStart(c.openTime, period);
      const g = groups.get(key);
      if (!g) groups.set(key, { high: c.high, low: c.low });
      else {
        g.high = Math.max(g.high, c.high);
        g.low = Math.min(g.low, c.low);
      }
    }

    const keys = [...groups.keys()].sort((a, b) => a - b);
    // The last key is the CURRENT, still-forming period — skip it.
    const previousKey = keys[keys.length - 2];
    if (previousKey === undefined) continue;
    const g = groups.get(previousKey)!;

    const ar = period === "day" ? "اليوم السابق" : period === "week" ? "الأسبوع السابق" : "الشهر السابق";
    out.push({ period, which: "high", price: g.high, periodStart: previousKey, label: `قمة ${ar}` });
    out.push({ period, which: "low", price: g.low, periodStart: previousKey, label: `قاع ${ar}` });
  }
  return out;
}

// ── price gaps (fair value gaps) ─────────────────────────────────────────────

export interface PriceGap {
  readonly direction: "bullish" | "bearish";
  readonly top: number;
  readonly bottom: number;
  readonly index: number;
  readonly time: number;
  /** How much of the gap has since been traded back through, 0..1. */
  readonly filledFraction: number;
  readonly filled: boolean;
  /** Gap size in ATR — a 0.1-ATR gap is noise. */
  readonly sizeAtr: number;
  readonly arabic: string;
}

/**
 * Three-bar imbalances: a range of price that was skipped so fast no trading
 * happened there. Markets revisit them often enough to make them useful as
 * both targets and invalidation references.
 */
export function findGaps(candles: readonly Candle[], minSizeAtr = 0.25, lookback = 200): PriceGap[] {
  if (candles.length < 5) return [];
  const out: PriceGap[] = [];
  const atrSeries = atr(candles, 14);
  const from = Math.max(1, candles.length - lookback);

  for (let i = from; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];
    const a = atrSeries[i];
    const atrValue = Number.isFinite(a) && a > 0 ? a : candles[i].close * 0.01;

    // Bullish: the previous high never met the next low.
    if (next.low > prev.high) {
      const size = next.low - prev.high;
      if (size / atrValue >= minSizeAtr) {
        out.push(buildGap("bullish", next.low, prev.high, i, candles, atrValue));
      }
    }
    // Bearish: the previous low never met the next high.
    if (next.high < prev.low) {
      const size = prev.low - next.high;
      if (size / atrValue >= minSizeAtr) {
        out.push(buildGap("bearish", prev.low, next.high, i, candles, atrValue));
      }
    }
  }
  return out;
}

function buildGap(
  direction: PriceGap["direction"],
  top: number,
  bottom: number,
  index: number,
  candles: readonly Candle[],
  atrValue: number,
): PriceGap {
  const size = top - bottom;
  // How far back into the gap price has since traded.
  let deepest = direction === "bullish" ? top : bottom;
  for (let j = index + 2; j < candles.length; j++) {
    if (direction === "bullish") deepest = Math.min(deepest, candles[j].low);
    else deepest = Math.max(deepest, candles[j].high);
  }
  const penetration = direction === "bullish" ? top - deepest : deepest - bottom;
  const filledFraction = size > 0 ? Math.max(0, Math.min(1, penetration / size)) : 1;

  return {
    direction,
    top,
    bottom,
    index,
    time: candles[index].openTime,
    filledFraction,
    filled: filledFraction >= 0.99,
    sizeAtr: size / atrValue,
    arabic:
      `فجوة ${direction === "bullish" ? "صاعدة" : "هابطة"} بين ${bottom.toFixed(4)} و${top.toFixed(4)} ` +
      (filledFraction >= 0.99
        ? "مملوءة بالكامل — لم تعد هدفاً."
        : `مملوءة ${(filledFraction * 100).toFixed(0)}% — ما تبقّى منها يبقى هدفاً محتملاً.`),
  };
}

// ── volume profile ───────────────────────────────────────────────────────────

export interface VolumeProfile {
  /** Price with the most volume traded — the fair-value magnet. */
  readonly poc: number;
  /** The band containing 70% of volume. */
  readonly valueAreaHigh: number;
  readonly valueAreaLow: number;
  readonly bins: readonly { price: number; volume: number }[];
  /** Where the current price sits relative to the value area. */
  readonly pricePosition: "above" | "inside" | "below";
  readonly arabic: string;
}

/**
 * Volume profile by price.
 *
 * Each candle's volume is spread evenly across its own range rather than
 * dumped at its close. Dumping at the close would put all of a wide bar's
 * volume at one price it barely touched, which is both wrong and the easier
 * thing to implement.
 */
export function volumeProfile(candles: readonly Candle[], bins = 60, lookback = 250): VolumeProfile | null {
  const window = candles.slice(Math.max(0, candles.length - lookback));
  if (window.length < 10) return null;

  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  if (!(high > low)) return null;

  const binSize = (high - low) / bins;
  const volumes = new Array<number>(bins).fill(0);

  for (const c of window) {
    const startBin = Math.max(0, Math.floor((c.low - low) / binSize));
    const endBin = Math.min(bins - 1, Math.floor((c.high - low) / binSize));
    const span = endBin - startBin + 1;
    const perBin = c.volume / span;
    for (let b = startBin; b <= endBin; b++) volumes[b] += perBin;
  }

  const priceOf = (b: number): number => low + (b + 0.5) * binSize;

  let pocBin = 0;
  for (let b = 1; b < bins; b++) if (volumes[b] > volumes[pocBin]) pocBin = b;

  // Grow outward from the POC until 70% of total volume is enclosed.
  const total = volumes.reduce((a, b) => a + b, 0);
  const target = total * 0.7;
  let lowBin = pocBin;
  let highBin = pocBin;
  let captured = volumes[pocBin];
  while (captured < target && (lowBin > 0 || highBin < bins - 1)) {
    const below = lowBin > 0 ? volumes[lowBin - 1] : -1;
    const above = highBin < bins - 1 ? volumes[highBin + 1] : -1;
    if (above >= below) {
      highBin++;
      captured += volumes[highBin];
    } else {
      lowBin--;
      captured += volumes[lowBin];
    }
  }

  const poc = priceOf(pocBin);
  const valueAreaHigh = priceOf(highBin) + binSize / 2;
  const valueAreaLow = priceOf(lowBin) - binSize / 2;
  const price = candles[candles.length - 1].close;
  const pricePosition: VolumeProfile["pricePosition"] =
    price > valueAreaHigh ? "above" : price < valueAreaLow ? "below" : "inside";

  return {
    poc,
    valueAreaHigh,
    valueAreaLow,
    bins: volumes.map((v, b) => ({ price: priceOf(b), volume: v })),
    pricePosition,
    arabic:
      `أكثر سعر تداولاً ${poc.toFixed(4)}، ومنطقة القيمة بين ${valueAreaLow.toFixed(4)} و${valueAreaHigh.toFixed(4)}. ` +
      (pricePosition === "inside"
        ? "السعر داخل منطقة القيمة — سوق متوازن، والاختراقات منه غالباً كاذبة."
        : pricePosition === "above"
          ? "السعر فوق منطقة القيمة — ممتدّ، وأكثر سعر تداولاً يعمل مغناطيساً تحته."
          : "السعر تحت منطقة القيمة — ممتدّ هبوطاً، وأكثر سعر تداولاً يعمل مغناطيساً فوقه."),
  };
}
