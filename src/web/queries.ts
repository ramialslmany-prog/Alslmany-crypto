/**
 * Every read the site performs.
 *
 * Collected here rather than scattered through pages so the shapes stay
 * consistent and so there is one place to look when a number on one page
 * disagrees with the same number on another.
 */
import { query } from "@/web/db";
import { STAGE_NAMES_AR, STAGE_NUMBER, type StageId } from "@/core/pipeline/types";
import type { Timeframe } from "@/shared/time";

const DAY = 86_400_000;

// ── recommendations ──────────────────────────────────────────────────────────

export interface RecRow {
  id: string;
  symbol: string;
  direction: "long" | "short";
  setup: string;
  regime: string;
  timeframe: Timeframe;
  generatedAt: number;
  entryLow: number;
  entryHigh: number;
  entryMid: number;
  stop: number;
  stopBasis: string;
  targets: { index: 1 | 2 | 3; price: number; closeFraction: number; rMultiple: number; basis: string }[];
  riskReward: number;
  positionSize: number;
  positionNotional: number;
  riskAmount: number;
  confidence: number;
  finalScore: number;
  confidenceComponents: { stage: StageId; name: string; score: number; weight: number; contribution: number; status: string; note: string }[];
  invalidation: { id: string; arabic: string }[];
  expiresAt: number;
  report: string;
  integrityHash: string;
}

const REC_COLS = `id, symbol, direction, setup, regime, timeframe, generated_at,
  entry_low, entry_high, entry_mid, stop, stop_basis, targets_json, risk_reward,
  position_size, position_notional, risk_amount, confidence, final_score,
  confidence_components_json, invalidation_json, expires_at, report, integrity_hash`;

interface RawRec {
  id: string; symbol: string; direction: string; setup: string; regime: string;
  timeframe: string; generated_at: number; entry_low: number; entry_high: number;
  entry_mid: number; stop: number; stop_basis: string; targets_json: string;
  risk_reward: number; position_size: number; position_notional: number;
  risk_amount: number; confidence: number; final_score: number;
  confidence_components_json: string; invalidation_json: string;
  expires_at: number; report: string; integrity_hash: string;
}

const toRec = (r: RawRec): RecRow => ({
  id: r.id, symbol: r.symbol, direction: r.direction as "long" | "short",
  setup: r.setup, regime: r.regime, timeframe: r.timeframe as Timeframe,
  generatedAt: r.generated_at, entryLow: r.entry_low, entryHigh: r.entry_high,
  entryMid: r.entry_mid, stop: r.stop, stopBasis: r.stop_basis,
  targets: JSON.parse(r.targets_json), riskReward: r.risk_reward,
  positionSize: r.position_size, positionNotional: r.position_notional,
  riskAmount: r.risk_amount, confidence: r.confidence, finalScore: r.final_score,
  confidenceComponents: JSON.parse(r.confidence_components_json),
  invalidation: JSON.parse(r.invalidation_json), expiresAt: r.expires_at,
  report: r.report, integrityHash: r.integrity_hash,
});

export function recentRecommendations(limit = 100): RecRow[] {
  return query(
    (db) => db.prepare<[number], RawRec>(
      `SELECT ${REC_COLS} FROM recommendations ORDER BY generated_at DESC LIMIT ?`,
    ).all(limit).map(toRec),
    [],
  );
}

export function recommendation(id: string): RecRow | null {
  return query(
    (db) => {
      const r = db.prepare<[string], RawRec>(`SELECT ${REC_COLS} FROM recommendations WHERE id = ?`).get(id);
      return r ? toRec(r) : null;
    },
    null,
  );
}

/** The full pipeline run stored with a recommendation — the audit trail. */
export function pipelineRun(id: string): unknown | null {
  return query(
    (db) => {
      const r = db.prepare<[string], { pipeline_json: string }>(
        "SELECT pipeline_json FROM recommendations WHERE id = ?",
      ).get(id);
      return r ? JSON.parse(r.pipeline_json) : null;
    },
    null,
  );
}

export interface EventRow {
  kind: string;
  at: number;
  price: number | null;
  arabic: string;
}

export function recommendationEvents(id: string): EventRow[] {
  return query(
    (db) => db.prepare<[string], EventRow>(
      "SELECT kind, at, price, arabic FROM recommendation_events WHERE recommendation_id = ? ORDER BY at ASC",
    ).all(id),
    [],
  );
}

/** State derived by replaying events — never read from a status column. */
export function recommendationStates(): Map<string, string> {
  return query(
    (db) => {
      const rows = db.prepare<[], { recommendation_id: string; kind: string }>(
        "SELECT recommendation_id, kind FROM recommendation_events ORDER BY at ASC, rowid ASC",
      ).all();
      const states = new Map<string, string>();
      for (const e of rows) {
        const current = states.get(e.recommendation_id) ?? "pending";
        let next = current;
        if (e.kind === "entry_filled") next = "open";
        else if ((e.kind === "target_hit" || e.kind === "partial_exit") && current === "open") next = "partial";
        else if (e.kind === "stop_hit" || e.kind === "closed") next = "closed";
        else if (e.kind === "expired" && current === "pending") next = "expired";
        else if (e.kind === "invalidated" && (current === "pending" || current === "open")) next = "invalidated";
        states.set(e.recommendation_id, next);
      }
      return states;
    },
    new Map(),
  );
}

// ── rejected analyses ────────────────────────────────────────────────────────

export interface RejectedRow {
  symbol: string;
  timeframe: Timeframe;
  analyzedAt: number;
  failedStage: StageId;
  failedNumber: number;
  reason: string;
  finalScore: number | null;
}

export function rejectedAnalyses(limit = 200): RejectedRow[] {
  return query(
    (db) => db.prepare<[number], {
      symbol: string; timeframe: string; analyzed_at: number; failed_stage: string;
      failed_number: number; reason: string; final_score: number | null;
    }>(
      `SELECT symbol, timeframe, analyzed_at, failed_stage, failed_number, reason, final_score
       FROM rejected_analyses ORDER BY analyzed_at DESC LIMIT ?`,
    ).all(limit).map((r) => ({
      symbol: r.symbol, timeframe: r.timeframe as Timeframe, analyzedAt: r.analyzed_at,
      failedStage: r.failed_stage as StageId, failedNumber: r.failed_number,
      reason: r.reason, finalScore: r.final_score,
    })),
    [],
  );
}

/**
 * The funnel: how many analyses died at each stage, and how many survived.
 *
 * This is the honest check on whether the filters do anything. One
 * recommendation per 20-100 analyses is the expected shape; far more means
 * the filters are too loose, and the dashboard says so out loud.
 */
export interface FunnelStage {
  stage: StageId;
  number: number;
  name: string;
  rejected: number;
}

export interface Funnel {
  analyzed: number;
  recommendations: number;
  stages: FunnelStage[];
  /** Analyses per recommendation. Null when nothing was produced. */
  ratio: number | null;
  verdict: "healthy" | "too_loose" | "too_tight" | "no_data";
  arabic: string;
}

export function funnel(sinceMs = Date.now() - DAY): Funnel {
  const stages = query(
    (db) => db.prepare<[number], { failed_stage: string; failed_number: number; count: number }>(
      `SELECT failed_stage, failed_number, COUNT(*) AS count
       FROM rejected_analyses WHERE analyzed_at >= ? GROUP BY failed_stage, failed_number
       ORDER BY failed_number`,
    ).all(sinceMs),
    [] as { failed_stage: string; failed_number: number; count: number }[],
  );

  const rejected = stages.reduce((s, x) => s + x.count, 0);
  const produced = query(
    (db) => db.prepare<[number], { n: number }>(
      "SELECT COUNT(*) AS n FROM recommendations WHERE generated_at >= ?",
    ).get(sinceMs)?.n ?? 0,
    0,
  );

  const analyzed = rejected + produced;
  const ratio = produced > 0 ? analyzed / produced : null;

  let verdict: Funnel["verdict"] = "no_data";
  let arabic = "لم يُحلَّل شيء في هذه النافذة بعد.";

  if (analyzed > 0) {
    if (produced === 0) {
      verdict = "too_tight";
      arabic = `حُلّلت ${analyzed} عملة ولم تُنتج أي توصية. هذا طبيعي في يوم هادئ، ومقلق إن استمرّ أياماً.`;
    } else if (ratio !== null && ratio < 20) {
      verdict = "too_loose";
      arabic =
        `توصية واحدة لكل ${ratio.toFixed(0)} تحليل. النسبة المنطقية واحدة لكل 20 إلى 100 — ` +
        `أقلّ من ذلك يعني أن الفلاتر ضعيفة وتمرّر ما لا يستحق.`;
    } else if (ratio !== null && ratio > 100) {
      verdict = "too_tight";
      arabic = `توصية واحدة لكل ${ratio.toFixed(0)} تحليل — الفلاتر صارمة جداً وقد تفوّت فرصاً حقيقية.`;
    } else {
      verdict = "healthy";
      arabic = `توصية واحدة لكل ${ratio?.toFixed(0)} تحليل — ضمن النسبة المنطقية.`;
    }
  }

  const byStage = new Map(stages.map((s) => [s.failed_stage, s.count]));
  const allStages: FunnelStage[] = (Object.keys(STAGE_NUMBER) as StageId[]).map((id) => ({
    stage: id,
    number: STAGE_NUMBER[id],
    name: STAGE_NAMES_AR[id],
    rejected: byStage.get(id) ?? 0,
  }));

  return { analyzed, recommendations: produced, stages: allStages, ratio, verdict, arabic };
}

// ── positions and equity ─────────────────────────────────────────────────────

export interface PositionRow {
  id: string;
  recommendationId: string;
  symbol: string;
  direction: "long" | "short";
  timeframe: Timeframe;
  status: string;
  averageEntry: number;
  currentStop: number;
  openQuantity: number;
  targetsHit: number[];
  openedAt: number | null;
  closedAt: number | null;
  exitReason: string | null;
  realizedPnl: number;
  realizedR: number;
  maxFavorableR: number;
  maxAdverseR: number;
  barsHeld: number;
}

const POS_COLS = `id, recommendation_id, symbol, direction, timeframe, status,
  average_entry, current_stop, open_quantity, targets_hit_json, opened_at,
  closed_at, exit_reason, realized_pnl, realized_r, max_favorable_r,
  max_adverse_r, bars_held`;

interface RawPos {
  id: string; recommendation_id: string; symbol: string; direction: string;
  timeframe: string; status: string; average_entry: number; current_stop: number;
  open_quantity: number; targets_hit_json: string; opened_at: number | null;
  closed_at: number | null; exit_reason: string | null; realized_pnl: number;
  realized_r: number; max_favorable_r: number; max_adverse_r: number; bars_held: number;
}

const toPos = (r: RawPos): PositionRow => ({
  id: r.id, recommendationId: r.recommendation_id, symbol: r.symbol,
  direction: r.direction as "long" | "short", timeframe: r.timeframe as Timeframe,
  status: r.status, averageEntry: r.average_entry, currentStop: r.current_stop,
  openQuantity: r.open_quantity, targetsHit: JSON.parse(r.targets_hit_json),
  openedAt: r.opened_at, closedAt: r.closed_at, exitReason: r.exit_reason,
  realizedPnl: r.realized_pnl, realizedR: r.realized_r,
  maxFavorableR: r.max_favorable_r, maxAdverseR: r.max_adverse_r, barsHeld: r.bars_held,
});

export function livePositions(): PositionRow[] {
  return query(
    (db) => db.prepare<[], RawPos>(
      `SELECT ${POS_COLS} FROM positions WHERE status IN ('pending','open') ORDER BY opened_at DESC`,
    ).all().map(toPos),
    [],
  );
}

export function closedPositions(limit = 300): PositionRow[] {
  return query(
    (db) => db.prepare<[number], RawPos>(
      `SELECT ${POS_COLS} FROM positions
       WHERE status IN ('closed','expired','invalidated') ORDER BY closed_at DESC LIMIT ?`,
    ).all(limit).map(toPos),
    [],
  );
}

export interface EquityPoint { at: number; equity: number; drawdownPct: number; btcPrice: number | null }

export function equityCurve(from = 0): EquityPoint[] {
  return query(
    (db) => db.prepare<[number], { at: number; equity: number; drawdown_pct: number; btc_price: number | null }>(
      "SELECT at, equity, drawdown_pct, btc_price FROM equity_curve WHERE at >= ? ORDER BY at",
    ).all(from).map((r) => ({ at: r.at, equity: r.equity, drawdownPct: r.drawdown_pct, btcPrice: r.btc_price })),
    [],
  );
}

export interface PortfolioNow {
  equity: number;
  peakEquity: number;
  drawdownPct: number;
  dayPnlPct: number;
  openPositions: number;
  exposure: number;
  at: number;
}

export function portfolio(): PortfolioNow | null {
  return query(
    (db) => {
      const r = db.prepare<[], {
        at: number; equity: number; peak_equity: number; drawdown_pct: number;
        day_pnl_pct: number; open_positions: number; exposure: number;
      }>("SELECT * FROM equity_curve ORDER BY at DESC LIMIT 1").get();
      if (!r) return null;
      return {
        equity: r.equity, peakEquity: r.peak_equity, drawdownPct: r.drawdown_pct,
        dayPnlPct: r.day_pnl_pct, openPositions: r.open_positions,
        exposure: r.exposure, at: r.at,
      };
    },
    null,
  );
}

// ── performance ──────────────────────────────────────────────────────────────

export interface Performance {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number | null;
  expectancyR: number;
  totalR: number;
  avgWinR: number;
  avgLossR: number;
  maxDrawdownPct: number;
  /** R distribution, bucketed for the histogram. */
  distribution: { bucket: string; count: number }[];
}

export function performance(positions: PositionRow[]): Performance {
  const closed = positions.filter((p) => p.status === "closed");
  const wins = closed.filter((p) => p.realizedR > 0);
  const losses = closed.filter((p) => p.realizedR <= 0);

  const grossWin = wins.reduce((s, p) => s + p.realizedR, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p.realizedR, 0));
  const totalR = closed.reduce((s, p) => s + p.realizedR, 0);

  // Bucket in R, because R is the only unit comparable across symbols.
  const buckets = [
    { bucket: "< −2R", min: -Infinity, max: -2 },
    { bucket: "−2R…−1R", min: -2, max: -1 },
    { bucket: "−1R…0", min: -1, max: 0 },
    { bucket: "0…1R", min: 0, max: 1 },
    { bucket: "1R…2R", min: 1, max: 2 },
    { bucket: "2R…3R", min: 2, max: 3 },
    { bucket: "> 3R", min: 3, max: Infinity },
  ];

  return {
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? wins.length / closed.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancyR: closed.length > 0 ? totalR / closed.length : 0,
    totalR,
    avgWinR: wins.length > 0 ? grossWin / wins.length : 0,
    avgLossR: losses.length > 0 ? -grossLoss / losses.length : 0,
    maxDrawdownPct: 0,
    distribution: buckets.map((b) => ({
      bucket: b.bucket,
      count: closed.filter((p) => p.realizedR >= b.min && p.realizedR < b.max).length,
    })),
  };
}

/** Performance sliced by a dimension — setup, timeframe, symbol, regime. */
export function performanceBy(
  positions: PositionRow[],
  recs: Map<string, RecRow>,
  dimension: "setup" | "timeframe" | "symbol" | "regime",
): { key: string; trades: number; winRate: number; expectancyR: number; totalR: number }[] {
  const groups = new Map<string, PositionRow[]>();

  for (const p of positions.filter((x) => x.status === "closed")) {
    const rec = recs.get(p.recommendationId);
    const key =
      dimension === "timeframe" ? p.timeframe :
      dimension === "symbol" ? p.symbol :
      dimension === "setup" ? (rec?.setup ?? "غير معروف") :
      (rec?.regime ?? "غير معروف");
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }

  return [...groups.entries()]
    .map(([key, list]) => {
      const totalR = list.reduce((s, p) => s + p.realizedR, 0);
      return {
        key,
        trades: list.length,
        winRate: list.filter((p) => p.realizedR > 0).length / list.length,
        expectancyR: totalR / list.length,
        totalR,
      };
    })
    .sort((a, b) => b.trades - a.trades);
}

// ── health ───────────────────────────────────────────────────────────────────

export interface HealthRow {
  provider: string;
  label: string;
  enabled: boolean;
  lastOkAt: number | null;
  lastFailAt: number | null;
  lastReasonAr: string | null;
  lastDetail: string | null;
  lastLatencyMs: number | null;
  okCount: number;
  failCount: number;
}

export function providerHealth(): HealthRow[] {
  return query(
    (db) => db.prepare<[], {
      provider: string; label: string; enabled: number; last_ok_at: number | null;
      last_fail_at: number | null; last_reason: string | null; last_detail: string | null;
      last_latency_ms: number | null; ok_count: number; fail_count: number;
    }>("SELECT * FROM provider_health ORDER BY provider").all().map((r) => ({
      provider: r.provider, label: r.label, enabled: r.enabled === 1,
      lastOkAt: r.last_ok_at, lastFailAt: r.last_fail_at,
      lastReasonAr: r.last_reason, lastDetail: r.last_detail,
      lastLatencyMs: r.last_latency_ms, okCount: r.ok_count, failCount: r.fail_count,
    })),
    [],
  );
}

export interface GapRow { symbol: string; timeframe: Timeframe; missingBars: number; gapStart: number; gapEnd: number }

export function openGaps(limit = 100): GapRow[] {
  return query(
    (db) => db.prepare<[number], { symbol: string; timeframe: string; missing_bars: number; gap_start: number; gap_end: number }>(
      `SELECT symbol, timeframe, missing_bars, gap_start, gap_end FROM data_gaps
       WHERE resolved_at IS NULL ORDER BY missing_bars DESC LIMIT ?`,
    ).all(limit).map((r) => ({
      symbol: r.symbol, timeframe: r.timeframe as Timeframe,
      missingBars: r.missing_bars, gapStart: r.gap_start, gapEnd: r.gap_end,
    })),
    [],
  );
}

export interface CoverageRow { symbol: string; timeframe: Timeframe; bars: number; first: number; last: number }

export function candleCoverage(limit = 200): CoverageRow[] {
  return query(
    (db) => db.prepare<[number], { symbol: string; timeframe: string; n: number; first: number; last: number }>(
      `SELECT symbol, timeframe, COUNT(*) AS n, MIN(open_time) AS first, MAX(open_time) AS last
       FROM candles GROUP BY symbol, timeframe ORDER BY symbol, timeframe LIMIT ?`,
    ).all(limit).map((r) => ({
      symbol: r.symbol, timeframe: r.timeframe as Timeframe,
      bars: r.n, first: r.first, last: r.last,
    })),
    [],
  );
}

export function archiveSummary(): { status: string; count: number; rows: number }[] {
  return query(
    (db) => db.prepare<[], { status: string; count: number; rows: number }>(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(rows_imported),0) AS rows
       FROM archive_files GROUP BY status ORDER BY status`,
    ).all(),
    [],
  );
}

export function unverifiedArchiveCount(): number {
  return query(
    (db) => db.prepare<[], { n: number }>(
      "SELECT COUNT(*) AS n FROM archive_files WHERE status = 'imported' AND checksum_ok IS NOT 1",
    ).get()?.n ?? 0,
    0,
  );
}

// ── circuit breakers ─────────────────────────────────────────────────────────

export interface BreakerRow {
  kind: string;
  trippedAt: number;
  resumesAt: number | null;
  requiresManualReset: boolean;
  arabic: string;
}

export function activeBreakers(now = Date.now()): BreakerRow[] {
  return query(
    (db) => db.prepare<[], {
      kind: string; tripped_at: number; resumes_at: number | null;
      requires_manual_reset: number; arabic: string;
    }>("SELECT * FROM circuit_breakers WHERE cleared_at IS NULL").all()
      .map((r) => ({
        kind: r.kind, trippedAt: r.tripped_at, resumesAt: r.resumes_at,
        requiresManualReset: r.requires_manual_reset === 1, arabic: r.arabic,
      }))
      .filter((b) => b.requiresManualReset || b.resumesAt === null || now < b.resumesAt),
    [],
  );
}

// ── the universe, for the scanner ────────────────────────────────────────────

export interface SymbolRow {
  symbol: string;
  base: string;
  status: string;
  listedAt: number | null;
}

export function symbols(limit = 500): SymbolRow[] {
  return query(
    (db) => db.prepare<[number], { symbol: string; base: string; status: string; listed_at: number | null }>(
      "SELECT symbol, base, status, listed_at FROM symbols ORDER BY symbol LIMIT ?",
    ).all(limit).map((r) => ({
      symbol: r.symbol, base: r.base, status: r.status, listedAt: r.listed_at,
    })),
    [],
  );
}
