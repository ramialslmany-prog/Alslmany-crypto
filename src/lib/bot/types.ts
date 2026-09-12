import type { Sector } from "@/lib/market/universe";
import type { Factor, Grade, Horizon } from "@/lib/engine/recommendation";
import type { Target } from "@/lib/engine/risk";
import type { ThesisSnapshot } from "./thesis";

/**
 * The trading bot's domain.
 *
 * Everything is denominated in R — one R is the distance from entry to the
 * initial stop. Reasoning in R rather than in currency is what makes a run of
 * losses survivable and what makes results comparable across assets whose
 * prices differ by five orders of magnitude.
 */

export type ExitReason =
  | "target"
  | "stop"
  | "breakeven"
  | "trailing"
  | "time"
  | "regime"
  | "manual"
  /** The reason for entering disappeared before the stop was reached. */
  | "thesis"
  /** The edge eroded; part of the position was released early. */
  | "weakened";

export type FillReason = ExitReason | "entry";

export type Fill = {
  at: number;
  price: number;
  /** Share of the ORIGINAL position transacted here, 0–1. */
  fraction: number;
  reason: FillReason;
  /** Reward in R realised by this fill. Zero for the entry. */
  rMultiple: number;
};

/** The evidence that opened a position, frozen at entry. */
export type Thesis = {
  verdict: string;
  grade: Grade;
  score: number;
  confidence: number;
  horizon: Horizon;
  bullish: Factor[];
  bearish: Factor[];
  warnings: string[];
  marketRegime: string;
  /** Reward-to-risk the plan promised when it was taken. */
  plannedRewardRisk: number;
  /** The state of the world at entry, for invalidation checks. */
  snapshot?: ThesisSnapshot;
};

export type Position = {
  id: string;
  symbol: string;
  sector: Sector;
  tier: 1 | 2 | 3;
  openedAt: number;
  entry: number;
  /** Never mutated — every R calculation is anchored to this. */
  initialStop: number;
  /** Current stop, which may have moved to breakeven or be trailing. */
  stop: number;
  targets: Target[];
  /** Share of the original position still held, 0–1. */
  remaining: number;
  targetsHit: number;
  /** Percentage of the account allocated at entry. */
  sizePct: number;
  /** Percentage of the account risked at entry. */
  riskPct: number;
  thesis: Thesis;
  fills: Fill[];
  /** Best price seen since entry, for the trailing stop. */
  highWater: number;
  /**
   * True once the final tranche has been released from its target cap and is
   * being trailed instead — how a large rise is actually captured.
   */
  running?: boolean;
  /** Thesis checks that fired, kept for the journal. */
  thesisEvents?: { at: number; severity: string; reasons: string[] }[];
  lastPrice: number;
  lastCheckedAt: number;
  status: "open" | "closed";
  closedAt?: number;
  exitReason?: ExitReason;
  /** Realised reward in R, weighted across every partial exit. */
  realizedR: number;
  /** Realised return on the position, in percent. */
  realizedPct: number;
};

export type PositionEvent = {
  kind: "opened" | "partial" | "closed" | "stop-moved";
  at: number;
  positionId: string;
  symbol: string;
  price: number;
  detail: string;
  reason?: FillReason;
  rMultiple?: number;
};

/** Tunables. Defaults encode the risk rules, they do not merely suggest them. */
export type BotConfig = {
  /** Base share of the account risked per idea, before regime haircuts. */
  riskPerTradePct: number;
  /** Hard ceiling on concurrent open positions. */
  maxPositions: number;
  /** No more than this many open positions in one sector. */
  maxPerSector: number;
  /** Only these grades may be opened. */
  allowedGrades: Grade[];
  /** Minimum blended reward-to-risk to accept. */
  minRewardRisk: number;
  /** Minimum engine confidence to accept. */
  minConfidence: number;
  /** Move the stop to entry once this many targets are filled. */
  breakevenAfterTargets: number;
  /** Begin trailing once this many targets are filled. */
  trailAfterTargets: number;
  /** Trailing distance, in ATR multiples. */
  trailAtrMultiple: number;
  /** Abandon a position that has gone nowhere after this many hours. */
  maxHoldHours: number;
  /** A stale position is only cut if it is below this R. */
  staleBelowR: number;

  // ── Layer 9: the professional gates ──
  /** Refuse entries where leveraged longs are this crowded or worse. */
  maxSqueezeRisk: "none" | "elevated" | "high" | "extreme";
  /** Refuse entries whose book cannot support an honest stop. */
  minLiquidityScore: number;
  /** Refuse entries where the realistic loss overshoots the intended risk. */
  rejectUnderstatedRisk: boolean;
  /** Exit early when the reason for entering disappears. */
  thesisExitEnabled: boolean;
  /** Release the final tranche from its cap in a confirmed trend. */
  runnerEnabled: boolean;
};

export const DEFAULT_BOT_CONFIG: BotConfig = {
  riskPerTradePct: 1,
  maxPositions: 5,
  maxPerSector: 2,
  allowedGrades: ["A", "B"],
  minRewardRisk: 1.8,
  minConfidence: 55,
  breakevenAfterTargets: 1,
  trailAfterTargets: 2,
  trailAtrMultiple: 2,
  maxHoldHours: 24 * 10,
  staleBelowR: 0.35,
  // Elevated crowding is tolerable; high is not. Entering a high-funding tape
  // is the most reliable way retail gets caught in a cascade.
  maxSqueezeRisk: "elevated",
  // Below 40 the book cannot be trusted to fill a stop near its price, which
  // makes the whole risk model a fiction.
  minLiquidityScore: 40,
  rejectUnderstatedRisk: true,
  thesisExitEnabled: true,
  runnerEnabled: true,
};

export type { ThesisSnapshot };

export type LedgerStats = {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  /** Mean R across closed trades — the number that actually decides an edge. */
  expectancyR: number;
  totalR: number;
  averageWinR: number;
  averageLossR: number;
  /** Gross wins ÷ gross losses. */
  profitFactor: number | null;
  maxDrawdownR: number;
  longestWinStreak: number;
  longestLossStreak: number;
  averageHoldHours: number;
  bestR: number;
  worstR: number;
  byReason: Record<ExitReason, number>;
};

export type BotState = {
  positions: Position[];
  closed: Position[];
  events: PositionEvent[];
  /** Equity curve in cumulative R, one point per closed trade. */
  equityR: { at: number; cumulative: number }[];
  startedAt: number;
  lastTickAt: number;
};

export function emptyState(now = Date.now()): BotState {
  return {
    positions: [],
    closed: [],
    events: [],
    equityR: [],
    startedAt: now,
    lastTickAt: now,
  };
}
