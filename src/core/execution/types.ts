/**
 * Execution domain.
 *
 * Paper trading only. The live layer exists (see live-broker.ts) and is hard
 * off, but everything below is the same code path either way — because a
 * paper engine that diverges from the live one is measuring a strategy nobody
 * will ever run.
 */
import type { Direction } from "@/core/types";
import type { Timeframe } from "@/shared/time";

export type OrderSide = "buy" | "sell";

/**
 * Why a position ended. Recorded on every close, because "what killed this
 * trade" is the only question the performance page really answers.
 */
export type ExitReason =
  | "target_1"
  | "target_2"
  | "target_3"
  | "stop_loss"
  | "breakeven_stop"
  | "trailing_stop"
  | "invalidated"
  | "time_exit"
  | "circuit_breaker"
  | "manual";

export const EXIT_REASON_AR: Record<ExitReason, string> = {
  target_1: "الهدف الأول",
  target_2: "الهدف الثاني",
  target_3: "الهدف الثالث",
  stop_loss: "ضرب الوقف",
  breakeven_stop: "وقف التعادل",
  trailing_stop: "الوقف المتتبّع",
  invalidated: "تحقّق شرط إبطال",
  time_exit: "خروج زمني",
  circuit_breaker: "قاطع حماية",
  manual: "إغلاق يدوي",
};

/** One executed transaction, with everything that ate into the result. */
export interface Fill {
  readonly at: number;
  /** openTime of the candle it executed on. */
  readonly candleTime: number;
  readonly side: OrderSide;
  readonly quantity: number;
  /** The price we would have got with no friction. */
  readonly referencePrice: number;
  /** What we actually got after walking the book. */
  readonly price: number;
  readonly slippage: number;
  readonly slippageBps: number;
  readonly fee: number;
  readonly feeBps: number;
  readonly notional: number;
  readonly reason: string;
}

export type PositionStatus = "pending" | "open" | "closed" | "expired" | "invalidated";

export interface Position {
  readonly id: string;
  readonly recommendationId: string;
  readonly symbol: string;
  readonly direction: Direction;
  readonly timeframe: Timeframe;
  readonly status: PositionStatus;

  readonly plannedEntry: { low: number; high: number; mid: number };
  readonly plannedStop: number;
  readonly plannedTargets: readonly { index: 1 | 2 | 3; price: number; closeFraction: number }[];
  readonly plannedSize: number;
  /** Risk in quote currency at the planned entry and stop. */
  readonly plannedRisk: number;

  /** The stop as it stands NOW — moves to breakeven, then trails. */
  readonly currentStop: number;
  readonly stopMovedToBreakeven: boolean;
  readonly trailingActive: boolean;

  readonly fills: readonly Fill[];
  /** Units still open. */
  readonly openQuantity: number;
  /** Average entry across partial fills. */
  readonly averageEntry: number;
  readonly targetsHit: readonly (1 | 2 | 3)[];

  readonly openedAt: number | null;
  readonly closedAt: number | null;
  readonly exitReason: ExitReason | null;

  /** Realized P&L in quote currency, net of fees and slippage. */
  readonly realizedPnl: number;
  /** Result in R — the only comparable unit across symbols and sizes. */
  readonly realizedR: number;
  /** Best unrealized profit the trade ever showed, in R. */
  readonly maxFavorableR: number;
  /** Worst unrealized loss the trade ever showed, in R. */
  readonly maxAdverseR: number;
  /** Bars held from entry to close. */
  readonly barsHeld: number;

  readonly expiresAt: number;
  readonly notes: readonly string[];
}

/** Everything the monitor may decide to do on a closed candle. */
export type PositionAction =
  | { kind: "fill_entry"; price: number; quantity: number; reason: string }
  | { kind: "hit_target"; target: 1 | 2 | 3; price: number; quantity: number }
  | { kind: "hit_stop"; price: number; quantity: number; reason: ExitReason }
  | { kind: "move_stop"; to: number; reason: string }
  | { kind: "invalidate"; reason: string }
  | { kind: "expire"; reason: string }
  | { kind: "alert"; reason: string };

export interface PortfolioSnapshot {
  readonly at: number;
  readonly equity: number;
  readonly cash: number;
  readonly openPositions: number;
  readonly exposureNotional: number;
  /** Peak equity ever reached — the drawdown reference. */
  readonly peakEquity: number;
  readonly drawdownPct: number;
  readonly dayStartEquity: number;
  readonly dayPnlPct: number;
}

export type CircuitBreakerKind = "daily_loss" | "max_drawdown" | "manual";

export interface CircuitBreaker {
  readonly kind: CircuitBreakerKind;
  readonly trippedAt: number;
  /** null for the drawdown breaker — it needs a human to clear it. */
  readonly resumesAt: number | null;
  readonly requiresManualReset: boolean;
  readonly reason: string;
  readonly arabic: string;
}
