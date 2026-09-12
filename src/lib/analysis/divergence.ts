import type { Candle } from "@/lib/market/types";
import { closes, macd, rsi, type Line } from "./indicators";
import { findSwings, type Swing } from "./structure";

/**
 * Divergence between price and momentum.
 *
 * The methodology reference singles this out as the most important technical
 * signal, and the reason is that it is one of the few that leads rather than
 * confirms. Price making a higher high while momentum makes a lower high means
 * the second push was weaker than the first — the move is running on fewer
 * participants, and it frequently precedes a reversal.
 *
 * Four kinds, and the distinction matters:
 *  - Regular bearish: price HH, momentum LH  → uptrend exhausting
 *  - Regular bullish: price LL, momentum HL  → downtrend exhausting
 *  - Hidden bullish:  price HL, momentum LL  → uptrend continuing
 *  - Hidden bearish:  price LH, momentum HH  → downtrend continuing
 *
 * Regular divergence warns of reversal; hidden divergence confirms trend. They
 * are opposite conclusions from superficially similar geometry, which is why
 * they are detected separately rather than collapsed into "divergence".
 */

export type DivergenceKind =
  | "regular-bullish"
  | "regular-bearish"
  | "hidden-bullish"
  | "hidden-bearish";

export type Divergence = {
  kind: DivergenceKind;
  indicator: "rsi" | "macd";
  /** Bars since the most recent of the two pivots. */
  barsAgo: number;
  /** 0–100: how pronounced the disagreement is. */
  strength: number;
  priceFrom: number;
  priceTo: number;
  indicatorFrom: number;
  indicatorTo: number;
};

/** Read an indicator at a swing's index, tolerating a null with a small search. */
function valueAt(line: Line, index: number): number | null {
  for (let offset = 0; offset <= 2; offset++) {
    const a = line[index - offset];
    if (a !== null && a !== undefined && Number.isFinite(a)) return a;
    const b = line[index + offset];
    if (b !== null && b !== undefined && Number.isFinite(b)) return b;
  }
  return null;
}

function detect(
  candles: Candle[],
  line: Line,
  indicator: "rsi" | "macd",
  swings: Swing[],
  /** Ignore pivots older than this; stale divergence is not actionable. */
  maxBarsAgo: number,
): Divergence[] {
  const out: Divergence[] = [];
  const total = candles.length;

  for (const kindGroup of ["high", "low"] as const) {
    const pivots = swings.filter((s) => s.kind === kindGroup).slice(-4);
    if (pivots.length < 2) continue;

    // Compare the latest pivot against each earlier one, newest pairing first.
    const latest = pivots[pivots.length - 1];
    if (total - latest.index > maxBarsAgo) continue;

    for (let i = pivots.length - 2; i >= 0; i--) {
      const earlier = pivots[i];
      // Pivots too close together describe noise, not a swing structure.
      if (latest.index - earlier.index < 5) continue;

      const indLatest = valueAt(line, latest.index);
      const indEarlier = valueAt(line, earlier.index);
      if (indLatest === null || indEarlier === null) continue;

      const priceUp = latest.price > earlier.price;
      const indUp = indLatest > indEarlier;
      if (priceUp === indUp) continue; // they agree — no divergence

      let kind: DivergenceKind | null = null;
      if (kindGroup === "high") {
        // Highs: price up + momentum down = regular bearish (reversal warning).
        //        price down + momentum up = hidden bearish (trend continues down).
        kind = priceUp ? "regular-bearish" : "hidden-bearish";
      } else {
        // Lows: price down + momentum up = regular bullish (reversal warning).
        //       price up + momentum down = hidden bullish (trend continues up).
        kind = priceUp ? "hidden-bullish" : "regular-bullish";
      }

      const priceDelta = Math.abs((latest.price - earlier.price) / earlier.price) * 100;
      const indDelta = Math.abs(indLatest - indEarlier);
      // Both legs must actually move; a flat pair is not a disagreement.
      if (priceDelta < 0.4 || indDelta < 1.5) continue;

      out.push({
        kind,
        indicator,
        barsAgo: total - 1 - latest.index,
        strength: Math.round(Math.min(100, priceDelta * 6 + indDelta * 2.5)),
        priceFrom: earlier.price,
        priceTo: latest.price,
        indicatorFrom: indEarlier,
        indicatorTo: indLatest,
      });
      break; // one pairing per pivot group is enough
    }
  }

  return out;
}

/**
 * Find divergences on a series.
 * RSI and MACD are checked independently; agreement between the two is
 * meaningfully stronger evidence than either alone.
 */
export function findDivergences(candles: Candle[], maxBarsAgo = 20): Divergence[] {
  if (candles.length < 60) return [];

  const c = closes(candles);
  const swings = findSwings(candles, 3);
  if (swings.length < 2) return [];

  return [
    ...detect(candles, rsi(c, 14), "rsi", swings, maxBarsAgo),
    ...detect(candles, macd(c).histogram, "macd", swings, maxBarsAgo),
  ].sort((a, b) => a.barsAgo - b.barsAgo);
}

export type DivergenceRead = {
  divergences: Divergence[];
  /** Signed contribution to the directional score. */
  score: number;
  /** True when RSI and MACD both show a reversal divergence in the same direction. */
  confirmed: boolean;
  warnings: string[];
};

/** Weights: reversal warnings outrank continuation signals, and recency matters. */
const WEIGHT: Record<DivergenceKind, number> = {
  "regular-bearish": -14,
  "regular-bullish": 12,
  "hidden-bullish": 7,
  "hidden-bearish": -7,
};

export function readDivergences(candles: Candle[]): DivergenceRead {
  const divergences = findDivergences(candles);
  const warnings: string[] = [];
  let score = 0;

  for (const d of divergences) {
    // Decay with age — a divergence twenty bars old has largely played out.
    const recency = Math.max(0.35, 1 - d.barsAgo / 30);
    const magnitude = 0.6 + (d.strength / 100) * 0.4;
    score += WEIGHT[d.kind] * recency * magnitude;
  }

  const bearish = divergences.filter((d) => d.kind === "regular-bearish");
  const bullish = divergences.filter((d) => d.kind === "regular-bullish");

  const confirmed =
    new Set(bearish.map((d) => d.indicator)).size >= 2 ||
    new Set(bullish.map((d) => d.indicator)).size >= 2;

  if (bearish.length > 0) warnings.push("warn.bearishDivergence");

  return {
    divergences,
    score: Math.max(-30, Math.min(30, Math.round(score))),
    confirmed,
    warnings,
  };
}
