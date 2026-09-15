/**
 * A recommendation.
 *
 * Immutable once created. Nothing in the system may edit or delete one — any
 * change is a separate EVENT that references it. That is not a storage detail:
 * a bot that can quietly revise a losing call has no track record, and a track
 * record is the only thing that makes the rest of this worth anything.
 */
import type { SetupKind, MarketRegime, StageId } from "@/core/pipeline/types";
import type { Timeframe } from "@/shared/time";
import type { Direction } from "@/core/types";

export interface PriceZone {
  readonly low: number;
  readonly high: number;
  /** The single best price inside the zone, for display and sizing. */
  readonly mid: number;
}

export interface Target {
  readonly index: 1 | 2 | 3;
  readonly price: number;
  /** Fraction of the position to close here, 0..1. The three sum to 1. */
  readonly closeFraction: number;
  /** Reward in R (multiples of the initial risk) at this target. */
  readonly rMultiple: number;
  /** Which discovered level this target sits on. */
  readonly basis: string;
}

/**
 * Invalidation conditions, expressed so a machine can check them every bar.
 *
 * Free text would be unauditable and unenforceable. Each condition names a
 * subject, an operator and a value, and the monitor evaluates them literally.
 */
export type InvalidationSubject =
  | "price"
  | "close"
  | "structure_state"
  | "stage_score"
  | "funding_rate"
  | "elapsed_bars"
  | "btc_daily_score";

export interface InvalidationCondition {
  readonly id: string;
  readonly subject: InvalidationSubject;
  readonly operator: "lt" | "lte" | "gt" | "gte" | "eq" | "neq";
  readonly value: number | string;
  /** Which stage's score, when subject is stage_score. */
  readonly stage?: StageId;
  readonly arabic: string;
}

/** What each stage contributed to the final confidence, for the audit page. */
export interface ConfidenceComponent {
  readonly stage: StageId;
  readonly name: string;
  readonly score: number;
  readonly weight: number;
  readonly contribution: number;
  readonly status: "pass" | "unavailable";
  readonly note: string;
}

export interface Recommendation {
  /** Deterministic id: symbol + timeframe + generation time. */
  readonly id: string;
  readonly symbol: string;
  readonly direction: Direction;
  readonly setup: SetupKind;
  readonly regime: MarketRegime;
  readonly timeframe: Timeframe;
  readonly generatedAt: number;
  /** openTime of the closed candle every number was computed on. */
  readonly asOfCandle: number;
  readonly exchange: string;

  /** A RANGE read off real levels, never a single price. */
  readonly entry: PriceZone;
  /** Behind the nearest genuine invalidation level, plus a volatility buffer. */
  readonly stop: number;
  readonly stopBasis: string;
  readonly targets: readonly [Target, Target, Target];

  readonly riskReward: number;
  /** Units of the base asset. */
  readonly positionSize: number;
  readonly positionNotional: number;
  readonly riskAmount: number;
  readonly riskPercent: number;

  readonly confidence: number;
  readonly confidenceComponents: readonly ConfidenceComponent[];
  readonly finalScore: number;

  readonly invalidation: readonly InvalidationCondition[];
  /** How long the entry zone stays valid before the idea expires. */
  readonly expiresAt: number;

  /** The eight stages woven into one connected Arabic narrative. */
  readonly report: string;
  /** Hash of the fields above — makes tampering detectable. */
  readonly integrityHash: string;
}

/** Anything that happens to a recommendation after it exists. */
export type RecommendationEventKind =
  | "created"
  | "entry_filled"
  | "target_hit"
  | "stop_hit"
  | "invalidated"
  | "expired"
  | "stop_moved"
  | "partial_exit"
  | "closed"
  | "note";

export interface RecommendationEvent {
  readonly id: string;
  readonly recommendationId: string;
  readonly kind: RecommendationEventKind;
  readonly at: number;
  /** openTime of the candle that triggered it — for reproducibility. */
  readonly candleTime: number | null;
  readonly price: number | null;
  readonly payload: Record<string, unknown>;
  readonly arabic: string;
}
