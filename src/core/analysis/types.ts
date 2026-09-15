/**
 * Analysis output shapes.
 *
 * Every stage of the pipeline produces the same four things, because the site
 * has to render all eight of them identically and the user has to be able to
 * audit any one: a NUMBER, the FACTORS that produced it, an ARABIC narrative
 * explaining what was seen, and a DECISION.
 *
 * Score conventions, fixed across the system:
 *   directional layers  −100 (strongly bearish) … 0 (neutral) … +100 (strongly bullish)
 *   quality layers      0 … 100  (unsigned; volatility uses this)
 *   confidence          0 … 100
 */
import type { Timeframe } from "@/shared/time";
import type { Availability } from "@/shared/availability";

export type Bias = "bullish" | "bearish" | "neutral";

/** Arabic labels, so no caller has to invent its own wording. */
export const BIAS_AR: Record<Bias, string> = {
  bullish: "صاعد",
  bearish: "هابط",
  neutral: "محايد",
};

/**
 * One auditable input to a layer score.
 *
 * `contribution` is the signed amount this factor moved its layer's score,
 * already weighted. Summing the contributions of a layer reproduces its score
 * exactly — that is what makes the "how did the bot decide" page honest rather
 * than decorative.
 */
export interface Factor {
  readonly id: string;
  readonly label: string;
  /** Raw reading, or null when the input was unavailable. */
  readonly value: number | null;
  /** Formatted for display, including units. */
  readonly display: string;
  /** Signed, already weighted. */
  readonly contribution: number;
  readonly note: string;
}

export type LayerId = "trend" | "momentum" | "volatility" | "volume";

export interface LayerAnalysis {
  readonly id: LayerId;
  readonly label: string;
  /** Directional layers −100..100; volatility 0..100. */
  readonly score: number;
  readonly bias: Bias;
  readonly factors: readonly Factor[];
  readonly arabic: string;
  /** Inputs this layer could not read, named so the site can show them. */
  readonly unavailable: readonly string[];
}

export interface TimeframeAnalysis {
  readonly timeframe: Timeframe;
  /** Bars of CLOSED history actually used. */
  readonly bars: number;
  /** openTime of the last closed candle every number here was computed on. */
  readonly asOf: number;
  readonly price: number;
  readonly layers: {
    readonly trend: LayerAnalysis;
    readonly momentum: LayerAnalysis;
    readonly volatility: LayerAnalysis;
    readonly volume: LayerAnalysis;
  };
  /** Composite directional score, −100..100. */
  readonly score: number;
  readonly bias: Bias;
  /** 0..100 conviction: how strongly the layers agree with each other. */
  readonly strength: number;
  readonly arabic: string;
  readonly warnings: readonly string[];
}

export type Verdict = "pass" | "fail";

/** One named disagreement between two timeframes. */
export interface Conflict {
  readonly lower: Timeframe;
  readonly higher: Timeframe;
  readonly lowerBias: Bias;
  readonly higherBias: Bias;
  /** Steps apart on the 5m→1w ladder. */
  readonly levels: number;
  /** True when this conflict alone is enough to reject the setup. */
  readonly fatal: boolean;
  readonly arabic: string;
}

export interface ConfluenceResult {
  /** 0..100 — how much the six timeframes agree. */
  readonly agreement: number;
  readonly dominantBias: Bias;
  /** The timeframe the trade would be executed on. */
  readonly tradingTimeframe: Timeframe;
  /** Two rungs above the trading timeframe — the flow rule's anchor. */
  readonly anchorTimeframe: Timeframe;
  readonly anchorBias: Bias;
  readonly perTimeframe: readonly { timeframe: Timeframe; bias: Bias; score: number; strength: number }[];
  readonly conflicts: readonly Conflict[];
  /** Direction the higher timeframes permit this cycle. */
  readonly allowedDirection: "long" | "short" | "both" | "none";
  readonly verdict: Verdict;
  readonly arabic: string;
}

/** A full technical read: the six timeframes plus how they line up. */
export interface TechnicalAnalysis {
  readonly symbol: string;
  readonly generatedAt: number;
  readonly timeframes: readonly TimeframeAnalysis[];
  readonly confluence: ConfluenceResult;
  /** Timeframes we could not analyse, and why. */
  readonly missing: readonly { timeframe: Timeframe; reason: string }[];
  readonly verdict: Verdict;
  readonly arabic: string;
}

export type TimeframeInput = Record<Timeframe, Availability<unknown>>;
