import type { Recommendation } from "@/lib/engine/recommendation";
import type { RegimeLabel } from "@/lib/analysis/regime";
import type { TrendLabel } from "@/lib/analysis/structure";
import type { SqueezeRisk } from "@/lib/analysis/derivatives";

/**
 * Thesis invalidation.
 *
 * A stop-loss is the *last* line of defence, not the first. It answers "was I
 * wrong about the price?" — but by the time it fills, the full 1R is gone.
 *
 * The reason for entering is a narrower thing than the stop: a trend, a
 * structure, a regime. When that reason disappears the trade is already over,
 * whether or not price has reached the stop yet. A professional closes then,
 * and takes a fraction of 1R instead of all of it.
 *
 * This is the single largest improvement available to the bot. Cutting the
 * average loss from −1.00R to −0.6R turns a break-even strategy into a
 * profitable one without winning a single extra trade.
 */

/** The state of the world when the position was opened. */
export type ThesisSnapshot = {
  structureTrend: TrendLabel;
  regimeLabel: RegimeLabel;
  squeezeRisk: SqueezeRisk;
  /** Composite directional score at entry. */
  score: number;
  /** Divergence score at entry, so a *new* divergence is distinguishable. */
  divergenceScore: number;
  /** Whether the higher timeframe was supportive. */
  marketLabel: RegimeLabel;
};

export function captureThesis(rec: Recommendation, marketLabel: RegimeLabel): ThesisSnapshot {
  return {
    structureTrend: rec.structure.trend,
    regimeLabel: rec.regime.label,
    squeezeRisk: rec.derivatives.squeezeRisk,
    score: rec.score,
    divergenceScore: rec.divergence.score,
    marketLabel,
  };
}

export type ThesisSeverity = "intact" | "weakening" | "broken";

export type ThesisCheck = {
  severity: ThesisSeverity;
  /** Stable keys naming what changed since entry. */
  reasons: string[];
  /**
   * Share of the remaining position to release now, 0–1.
   * Weakening scales out; broken closes.
   */
  releaseFraction: number;
};

/**
 * Compare the world now against the world at entry.
 *
 * Deliberately asymmetric: it takes several soft deteriorations to trigger a
 * partial exit, but one hard structural break closes the position. Being slow
 * to panic and quick to respect structure is the behaviour that survives.
 */
export function checkThesis(
  snapshot: ThesisSnapshot,
  current: Recommendation,
  marketLabel: RegimeLabel,
): ThesisCheck {
  const reasons: string[] = [];
  let hard = 0;
  let soft = 0;

  // ── Hard breaks: the structural reason for the trade is gone ──

  // The trend that justified a long has turned over.
  if (snapshot.structureTrend === "up" && current.structure.trend === "down") {
    reasons.push("thesis.structureReversed");
    hard++;
  }

  // A bearish change of character is the earliest structural evidence that
  // control has flipped, and it is exactly what we entered against.
  const lastBreak = current.structure.lastBreak;
  if (
    lastBreak &&
    lastBreak.kind === "CHoCH" &&
    lastBreak.direction === "bearish" &&
    current.timeframes.length > 0
  ) {
    reasons.push("thesis.chochBearish");
    hard++;
  }

  // The engine itself now says avoid or reduce on the same asset.
  if (current.verdict === "avoid" || current.verdict === "reduce") {
    reasons.push("thesis.verdictFlipped");
    hard++;
  }

  // ── Soft deterioration: the edge is eroding but structure holds ──

  // A reversal divergence that was not there when we entered.
  if (current.divergence.confirmed && current.divergence.score < snapshot.divergenceScore - 8) {
    reasons.push("thesis.divergenceAppeared");
    soft++;
  }

  // Leverage has crowded in against us since entry.
  const squeezeRank: Record<SqueezeRisk, number> = { none: 0, elevated: 1, high: 2, extreme: 3 };
  if (squeezeRank[current.derivatives.squeezeRisk] > squeezeRank[snapshot.squeezeRisk] + 1) {
    reasons.push("thesis.squeezeBuilt");
    soft++;
  }

  // The wider market turned hostile after we were already in.
  if (snapshot.marketLabel !== "bear" && marketLabel === "bear") {
    reasons.push("thesis.marketTurned");
    soft++;
  }

  // Conviction has drained materially.
  if (current.score < snapshot.score - 22) {
    reasons.push("thesis.convictionLost");
    soft++;
  }

  // Volatility has become extreme since entry: the stop is no longer reliable.
  if (current.regime.volatility.label === "extreme" && snapshot.regimeLabel !== "volatile") {
    reasons.push("thesis.volatilitySpiked");
    soft++;
  }

  if (hard > 0) {
    return { severity: "broken", reasons, releaseFraction: 1 };
  }
  // One soft signal is noise; two agreeing is a message.
  if (soft >= 2) {
    return { severity: "weakening", reasons, releaseFraction: 0.5 };
  }

  return { severity: "intact", reasons, releaseFraction: 0 };
}

/**
 * Trend strength, used to decide how much room a winner is given.
 *
 * A position in a strong, confirmed uptrend should be trailed loosely so it can
 * actually capture the move. The same position in chop should be trailed
 * tightly, because there is no move to capture and the only question is how
 * much of the open profit survives.
 */
export function trailMultiple(rec: Recommendation, base: number): number {
  const adx = rec.timeframes.find((t) => t.timeframe === "4h")?.adx ?? null;
  const trending = rec.structure.trend === "up" && (adx ?? 0) >= 28;
  const choppy = rec.regime.label === "range" || (adx !== null && adx < 18);
  const volatile = rec.regime.volatility.label === "extreme";

  // Volatility widens the trail in absolute terms already, through ATR. What
  // changes here is how many ATRs of room the trend has earned.
  if (trending && !volatile) return base * 1.6;
  if (choppy) return base * 0.65;
  return base;
}

/**
 * Whether the final tranche should run uncapped.
 *
 * Closing every winner at a fixed third target guarantees the bot never
 * captures a large rise — and large rises are where a trend strategy's entire
 * profit comes from. In a confirmed trend the runner is released from its cap
 * and trailed until structure actually breaks.
 */
export function shouldRun(rec: Recommendation): boolean {
  const daily = rec.timeframes.find((t) => t.timeframe === "1d");
  const fourHour = rec.timeframes.find((t) => t.timeframe === "4h");
  return (
    rec.structure.trend === "up" &&
    (fourHour?.adx ?? 0) >= 25 &&
    (daily?.score ?? 0) > 10 &&
    rec.regime.volatility.label !== "extreme" &&
    rec.derivatives.squeezeRisk !== "extreme"
  );
}
