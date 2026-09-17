/**
 * Worker state tests.
 *
 * These cover the three things that must survive a restart — the pending
 * action, the notification ledger and the heartbeat — plus the single
 * comparison that stops the live bot from filling on the candle that produced
 * the signal.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, openDb, type Db } from "@/storage/db";
import { NotificationRepo, PendingActionRepo, WorkerStateRepo } from "@/storage/repositories/worker";
import { mayExecuteOn } from "@/worker/bot";
import { decide, emptyPolicyState, parseQuietHours } from "@/notify/policy";
import { RecommendationRepo } from "@/storage/repositories/recommendations";
import { PositionRepo } from "@/storage/repositories/positions";
import { openPending } from "@/core/execution/paper-broker";
import { computeIntegrityHash } from "@/core/recommendation/builder";
import type { Recommendation } from "@/core/recommendation/types";
import type { PipelineRun } from "@/core/pipeline/types";
import type { PositionAction } from "@/core/execution/types";

const NOW = Date.UTC(2024, 5, 10, 12, 0, 0);
const HOUR = 3_600_000;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alslmany-worker-"));
  db = openDb(path.join(dir, "t.db"));
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("next-bar execution", () => {
  it("refuses to execute on the bar that produced the signal", () => {
    expect(mayExecuteOn(NOW, NOW)).toBe(false);
  });

  it("refuses to execute on an EARLIER bar", () => {
    expect(mayExecuteOn(NOW, NOW - HOUR)).toBe(false);
  });

  it("executes on the next bar", () => {
    expect(mayExecuteOn(NOW, NOW + HOUR)).toBe(true);
  });
});

/**
 * A real recommendation and position.
 *
 * `pending_actions` has a foreign key to `positions`, which itself points at
 * `recommendations` — deliberately, so an action can never be queued against
 * a position that does not exist. The test therefore seeds the real rows
 * instead of weakening the constraint to make testing easier.
 */
function seedPosition(database: Db, id = "REC-TEST"): string {
  const targets = [
    { index: 1 as const, price: 110, closeFraction: 0.5, rMultiple: 1, basis: "b" },
    { index: 2 as const, price: 120, closeFraction: 0.3, rMultiple: 2, basis: "b" },
    { index: 3 as const, price: 130, closeFraction: 0.2, rMultiple: 3, basis: "b" },
  ];
  const draft: Omit<Recommendation, "integrityHash"> = {
    id, symbol: "BTCUSDT", direction: "long", setup: "trend_continuation",
    regime: "trending_up", timeframe: "1h", generatedAt: NOW, asOfCandle: NOW,
    exchange: "binance", entry: { low: 99, high: 101, mid: 100 }, stop: 90,
    stopBasis: "خلف القاع", targets: targets as never, riskReward: 3, expectedR: 2,
    positionSize: 1, positionNotional: 100, riskAmount: 10, riskPercent: 1,
    confidence: 60, confidenceComponents: [], finalScore: 60,
    invalidation: [], expiresAt: NOW + 12 * HOUR, report: "تقرير",
  };
  const rec: Recommendation = { ...draft, integrityHash: computeIntegrityHash(draft) };
  const run: PipelineRun = {
    symbol: "BTCUSDT", tradingTimeframe: "1h", startedAt: NOW, finishedAt: NOW,
    stages: [], failedAt: null, regime: "trending_up", setup: null, vetoes: [],
    finalScore: 60, confidence: 60, recommendationId: id, arabic: "",
  };
  new RecommendationRepo(database).create(rec, run);
  new PositionRepo(database).save(openPending({
    id: `pos-${id}`, recommendationId: id, symbol: "BTCUSDT", direction: "long",
    timeframe: "1h", entry: rec.entry, stop: rec.stop, targets: targets as never,
    size: 1, risk: 10, expiresAt: rec.expiresAt,
  }));
  return `pos-${id}`;
}

describe("pending actions", () => {
  const actions: PositionAction[] = [{ kind: "fill_entry", price: 100, quantity: 2, reason: "r" }];

  it("survives being written and read back", () => {
    const positionId = seedPosition(db);
    const repo = new PendingActionRepo(db);
    repo.put({ positionId, decidedAt: NOW, candleTime: NOW - HOUR, actions });
    const back = repo.take(positionId);
    expect(back?.actions).toEqual(actions);
    expect(back?.candleTime).toBe(NOW - HOUR);
  });

  it("TAKES, so the same action cannot be applied twice", () => {
    // Applying a fill twice is a position opened twice.
    const positionId = seedPosition(db);
    const repo = new PendingActionRepo(db);
    repo.put({ positionId, decidedAt: NOW, candleTime: NOW, actions });
    expect(repo.take(positionId)).not.toBeNull();
    expect(repo.take(positionId)).toBeNull();
  });

  it("REFUSES an action queued against a position that does not exist", () => {
    // The foreign key is the point: an orphan action would be applied to
    // nothing, silently, forever.
    const repo = new PendingActionRepo(db);
    expect(() => repo.put({ positionId: "ghost", decidedAt: NOW, candleTime: NOW, actions }))
      .toThrow();
  });

  it("keeps one row per position, replacing a stale decision", () => {
    const positionId = seedPosition(db);
    const repo = new PendingActionRepo(db);
    repo.put({ positionId, decidedAt: NOW, candleTime: NOW, actions });
    repo.put({
      positionId, decidedAt: NOW + HOUR, candleTime: NOW + HOUR,
      actions: [{ kind: "expire", reason: "x" }],
    });
    expect(repo.all()).toHaveLength(1);
    expect(repo.take(positionId)?.actions[0].kind).toBe("expire");
  });
});

describe("the notification ledger", () => {
  it("rebuilds the dedupe state after a restart", () => {
    // Without this, a restart re-sends every open trade's alerts.
    const repo = new NotificationRepo(db);
    repo.record("target:REC1:1", "target_hit", NOW);

    const state = repo.loadState(NOW + HOUR, 86_400_000);
    const d = decide(
      { kind: "target_hit", dedupeKey: "target:REC1:1", text: "t", at: NOW + HOUR },
      state,
      { quietHours: parseQuietHours(""), maxPerHour: 6, dedupeWindowMs: 86_400_000 },
    );
    expect(d.send).toBe(false);
  });

  it("does not count critical sends toward the rolling-hour cap", () => {
    const repo = new NotificationRepo(db);
    for (let i = 0; i < 6; i++) repo.record(`stop:${i}`, "stop_hit", NOW + i * 1_000);
    expect(repo.loadState(NOW + 60_000, 86_400_000).recent).toHaveLength(0);
  });

  it("forgets entries outside the dedupe window", () => {
    const repo = new NotificationRepo(db);
    repo.record("old", "new_recommendation", NOW - 3 * 86_400_000);
    expect(repo.loadState(NOW, 86_400_000).sent.size).toBe(0);
  });

  it("starts empty, so a fresh database sends everything", () => {
    expect(new NotificationRepo(db).loadState(NOW, 86_400_000)).toEqual(emptyPolicyState());
  });
});

describe("the heartbeat", () => {
  it("accumulates ticks and counters", () => {
    const repo = new WorkerStateRepo(db);
    repo.start(NOW);
    repo.tick({ at: NOW + HOUR, durationMs: 1_200, analyses: 40, recommendations: 1, error: null });
    repo.tick({ at: NOW + 2 * HOUR, durationMs: 900, analyses: 40, recommendations: 0, error: null });

    const state = repo.get()!;
    expect(state.ticks).toBe(2);
    expect(state.analyses).toBe(80);
    expect(state.recommendations).toBe(1);
    expect(state.lastTickAt).toBe(NOW + 2 * HOUR);
    expect(state.lastError).toBeNull();
  });

  it("keeps the last error so a failing tick is visible, not silent", () => {
    const repo = new WorkerStateRepo(db);
    repo.start(NOW);
    repo.tick({ at: NOW + HOUR, durationMs: 10, analyses: 0, recommendations: 0, error: "boom" });
    expect(repo.get()?.lastError).toBe("boom");
  });

  it("clears the last error on a restart but keeps the counters", () => {
    const repo = new WorkerStateRepo(db);
    repo.start(NOW);
    repo.tick({ at: NOW, durationMs: 10, analyses: 5, recommendations: 0, error: "boom" });
    repo.start(NOW + HOUR);
    const state = repo.get()!;
    expect(state.lastError).toBeNull();
    expect(state.analyses).toBe(5);
  });

  it("reports nothing at all before the worker has ever run", () => {
    expect(new WorkerStateRepo(db).get()).toBeNull();
  });
});
