/**
 * Position, equity-curve and circuit-breaker storage.
 *
 * Positions are mutable, unlike recommendations — a position is live state
 * that legitimately changes as the stop moves and targets fill. The audit
 * trail lives in `recommendation_events`, which is append-only, so the
 * history survives even though the row is updated in place.
 */
import type { Db } from "@/storage/db";
import type {
  CircuitBreaker, CircuitBreakerKind, ExitReason, Fill, PortfolioSnapshot, Position, PositionStatus,
} from "@/core/execution/types";
import type { Direction } from "@/core/types";
import type { Timeframe } from "@/shared/time";

interface Row {
  id: string; recommendation_id: string; symbol: string; direction: string;
  timeframe: string; status: string;
  planned_entry_low: number; planned_entry_high: number; planned_entry_mid: number;
  planned_stop: number; planned_targets_json: string; planned_size: number; planned_risk: number;
  current_stop: number; stop_at_breakeven: number; trailing_active: number;
  fills_json: string; open_quantity: number; average_entry: number; targets_hit_json: string;
  opened_at: number | null; closed_at: number | null; exit_reason: string | null;
  realized_pnl: number; realized_r: number; max_favorable_r: number; max_adverse_r: number;
  bars_held: number; expires_at: number; notes_json: string;
}

const toPosition = (r: Row): Position => ({
  id: r.id,
  recommendationId: r.recommendation_id,
  symbol: r.symbol,
  direction: r.direction as Direction,
  timeframe: r.timeframe as Timeframe,
  status: r.status as PositionStatus,
  plannedEntry: { low: r.planned_entry_low, high: r.planned_entry_high, mid: r.planned_entry_mid },
  plannedStop: r.planned_stop,
  plannedTargets: JSON.parse(r.planned_targets_json),
  plannedSize: r.planned_size,
  plannedRisk: r.planned_risk,
  currentStop: r.current_stop,
  stopMovedToBreakeven: r.stop_at_breakeven === 1,
  trailingActive: r.trailing_active === 1,
  fills: JSON.parse(r.fills_json) as Fill[],
  openQuantity: r.open_quantity,
  averageEntry: r.average_entry,
  targetsHit: JSON.parse(r.targets_hit_json),
  openedAt: r.opened_at,
  closedAt: r.closed_at,
  exitReason: r.exit_reason as ExitReason | null,
  realizedPnl: r.realized_pnl,
  realizedR: r.realized_r,
  maxFavorableR: r.max_favorable_r,
  maxAdverseR: r.max_adverse_r,
  barsHeld: r.bars_held,
  expiresAt: r.expires_at,
  notes: JSON.parse(r.notes_json),
});

export class PositionRepo {
  constructor(private readonly db: Db) {}

  save(p: Position): void {
    this.db
      .prepare(
        `INSERT INTO positions (
          id, recommendation_id, symbol, direction, timeframe, status,
          planned_entry_low, planned_entry_high, planned_entry_mid, planned_stop,
          planned_targets_json, planned_size, planned_risk,
          current_stop, stop_at_breakeven, trailing_active,
          fills_json, open_quantity, average_entry, targets_hit_json,
          opened_at, closed_at, exit_reason,
          realized_pnl, realized_r, max_favorable_r, max_adverse_r, bars_held,
          expires_at, notes_json, updated_at
        ) VALUES (
          @id, @recommendation_id, @symbol, @direction, @timeframe, @status,
          @planned_entry_low, @planned_entry_high, @planned_entry_mid, @planned_stop,
          @planned_targets_json, @planned_size, @planned_risk,
          @current_stop, @stop_at_breakeven, @trailing_active,
          @fills_json, @open_quantity, @average_entry, @targets_hit_json,
          @opened_at, @closed_at, @exit_reason,
          @realized_pnl, @realized_r, @max_favorable_r, @max_adverse_r, @bars_held,
          @expires_at, @notes_json, @updated_at
        )
        ON CONFLICT (id) DO UPDATE SET
          status = excluded.status,
          current_stop = excluded.current_stop,
          stop_at_breakeven = excluded.stop_at_breakeven,
          trailing_active = excluded.trailing_active,
          fills_json = excluded.fills_json,
          open_quantity = excluded.open_quantity,
          average_entry = excluded.average_entry,
          targets_hit_json = excluded.targets_hit_json,
          opened_at = excluded.opened_at,
          closed_at = excluded.closed_at,
          exit_reason = excluded.exit_reason,
          realized_pnl = excluded.realized_pnl,
          realized_r = excluded.realized_r,
          max_favorable_r = excluded.max_favorable_r,
          max_adverse_r = excluded.max_adverse_r,
          bars_held = excluded.bars_held,
          notes_json = excluded.notes_json,
          updated_at = excluded.updated_at`,
      )
      .run({
        id: p.id, recommendation_id: p.recommendationId, symbol: p.symbol,
        direction: p.direction, timeframe: p.timeframe, status: p.status,
        planned_entry_low: p.plannedEntry.low, planned_entry_high: p.plannedEntry.high,
        planned_entry_mid: p.plannedEntry.mid, planned_stop: p.plannedStop,
        planned_targets_json: JSON.stringify(p.plannedTargets),
        planned_size: p.plannedSize, planned_risk: p.plannedRisk,
        current_stop: p.currentStop,
        stop_at_breakeven: p.stopMovedToBreakeven ? 1 : 0,
        trailing_active: p.trailingActive ? 1 : 0,
        fills_json: JSON.stringify(p.fills), open_quantity: p.openQuantity,
        average_entry: p.averageEntry, targets_hit_json: JSON.stringify(p.targetsHit),
        opened_at: p.openedAt, closed_at: p.closedAt, exit_reason: p.exitReason,
        realized_pnl: p.realizedPnl, realized_r: p.realizedR,
        max_favorable_r: p.maxFavorableR, max_adverse_r: p.maxAdverseR,
        bars_held: p.barsHeld, expires_at: p.expiresAt,
        notes_json: JSON.stringify(p.notes), updated_at: Date.now(),
      });
  }

  get(id: string): Position | null {
    const r = this.db.prepare<[string], Row>("SELECT * FROM positions WHERE id = ?").get(id);
    return r ? toPosition(r) : null;
  }

  /** Pending and open positions — what the monitor must evaluate each bar. */
  live(): Position[] {
    return this.db
      .prepare<[], Row>("SELECT * FROM positions WHERE status IN ('pending','open') ORDER BY opened_at")
      .all()
      .map(toPosition);
  }

  open(): Position[] {
    return this.live().filter((p) => p.status === "open");
  }

  closed(limit = 200): Position[] {
    return this.db
      .prepare<[number], Row>(
        "SELECT * FROM positions WHERE status IN ('closed','expired','invalidated') ORDER BY closed_at DESC LIMIT ?",
      )
      .all(limit)
      .map(toPosition);
  }

  bySymbol(symbol: string, limit = 50): Position[] {
    return this.db
      .prepare<[string, number], Row>(
        "SELECT * FROM positions WHERE symbol = ? ORDER BY opened_at DESC LIMIT ?",
      )
      .all(symbol, limit)
      .map(toPosition);
  }
}

export class EquityRepo {
  constructor(private readonly db: Db) {}

  record(s: PortfolioSnapshot, btcPrice: number | null = null): void {
    this.db
      .prepare(
        `INSERT INTO equity_curve
         (at, equity, cash, open_positions, exposure, peak_equity, drawdown_pct,
          day_start_equity, day_pnl_pct, btc_price)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (at) DO UPDATE SET
           equity = excluded.equity, cash = excluded.cash,
           open_positions = excluded.open_positions, exposure = excluded.exposure,
           peak_equity = excluded.peak_equity, drawdown_pct = excluded.drawdown_pct,
           day_start_equity = excluded.day_start_equity, day_pnl_pct = excluded.day_pnl_pct,
           btc_price = COALESCE(excluded.btc_price, equity_curve.btc_price)`,
      )
      .run(
        s.at, s.equity, s.cash, s.openPositions, s.exposureNotional,
        s.peakEquity, s.drawdownPct, s.dayStartEquity, s.dayPnlPct, btcPrice,
      );
  }

  latest(): (PortfolioSnapshot & { btcPrice: number | null }) | null {
    const r = this.db
      .prepare<[], {
        at: number; equity: number; cash: number; open_positions: number; exposure: number;
        peak_equity: number; drawdown_pct: number; day_start_equity: number;
        day_pnl_pct: number; btc_price: number | null;
      }>("SELECT * FROM equity_curve ORDER BY at DESC LIMIT 1")
      .get();
    if (!r) return null;
    return {
      at: r.at, equity: r.equity, cash: r.cash, openPositions: r.open_positions,
      exposureNotional: r.exposure, peakEquity: r.peak_equity, drawdownPct: r.drawdown_pct,
      dayStartEquity: r.day_start_equity, dayPnlPct: r.day_pnl_pct, btcPrice: r.btc_price,
    };
  }

  /** The curve for the dashboard, with Bitcoin alongside for comparison. */
  curve(from: number, to = Date.now()): { at: number; equity: number; drawdownPct: number; btcPrice: number | null }[] {
    return this.db
      .prepare<[number, number], { at: number; equity: number; drawdown_pct: number; btc_price: number | null }>(
        "SELECT at, equity, drawdown_pct, btc_price FROM equity_curve WHERE at >= ? AND at <= ? ORDER BY at",
      )
      .all(from, to)
      .map((r) => ({ at: r.at, equity: r.equity, drawdownPct: r.drawdown_pct, btcPrice: r.btc_price }));
  }
}

export class BreakerRepo {
  constructor(private readonly db: Db) {}

  trip(b: CircuitBreaker): void {
    this.db
      .prepare(
        `INSERT INTO circuit_breakers (kind, tripped_at, resumes_at, requires_manual_reset, reason, arabic)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(b.kind, b.trippedAt, b.resumesAt, b.requiresManualReset ? 1 : 0, b.reason, b.arabic);
  }

  /** Breakers that have not been cleared. Time-based expiry is applied by the caller. */
  uncleared(): CircuitBreaker[] {
    return this.db
      .prepare<[], {
        kind: string; tripped_at: number; resumes_at: number | null;
        requires_manual_reset: number; reason: string; arabic: string;
      }>("SELECT * FROM circuit_breakers WHERE cleared_at IS NULL ORDER BY tripped_at DESC")
      .all()
      .map((r) => ({
        kind: r.kind as CircuitBreakerKind,
        trippedAt: r.tripped_at,
        resumesAt: r.resumes_at,
        requiresManualReset: r.requires_manual_reset === 1,
        reason: r.reason,
        arabic: r.arabic,
      }));
  }

  /** Clear a breaker. `by` records who — "auto" or an operator. */
  clear(kind: CircuitBreakerKind, by: string, at = Date.now()): number {
    const result = this.db
      .prepare("UPDATE circuit_breakers SET cleared_at = ?, cleared_by = ? WHERE kind = ? AND cleared_at IS NULL")
      .run(at, by, kind);
    return result.changes;
  }

  history(limit = 50): { kind: string; trippedAt: number; clearedAt: number | null; clearedBy: string | null; arabic: string }[] {
    return this.db
      .prepare<[number], { kind: string; tripped_at: number; cleared_at: number | null; cleared_by: string | null; arabic: string }>(
        "SELECT kind, tripped_at, cleared_at, cleared_by, arabic FROM circuit_breakers ORDER BY tripped_at DESC LIMIT ?",
      )
      .all(limit)
      .map((r) => ({
        kind: r.kind, trippedAt: r.tripped_at, clearedAt: r.cleared_at,
        clearedBy: r.cleared_by, arabic: r.arabic,
      }));
  }
}
