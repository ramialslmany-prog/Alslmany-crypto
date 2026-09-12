import type { Evidence } from "./regime";
import type { DerivativesRead } from "@/lib/market/derivatives";

/**
 * Reading derivatives positioning.
 *
 * The logic here is contrarian at the extremes and confirmatory in the middle,
 * because that is how positioning actually behaves: a crowded trade is fuel for
 * the move against it, while balanced positioning simply tells you nothing.
 *
 * The single most valuable output is the squeeze warning. Retail's most common
 * catastrophic loss is entering long into extreme positive funding — everyone
 * is already leveraged long, there is no marginal buyer left, and the only
 * liquidity remaining is the stop cluster underneath. The move that follows is
 * not a normal pullback; it is a cascade, and a stop placed inside it fills far
 * worse than where it was set.
 */

export type SqueezeRisk = "none" | "elevated" | "high" | "extreme";

export type DerivativesAnalysis = {
  available: boolean;
  /** Signed contribution to the directional score. */
  score: number;
  evidence: Evidence[];
  /** Risk that a leveraged cascade runs against a long entry here. */
  squeezeRisk: SqueezeRisk;
  /** Stable warning keys for the UI. */
  warnings: string[];
  /**
   * Multiplier applied to position size, 0-1. Crowded leverage shrinks the
   * position automatically rather than relying on the reader to be cautious.
   */
  sizeMultiplier: number;
};

/**
 * Funding thresholds, expressed per 8-hour interval.
 * Historic norm sits near 0.01% (roughly 11% annualised). Sustained readings
 * several times that mean leveraged longs are paying heavily to stay in, which
 * is not a state that persists.
 */
const FUNDING = {
  neutralAbs: 0.01,
  elevated: 0.05,
  high: 0.1,
  extreme: 0.2,
} as const;

export function analyzeDerivatives(read: DerivativesRead | null): DerivativesAnalysis {
  const evidence: Evidence[] = [];
  const warnings: string[] = [];
  let score = 0;
  let squeezeRisk: SqueezeRisk = "none";
  let sizeMultiplier = 1;

  if (!read || (!read.funding && !read.openInterest && !read.positioning)) {
    // No perpetual market. Say nothing rather than inventing balance.
    return {
      available: false,
      score: 0,
      evidence: [],
      squeezeRisk: "none",
      warnings: [],
      sizeMultiplier: 1,
    };
  }

  const add = (key: string, weight: number, detail: string) => {
    evidence.push({
      key,
      direction: weight > 0 ? "bullish" : weight < 0 ? "bearish" : "neutral",
      weight,
      detail,
    });
    score += weight;
  };

  // ── Funding ──
  const funding = read.funding;
  if (funding) {
    const rate = funding.ratePct;
    const avg = funding.averagePct;
    const abs = Math.abs(rate);
    const sustained = Math.abs(avg) >= FUNDING.elevated;

    if (rate >= FUNDING.extreme) {
      add("deriv.fundingExtremeLong", -18, `funding ${rate.toFixed(3)}% (${funding.annualizedPct.toFixed(0)}% annualised)`);
      squeezeRisk = "extreme";
      warnings.push("warn.crowdedLongs");
    } else if (rate >= FUNDING.high) {
      add("deriv.fundingHighLong", -12, `funding ${rate.toFixed(3)}%`);
      squeezeRisk = sustained ? "high" : "elevated";
      warnings.push("warn.crowdedLongs");
    } else if (rate >= FUNDING.elevated) {
      add("deriv.fundingElevatedLong", -6, `funding ${rate.toFixed(3)}%`);
      squeezeRisk = "elevated";
    } else if (rate <= -FUNDING.high) {
      // Shorts paying heavily is the mirror image, and is fuel for an upside
      // squeeze rather than a reason to avoid buying.
      add("deriv.fundingNegative", 11, `funding ${rate.toFixed(3)}% — shorts paying`);
    } else if (rate <= -FUNDING.elevated) {
      add("deriv.fundingMildNegative", 6, `funding ${rate.toFixed(3)}%`);
    } else if (abs <= FUNDING.neutralAbs) {
      add("deriv.fundingNeutral", 0, `funding ${rate.toFixed(3)}% — balanced`);
    }
  }

  // ── Open interest, read together with funding ──
  const oi = read.openInterest;
  if (oi) {
    const change = oi.changePct;
    if (change >= 12) {
      // Rising OI into already-hot funding is leverage stacking on leverage.
      const crowded = (funding?.ratePct ?? 0) >= FUNDING.elevated;
      add(
        crowded ? "deriv.oiRisingCrowded" : "deriv.oiRising",
        crowded ? -9 : 4,
        `open interest +${change.toFixed(1)}% over 24h`,
      );
      if (crowded && squeezeRisk === "elevated") squeezeRisk = "high";
    } else if (change <= -12) {
      // Falling OI means leverage is being flushed — often healthier.
      add("deriv.oiFalling", 5, `open interest ${change.toFixed(1)}% over 24h`);
    }
  }

  // ── Account positioning ──
  const pos = read.positioning;
  if (pos && Number.isFinite(pos.ratio)) {
    if (pos.ratio >= 3) {
      add("deriv.accountsCrowdedLong", -10, `${pos.longAccountPct.toFixed(0)}% of accounts long`);
      if (squeezeRisk === "none") squeezeRisk = "elevated";
      warnings.push("warn.crowdedLongs");
    } else if (pos.ratio <= 0.6) {
      add("deriv.accountsCrowdedShort", 8, `${pos.shortAccountPct.toFixed(0)}% of accounts short`);
    }
  }

  // Crowding shrinks the position mechanically. A reader who has just been told
  // the trade is crowded will still take full size; the code should not let
  // them do it by default.
  if (squeezeRisk === "extreme") sizeMultiplier = 0.35;
  else if (squeezeRisk === "high") sizeMultiplier = 0.55;
  else if (squeezeRisk === "elevated") sizeMultiplier = 0.8;

  return {
    available: true,
    score: Math.max(-40, Math.min(40, Math.round(score))),
    evidence,
    squeezeRisk,
    warnings: [...new Set(warnings)],
    sizeMultiplier,
  };
}
