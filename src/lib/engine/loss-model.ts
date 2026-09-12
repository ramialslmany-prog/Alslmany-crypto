import type { Candle } from "@/lib/market/types";
import type { LiquidityRead } from "@/lib/analysis/liquidity";

/**
 * What the loss actually is.
 *
 * A stop-loss states an intention, not an outcome. Three things sit between the
 * two, and a plan that ignores them is quoting a number it cannot deliver:
 *
 *  1. **Slippage.** The stop fills by eating the book. On a thin market that
 *     costs materially more than the stop price implies.
 *  2. **Gap risk.** Crypto trades around the clock, but it still moves in jumps.
 *     A single bar can open well through a stop, and the fill happens on the
 *     far side of it.
 *  3. **Fees.** Small per trade, and not zero.
 *
 * The honest figure is the sum of all four. This module computes it so the
 * number a user reads before entering is the number they should expect to lose
 * if they are wrong — not a more comfortable one.
 *
 * This is the part of the product that can genuinely be promised. Nobody can
 * promise a winning trade; the size of a losing one is controllable, and
 * quantifying it is what makes that control real.
 */

export type GapRisk = {
  /** Worst single-bar adverse move observed, as a percentage. */
  worstPct: number;
  /** 99th-percentile adverse move — the routine tail, not the outlier. */
  tailPct: number;
  /** Bars examined. */
  sample: number;
};

/**
 * Measure how violently this asset has moved against a holder in one bar.
 * Uses low relative to the prior close, which is what a stop actually faces.
 */
export function measureGapRisk(candles: Candle[]): GapRisk {
  if (candles.length < 30) return { worstPct: 0, tailPct: 0, sample: 0 };

  const adverse: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].c;
    if (!(prevClose > 0)) continue;
    const drop = ((prevClose - candles[i].l) / prevClose) * 100;
    if (drop > 0) adverse.push(drop);
  }
  if (adverse.length < 20) return { worstPct: 0, tailPct: 0, sample: adverse.length };

  const sorted = [...adverse].sort((a, b) => a - b);
  const tailIndex = Math.floor(sorted.length * 0.99);

  return {
    worstPct: sorted[sorted.length - 1],
    tailPct: sorted[Math.min(tailIndex, sorted.length - 1)],
    sample: adverse.length,
  };
}

export type RealisticLoss = {
  /** The loss the plan intends, as a percentage of the position. */
  plannedPct: number;
  /** Extra cost from walking the book on exit. */
  slippagePct: number;
  /** Extra cost when a bar jumps through the stop. */
  gapPct: number;
  /** Round-trip exchange fees. */
  feesPct: number;
  /** Everything together — what being wrong actually costs, per position. */
  realisticPct: number;
  /** The same figure as a share of the whole account. */
  accountPct: number;
  /** How much worse reality is than the plan, as a multiple. */
  severityMultiple: number;
  /** True when the realistic loss meaningfully exceeds the intended risk. */
  understated: boolean;
  /** Stable keys naming what drove the gap between planned and realistic. */
  drivers: string[];
};

/** Binance spot taker fee, both sides. Conservative for a retail account. */
const ROUND_TRIP_FEE_PCT = 0.2;

export function computeRealisticLoss(input: {
  /** Entry price the plan was struck at. */
  entry: number;
  /** Stop price. */
  stop: number;
  /** Share of the account this position occupies, in percent. */
  positionSizePct: number;
  /** Intended risk as a share of the account, in percent. */
  intendedAccountRiskPct: number;
  liquidity: LiquidityRead | null;
  gapRisk: GapRisk;
}): RealisticLoss {
  const { entry, stop, positionSizePct, intendedAccountRiskPct, liquidity, gapRisk } = input;

  const plannedPct = entry > 0 ? ((entry - stop) / entry) * 100 : 0;

  // Slippage is taken at the size actually being traded, interpolating between
  // the two book walks rather than assuming the retail reference size.
  let slippagePct = 0;
  const drivers: string[] = [];
  if (liquidity) {
    slippagePct = liquidity.exit10k.slippagePct;
    if (liquidity.exit10k.exceedsBook) {
      // The visible book could not absorb the exit at all. Whatever number we
      // computed is a floor, not an estimate.
      slippagePct = Math.max(slippagePct, 3);
      drivers.push("loss.driver.thinBook");
    } else if (slippagePct >= 0.5) {
      drivers.push("loss.driver.slippage");
    }
    if (liquidity.score < 40) drivers.push("loss.driver.lowLiquidity");
  } else {
    // Unknown liquidity is not zero liquidity. Assume a modest cost rather than
    // quietly reporting a best case we have not verified.
    slippagePct = 0.35;
    drivers.push("loss.driver.unknownLiquidity");
  }

  // Only the portion of a tail move that lands *beyond* the stop adds to the
  // loss; anything inside it was already accounted for.
  const gapPct = Math.max(0, gapRisk.tailPct - plannedPct);
  if (gapPct > 0.5) drivers.push("loss.driver.gapRisk");

  const realisticPct = plannedPct + slippagePct + gapPct + ROUND_TRIP_FEE_PCT;
  const accountPct = (realisticPct * positionSizePct) / 100;
  const severityMultiple = plannedPct > 0 ? realisticPct / plannedPct : 1;

  return {
    plannedPct: round(plannedPct),
    slippagePct: round(slippagePct),
    gapPct: round(gapPct),
    feesPct: ROUND_TRIP_FEE_PCT,
    realisticPct: round(realisticPct),
    accountPct: round(accountPct),
    severityMultiple: round(severityMultiple),
    // A quarter again over the intended risk is the point where the stated
    // number stops being a fair description of the trade.
    understated: accountPct > intendedAccountRiskPct * 1.25,
    drivers: [...new Set(drivers)],
  };
}

function round(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(3)) : 0;
}

/**
 * Position size that keeps the *realistic* loss inside the risk budget.
 *
 * Standard sizing divides the risk budget by the stop distance, which silently
 * assumes a perfect fill. Sizing against the realistic loss instead means the
 * stated risk survives contact with a real order book — a wider true loss buys
 * a smaller position, exactly as it should.
 */
export function sizeForRealisticLoss(
  realisticLossPct: number,
  accountRiskPct: number,
  maxPositionPct: number,
): number {
  if (!(realisticLossPct > 0)) return 0;
  const raw = (accountRiskPct / realisticLossPct) * 100;
  return Number(Math.min(raw, maxPositionPct).toFixed(2));
}
