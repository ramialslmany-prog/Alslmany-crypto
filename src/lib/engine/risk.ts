import type { Candle } from "@/lib/market/types";
import { atr, last } from "@/lib/analysis/indicators";
import type { Level, StructureRead } from "@/lib/analysis/structure";

/**
 * Risk model.
 *
 * Non-negotiable rules, encoded rather than left to discipline:
 *  - the stop is decided before the entry, at the level that would prove the
 *    idea wrong — never at a round percentage and never at a comfortable one,
 *  - position size is derived from the stop distance, so a wider stop buys a
 *    smaller position and the loss taken is the same either way,
 *  - a plan that cannot offer roughly 2R is not worth taking.
 *
 * Everything here is expressed in R — one R is the distance from entry to
 * stop. Reasoning in R rather than in dollars is what keeps a run of losses
 * survivable.
 */

export const DEFAULT_RISK = {
  /** Share of the account risked on one idea, before any regime haircut. */
  riskPerTradePct: 1,
  /** Nothing is published below this reward-to-risk. */
  minRewardRisk: 1.8,
  /** A stop closer than this is inside the noise and will be taken out. */
  minStopAtrMultiple: 0.9,
  /** A stop wider than this makes the position too small to matter. */
  maxStopAtrMultiple: 3.2,
  /** Hard ceiling on any single position, whatever the maths says. */
  maxPositionPct: 25,
} as const;

export type RiskSettings = {
  riskPerTradePct: number;
  minRewardRisk: number;
  maxPositionPct: number;
};

export type Target = {
  price: number;
  /** Reward in R multiples at this level. */
  rMultiple: number;
  /** Share of the position to release here (sums to 100 across targets). */
  allocationPct: number;
  /** Which structural level justifies this target. */
  basis: string;
};

export type TradePlan = {
  entryLow: number;
  entryHigh: number;
  /** The price the plan's maths was struck against. */
  reference: number;
  stop: number;
  /** Distance from reference to stop, as a percentage of price. */
  stopDistancePct: number;
  targets: Target[];
  rewardRisk: number;
  /** Percentage of the account to allocate, given the stop distance. */
  positionSizePct: number;
  riskPerTradePct: number;
  /** Stable key describing what would prove the idea wrong. */
  invalidationKey: string;
  invalidationPrice: number;
};

/**
 * Place the stop beneath the structure that supports the idea, then widen it
 * past the noise floor. Two independent constraints:
 *  - structural: below the level price is expected to hold,
 *  - volatility: far enough that ordinary movement will not reach it.
 * We take the lower (safer) of the two, then refuse anything absurdly wide.
 */
export function deriveStop(
  price: number,
  candles: Candle[],
  structure: StructureRead,
): { stop: number; basis: string } {
  const atrValue = last(atr(candles, 14)) ?? price * 0.02;
  const noiseFloor = price - atrValue * DEFAULT_RISK.minStopAtrMultiple;
  const ceiling = price - atrValue * DEFAULT_RISK.maxStopAtrMultiple;

  const support = structure.nearestSupport;
  // Sit below the level, not on it — resting exactly at an obvious price is
  // resting where the stop hunt happens.
  const structural = support && support.price < price ? support.price - atrValue * 0.35 : null;

  let stop: number;
  let basis: string;

  if (structural !== null && structural <= noiseFloor && structural >= ceiling) {
    stop = structural;
    basis = "structure";
  } else if (structural !== null && structural > noiseFloor) {
    // Support is closer than the noise floor: honour the noise floor instead,
    // or the position dies to ordinary movement.
    stop = noiseFloor;
    basis = "volatility";
  } else {
    stop = Math.max(noiseFloor, ceiling);
    basis = structural !== null ? "volatility-capped" : "volatility";
  }

  return { stop: Math.max(stop, price * 0.5), basis };
}

/**
 * Targets sit at levels the market has actually respected. Where structure
 * runs out we extend in R multiples, but a target invented from a multiple is
 * labelled as such so the user can tell the difference.
 */
export function deriveTargets(
  reference: number,
  stop: number,
  structure: StructureRead,
): Target[] {
  const risk = reference - stop;
  if (risk <= 0) return [];

  const resistances = structure.levels
    .filter((l) => l.price > reference * 1.005)
    .sort((a, b) => a.price - b.price);

  const chosen: { price: number; basis: string }[] = [];

  for (const level of resistances) {
    const r = (level.price - reference) / risk;
    if (r < 0.8) continue;
    // Keep targets meaningfully apart; two targets 3% apart is one target.
    if (chosen.some((c) => Math.abs(c.price - level.price) / reference < 0.025)) continue;
    chosen.push({ price: level.price, basis: `level:${level.touches}` });
    if (chosen.length === 3) break;
  }

  // Fill any remaining slots with R-multiple extensions.
  const fallbackMultiples = [1.5, 2.5, 4];
  for (const m of fallbackMultiples) {
    if (chosen.length >= 3) break;
    const price = reference + risk * m;
    if (chosen.some((c) => Math.abs(c.price - price) / reference < 0.025)) continue;
    chosen.push({ price, basis: `extension:${m}R` });
  }

  chosen.sort((a, b) => a.price - b.price);

  // Take most of the position off early. Letting a winner run is a good idea
  // right up until the first target was the high of the move.
  const allocations = chosen.length === 1 ? [100] : chosen.length === 2 ? [50, 50] : [40, 35, 25];

  return chosen.slice(0, 3).map((c, i) => ({
    price: c.price,
    rMultiple: Number(((c.price - reference) / risk).toFixed(2)),
    allocationPct: allocations[i],
    basis: c.basis,
  }));
}

/** Reward-to-risk weighted by how much of the position each target releases. */
export function blendedRewardRisk(targets: Target[]): number {
  if (targets.length === 0) return 0;
  const total = targets.reduce((s, t) => s + t.allocationPct, 0) || 100;
  return Number(
    targets.reduce((s, t) => s + t.rMultiple * (t.allocationPct / total), 0).toFixed(2),
  );
}

/**
 * Position size from the stop distance.
 *
 * risk% of the account ÷ how far the stop is, in percent. A 2% stop with 1%
 * risk gives a 50% position; the cap then pulls that back to something sane,
 * because concentration is its own risk no matter what the arithmetic says.
 */
export function positionSize(
  reference: number,
  stop: number,
  riskPerTradePct: number,
  maxPositionPct: number = DEFAULT_RISK.maxPositionPct,
): number {
  const stopDistancePct = ((reference - stop) / reference) * 100;
  if (stopDistancePct <= 0) return 0;
  const raw = (riskPerTradePct / stopDistancePct) * 100;
  return Number(Math.min(raw, maxPositionPct).toFixed(2));
}

/**
 * Effective risk per trade after every haircut.
 * The regime budget, the asset's tier and our confidence all shrink it; none
 * of them may ever enlarge it beyond the configured base.
 */
export function effectiveRisk(
  baseRiskPct: number,
  regimeBudget: number,
  tier: 1 | 2 | 3,
  confidence: number,
): number {
  const tierFactor = tier === 1 ? 1 : tier === 2 ? 0.8 : 0.55;
  const confidenceFactor = 0.5 + Math.min(Math.max(confidence, 0), 100) / 200;
  const value = baseRiskPct * regimeBudget * tierFactor * confidenceFactor;
  return Number(Math.min(value, baseRiskPct).toFixed(3));
}

/** Assemble a full plan, or null when the idea cannot be risked sensibly. */
export function buildPlan(input: {
  price: number;
  candles: Candle[];
  structure: StructureRead;
  riskPerTradePct: number;
  minRewardRisk: number;
  maxPositionPct: number;
}): TradePlan | null {
  const { price, candles, structure } = input;
  const { stop, basis } = deriveStop(price, candles, structure);
  if (!(stop > 0) || stop >= price) return null;

  const atrValue = last(atr(candles, 14)) ?? price * 0.02;
  // Buy into weakness rather than chasing: the zone runs from a shallow dip
  // up to the current price.
  const entryLow = Math.max(price - atrValue * 0.5, stop * 1.003);
  const entryHigh = price;

  const targets = deriveTargets(price, stop, structure);
  if (targets.length === 0) return null;

  const rewardRisk = blendedRewardRisk(targets);
  const stopDistancePct = ((price - stop) / price) * 100;

  return {
    entryLow,
    entryHigh,
    reference: price,
    stop,
    stopDistancePct: Number(stopDistancePct.toFixed(2)),
    targets,
    rewardRisk,
    positionSizePct: positionSize(price, stop, input.riskPerTradePct, input.maxPositionPct),
    riskPerTradePct: input.riskPerTradePct,
    invalidationKey: basis === "structure" ? "invalidation.structure" : "invalidation.volatility",
    invalidationPrice: stop,
  };
}

/** Convenience for the UI: what a level is worth in R. */
export function toR(price: number, reference: number, stop: number): number {
  const risk = reference - stop;
  return risk > 0 ? Number(((price - reference) / risk).toFixed(2)) : 0;
}

export type { Level };
