/**
 * Worker-owned state: pending actions, the notification ledger, the heartbeat.
 *
 * All three exist for the same reason — the worker restarts, and anything it
 * held only in memory is a correctness bug waiting for a deploy:
 *
 *  - Pending actions: the monitor decides on a closed candle and the broker
 *    fills at the NEXT candle's open. Live, those are an hour or a day apart.
 *  - The notification ledger: a restart that forgets what it sent re-sends
 *    every open trade's alerts.
 *  - The heartbeat: stale candles look identical whether the worker died or
 *    the venue did, so the health page needs the worker to say so itself.
 */
import type { Db } from "@/storage/db";
import type { PositionAction } from "@/core/execution/types";
import type { NotificationKind, PolicyState } from "@/notify/policy";
import { CRITICAL } from "@/notify/policy";

export interface PendingActions {
  readonly positionId: string;
  readonly decidedAt: number;
  readonly candleTime: number;
  readonly actions: readonly PositionAction[];
}

export class PendingActionRepo {
  constructor(private readonly db: Db) {}

  put(p: PendingActions): void {
    this.db.prepare(`
      INSERT INTO pending_actions (position_id, decided_at, candle_time, actions_json)
      VALUES (?,?,?,?)
      ON CONFLICT (position_id) DO UPDATE SET
        decided_at = excluded.decided_at,
        candle_time = excluded.candle_time,
        actions_json = excluded.actions_json
    `).run(p.positionId, p.decidedAt, p.candleTime, JSON.stringify(p.actions));
  }

  take(positionId: string): PendingActions | null {
    const row = this.db.prepare(
      "SELECT * FROM pending_actions WHERE position_id = ?",
    ).get(positionId) as
      | { position_id: string; decided_at: number; candle_time: number; actions_json: string }
      | undefined;
    if (!row) return null;

    // Taking REMOVES it: an action applied twice is a position filled twice.
    this.db.prepare("DELETE FROM pending_actions WHERE position_id = ?").run(positionId);
    return {
      positionId: row.position_id,
      decidedAt: row.decided_at,
      candleTime: row.candle_time,
      actions: JSON.parse(row.actions_json) as PositionAction[],
    };
  }

  clear(positionId: string): void {
    this.db.prepare("DELETE FROM pending_actions WHERE position_id = ?").run(positionId);
  }

  all(): PendingActions[] {
    const rows = this.db.prepare("SELECT * FROM pending_actions").all() as {
      position_id: string; decided_at: number; candle_time: number; actions_json: string;
    }[];
    return rows.map((r) => ({
      positionId: r.position_id,
      decidedAt: r.decided_at,
      candleTime: r.candle_time,
      actions: JSON.parse(r.actions_json) as PositionAction[],
    }));
  }
}

export class NotificationRepo {
  constructor(private readonly db: Db) {}

  record(dedupeKey: string, kind: NotificationKind, at: number): void {
    this.db.prepare(`
      INSERT INTO notifications (dedupe_key, kind, sent_at, critical) VALUES (?,?,?,?)
      ON CONFLICT (dedupe_key) DO UPDATE SET sent_at = excluded.sent_at
    `).run(dedupeKey, kind, at, CRITICAL.has(kind) ? 1 : 0);
  }

  /**
   * Rebuild the in-memory policy state from disk.
   *
   * `since` bounds the dedupe memory; the rolling-hour list is rebuilt from
   * the non-critical rows only, matching how the policy counts them.
   */
  loadState(now: number, dedupeWindowMs: number): PolicyState {
    const rows = this.db.prepare(
      "SELECT dedupe_key, sent_at, critical FROM notifications WHERE sent_at > ?",
    ).all(now - dedupeWindowMs) as { dedupe_key: string; sent_at: number; critical: number }[];

    const sent = new Map<string, number>();
    const recent: number[] = [];
    for (const r of rows) {
      sent.set(r.dedupe_key, r.sent_at);
      if (!r.critical && r.sent_at > now - 3_600_000) recent.push(r.sent_at);
    }
    return { sent, recent };
  }

  prune(before: number): number {
    return this.db.prepare("DELETE FROM notifications WHERE sent_at < ?").run(before).changes;
  }
}

export interface WorkerState {
  readonly startedAt: number;
  readonly lastTickAt: number;
  readonly lastTickMs: number;
  readonly ticks: number;
  readonly analyses: number;
  readonly recommendations: number;
  readonly lastError: string | null;
}

export class WorkerStateRepo {
  constructor(private readonly db: Db) {}

  start(at: number): void {
    this.db.prepare(`
      INSERT INTO worker_state (id, started_at, last_tick_at, last_tick_ms, ticks, analyses, recommendations, last_error)
      VALUES (1,?,?,0,0,0,0,NULL)
      ON CONFLICT (id) DO UPDATE SET started_at = excluded.started_at, last_error = NULL
    `).run(at, at);
  }

  tick(x: { at: number; durationMs: number; analyses: number; recommendations: number; error: string | null }): void {
    this.db.prepare(`
      UPDATE worker_state SET
        last_tick_at = ?, last_tick_ms = ?, ticks = ticks + 1,
        analyses = analyses + ?, recommendations = recommendations + ?, last_error = ?
      WHERE id = 1
    `).run(x.at, Math.round(x.durationMs), x.analyses, x.recommendations, x.error);
  }

  get(): WorkerState | null {
    const r = this.db.prepare("SELECT * FROM worker_state WHERE id = 1").get() as
      | {
          started_at: number; last_tick_at: number; last_tick_ms: number;
          ticks: number; analyses: number; recommendations: number; last_error: string | null;
        }
      | undefined;
    return r
      ? {
          startedAt: r.started_at, lastTickAt: r.last_tick_at, lastTickMs: r.last_tick_ms,
          ticks: r.ticks, analyses: r.analyses, recommendations: r.recommendations,
          lastError: r.last_error,
        }
      : null;
  }
}
