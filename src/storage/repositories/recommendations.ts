/**
 * Recommendation storage — append only.
 *
 * The database itself refuses UPDATE and DELETE on these tables (see
 * migration 2), so this repository has no update method to offer. Anything
 * that happens to a recommendation afterwards is an EVENT, and the current
 * state of a trade is DERIVED by replaying its events rather than read from a
 * mutable status column.
 *
 * That derivation is not ceremony: it is what makes the history
 * reconstructible at any past instant, which is what the backtester needs and
 * what the performance page has to be able to prove.
 */
import crypto from "node:crypto";
import type { Db } from "@/storage/db";
import type {
  Recommendation, RecommendationEvent, RecommendationEventKind, Target,
} from "@/core/recommendation/types";
import { computeIntegrityHash } from "@/core/recommendation/builder";
import type { PipelineRun, StageId } from "@/core/pipeline/types";
import type { Timeframe } from "@/shared/time";

interface Row {
  id: string; symbol: string; direction: string; setup: string; regime: string;
  timeframe: string; exchange: string; generated_at: number; as_of_candle: number;
  entry_low: number; entry_high: number; entry_mid: number;
  stop: number; stop_basis: string; targets_json: string;
  risk_reward: number; expected_r: number; position_size: number; position_notional: number;
  risk_amount: number; risk_percent: number;
  confidence: number; final_score: number;
  confidence_components_json: string; invalidation_json: string;
  expires_at: number; report: string; integrity_hash: string; pipeline_json: string;
}

function toRecommendation(r: Row): Recommendation {
  return {
    id: r.id,
    symbol: r.symbol,
    direction: r.direction as Recommendation["direction"],
    setup: r.setup as Recommendation["setup"],
    regime: r.regime as Recommendation["regime"],
    timeframe: r.timeframe as Timeframe,
    exchange: r.exchange,
    generatedAt: r.generated_at,
    asOfCandle: r.as_of_candle,
    entry: { low: r.entry_low, high: r.entry_high, mid: r.entry_mid },
    stop: r.stop,
    stopBasis: r.stop_basis,
    targets: JSON.parse(r.targets_json) as readonly Target[],
    riskReward: r.risk_reward,
    expectedR: r.expected_r ?? 0,
    positionSize: r.position_size,
    positionNotional: r.position_notional,
    riskAmount: r.risk_amount,
    riskPercent: r.risk_percent,
    confidence: r.confidence,
    finalScore: r.final_score,
    confidenceComponents: JSON.parse(r.confidence_components_json),
    invalidation: JSON.parse(r.invalidation_json),
    expiresAt: r.expires_at,
    report: r.report,
    integrityHash: r.integrity_hash,
  };
}

/** Derived from the event log; never stored as a column. */
export type TradeState =
  | "pending"      // generated, price has not reached the entry zone
  | "open"         // entry filled
  | "partial"      // at least one target taken
  | "closed"       // fully exited
  | "expired"      // entry never reached in time
  | "invalidated"; // conditions changed before entry

export interface RecommendationWithState extends Recommendation {
  readonly state: TradeState;
  readonly events: readonly RecommendationEvent[];
}

const COLS = `id, symbol, direction, setup, regime, timeframe, exchange,
  generated_at, as_of_candle, entry_low, entry_high, entry_mid, stop, stop_basis,
  targets_json, risk_reward, expected_r, position_size, position_notional, risk_amount,
  risk_percent, confidence, final_score, confidence_components_json,
  invalidation_json, expires_at, report, integrity_hash, pipeline_json`;

export class RecommendationRepo {
  constructor(private readonly db: Db) {}

  /**
   * Store a recommendation and its "created" event atomically.
   *
   * Re-inserting the same id is a no-op rather than an error: the pipeline is
   * deterministic, so re-analysing the same closed bar legitimately produces
   * the same recommendation, and that must not crash a 24/7 worker.
   */
  create(rec: Recommendation, run: PipelineRun): boolean {
    const existing = this.db
      .prepare<[string], { id: string }>("SELECT id FROM recommendations WHERE id = ?")
      .get(rec.id);
    if (existing) return false;

    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO recommendations (${COLS}) VALUES (
            @id, @symbol, @direction, @setup, @regime, @timeframe, @exchange,
            @generated_at, @as_of_candle, @entry_low, @entry_high, @entry_mid,
            @stop, @stop_basis, @targets_json, @risk_reward, @expected_r, @position_size,
            @position_notional, @risk_amount, @risk_percent, @confidence,
            @final_score, @confidence_components_json, @invalidation_json,
            @expires_at, @report, @integrity_hash, @pipeline_json)`,
        )
        .run({
          id: rec.id, symbol: rec.symbol, direction: rec.direction, setup: rec.setup,
          regime: rec.regime, timeframe: rec.timeframe, exchange: rec.exchange,
          generated_at: rec.generatedAt, as_of_candle: rec.asOfCandle,
          entry_low: rec.entry.low, entry_high: rec.entry.high, entry_mid: rec.entry.mid,
          stop: rec.stop, stop_basis: rec.stopBasis,
          targets_json: JSON.stringify(rec.targets),
          risk_reward: rec.riskReward, expected_r: rec.expectedR, position_size: rec.positionSize,
          position_notional: rec.positionNotional, risk_amount: rec.riskAmount,
          risk_percent: rec.riskPercent, confidence: rec.confidence,
          final_score: rec.finalScore,
          confidence_components_json: JSON.stringify(rec.confidenceComponents),
          invalidation_json: JSON.stringify(rec.invalidation),
          expires_at: rec.expiresAt, report: rec.report,
          integrity_hash: rec.integrityHash,
          pipeline_json: JSON.stringify(run),
        });

      this.appendEventInternal({
        recommendationId: rec.id,
        kind: "created",
        at: rec.generatedAt,
        candleTime: rec.asOfCandle,
        price: rec.entry.mid,
        payload: { confidence: rec.confidence, finalScore: rec.finalScore },
        arabic: `أُنشئت التوصية: ${rec.direction === "long" ? "شراء" : "بيع"} ${rec.symbol} بثقة ${rec.confidence}%`,
      });
    });
    insert();
    return true;
  }

  /** The ONLY way to record anything after creation. */
  appendEvent(e: Omit<RecommendationEvent, "id">): RecommendationEvent {
    return this.appendEventInternal(e);
  }

  private appendEventInternal(e: Omit<RecommendationEvent, "id">): RecommendationEvent {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO recommendation_events
         (id, recommendation_id, kind, at, candle_time, price, payload_json, arabic)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(id, e.recommendationId, e.kind, e.at, e.candleTime, e.price, JSON.stringify(e.payload), e.arabic);
    return { id, ...e };
  }

  get(id: string): Recommendation | null {
    const r = this.db.prepare<[string], Row>(`SELECT ${COLS} FROM recommendations WHERE id = ?`).get(id);
    return r ? toRecommendation(r) : null;
  }

  events(recommendationId: string): RecommendationEvent[] {
    return this.db
      .prepare<[string], {
        id: string; recommendation_id: string; kind: string; at: number;
        candle_time: number | null; price: number | null; payload_json: string; arabic: string;
      }>(
        `SELECT * FROM recommendation_events WHERE recommendation_id = ? ORDER BY at ASC, rowid ASC`,
      )
      .all(recommendationId)
      .map((e) => ({
        id: e.id,
        recommendationId: e.recommendation_id,
        kind: e.kind as RecommendationEventKind,
        at: e.at,
        candleTime: e.candle_time,
        price: e.price,
        payload: JSON.parse(e.payload_json),
        arabic: e.arabic,
      }));
  }

  /**
   * Replay the event log to get the current state.
   *
   * Order matters: a terminal event wins over an earlier one, and the replay
   * is what lets us ask "what was the state at time T" for the backtest.
   */
  withState(id: string, asOf = Infinity): RecommendationWithState | null {
    const rec = this.get(id);
    if (!rec) return null;
    const events = this.events(id).filter((e) => e.at <= asOf);

    let state: TradeState = "pending";
    for (const e of events) {
      switch (e.kind) {
        case "entry_filled": state = "open"; break;
        case "target_hit":
        case "partial_exit": if (state === "open") state = "partial"; break;
        case "stop_hit":
        case "closed": state = "closed"; break;
        case "expired": if (state === "pending") state = "expired"; break;
        case "invalidated": if (state === "pending" || state === "open") state = "invalidated"; break;
        default: break;
      }
    }
    return { ...rec, state, events };
  }

  recent(limit = 50): Recommendation[] {
    return this.db
      .prepare<[number], Row>(`SELECT ${COLS} FROM recommendations ORDER BY generated_at DESC LIMIT ?`)
      .all(limit)
      .map(toRecommendation);
  }

  /** Recommendations that are still live — pending, open, or partially taken. */
  active(now = Date.now()): RecommendationWithState[] {
    return this.db
      .prepare<[], Row>(`SELECT ${COLS} FROM recommendations ORDER BY generated_at DESC LIMIT 500`)
      .all()
      .map((r) => this.withState(r.id, now))
      .filter((r): r is RecommendationWithState =>
        r !== null && (r.state === "pending" || r.state === "open" || r.state === "partial"),
      );
  }

  hasActive(symbol: string, now = Date.now()): boolean {
    return this.active(now).some((r) => r.symbol === symbol);
  }

  /**
   * Verify stored rows still hash to their recorded value.
   *
   * The triggers make tampering through this process impossible; this catches
   * anything that edited the file directly.
   */
  verifyIntegrity(): { id: string; ok: boolean }[] {
    return this.recent(1000).map((rec) => {
      const { integrityHash, ...rest } = rec;
      return { id: rec.id, ok: computeIntegrityHash(rest) === integrityHash };
    });
  }
}

// ── rejected analyses ────────────────────────────────────────────────────────

export interface RejectedAnalysis {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly analyzedAt: number;
  readonly failedStage: StageId;
  readonly failedNumber: number;
  readonly reason: string;
  readonly finalScore: number | null;
}

/**
 * Every analysis that produced no recommendation.
 *
 * This is a first-class table, not a log line. "Rejected analyses" is a page
 * on the site, and the funnel counter on the dashboard — how many coins died
 * at each stage — is the honest check on whether the filters are doing
 * anything. One recommendation per 20-100 analyses is the expected ratio; far
 * more means the filters are too loose.
 */
export class RejectedRepo {
  constructor(private readonly db: Db) {}

  record(run: PipelineRun, reason: string): void {
    const failed = run.stages.find((s) => s.status === "fail");
    this.db
      .prepare(
        `INSERT INTO rejected_analyses
         (symbol, timeframe, analyzed_at, failed_stage, failed_number, reason,
          final_score, vetoes_json, pipeline_json)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.symbol, run.tradingTimeframe, run.finishedAt,
        failed?.id ?? run.failedAt ?? "council",
        failed?.number ?? 8,
        reason,
        Number.isFinite(run.finalScore) ? run.finalScore : null,
        JSON.stringify(run.vetoes),
        JSON.stringify(run),
      );
  }

  recent(limit = 100): (RejectedAnalysis & { vetoes: unknown[] })[] {
    return this.db
      .prepare<[number], {
        symbol: string; timeframe: string; analyzed_at: number; failed_stage: string;
        failed_number: number; reason: string; final_score: number | null; vetoes_json: string;
      }>(
        `SELECT symbol, timeframe, analyzed_at, failed_stage, failed_number, reason,
                final_score, vetoes_json
         FROM rejected_analyses ORDER BY analyzed_at DESC LIMIT ?`,
      )
      .all(limit)
      .map((r) => ({
        symbol: r.symbol,
        timeframe: r.timeframe as Timeframe,
        analyzedAt: r.analyzed_at,
        failedStage: r.failed_stage as StageId,
        failedNumber: r.failed_number,
        reason: r.reason,
        finalScore: r.final_score,
        vetoes: JSON.parse(r.vetoes_json),
      }));
  }

  /** The dashboard funnel: how many died at each stage in a window. */
  funnel(since: number): { stage: StageId; number: number; count: number }[] {
    return this.db
      .prepare<[number], { failed_stage: string; failed_number: number; count: number }>(
        `SELECT failed_stage, failed_number, COUNT(*) AS count
         FROM rejected_analyses WHERE analyzed_at >= ?
         GROUP BY failed_stage, failed_number ORDER BY failed_number`,
      )
      .all(since)
      .map((r) => ({ stage: r.failed_stage as StageId, number: r.failed_number, count: r.count }));
  }

  countSince(since: number): number {
    return (
      this.db
        .prepare<[number], { n: number }>(
          "SELECT COUNT(*) AS n FROM rejected_analyses WHERE analyzed_at >= ?",
        )
        .get(since)?.n ?? 0
    );
  }
}
