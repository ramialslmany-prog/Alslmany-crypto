/**
 * Database schema, as ordered migrations.
 *
 * SQLite is the right call here and not a compromise: this is a single-writer
 * workload (one 24/7 worker) with a read-heavy site alongside it. In WAL mode
 * readers never block the writer, there is no server to keep alive, and the
 * whole state of the bot is one file the operator can copy, inspect, or back
 * up. Postgres would add an operational dependency for no gain at this size.
 *
 * Migrations are append-only. Never edit a shipped migration — add a new one.
 */

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "candles_symbols_health",
    sql: `
-- ── the venue universe, refreshed periodically ───────────────────────────
CREATE TABLE IF NOT EXISTS symbols (
  symbol            TEXT    NOT NULL,
  market            TEXT    NOT NULL CHECK (market IN ('spot','perp')),
  exchange          TEXT    NOT NULL,
  native_symbol     TEXT    NOT NULL,
  base              TEXT    NOT NULL,
  quote             TEXT    NOT NULL,
  status            TEXT    NOT NULL,
  price_precision   INTEGER NOT NULL,
  qty_precision     INTEGER NOT NULL,
  min_notional      REAL    NOT NULL DEFAULT 0,
  -- First candle we could obtain. Drives the "listed < 90 days" rejection,
  -- and is expensive to discover, so it is cached here rather than refetched.
  listed_at         INTEGER,
  first_seen_at     INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (exchange, market, symbol)
);

-- ── OHLCV ────────────────────────────────────────────────────────────────
-- WITHOUT ROWID: the primary key IS the access pattern (one symbol, one
-- timeframe, a time range), so storing rows in PK order removes a whole
-- index and keeps range scans sequential. Rows are small and fixed-shape.
CREATE TABLE IF NOT EXISTS candles (
  symbol          TEXT    NOT NULL,
  timeframe       TEXT    NOT NULL,
  open_time       INTEGER NOT NULL,
  close_time      INTEGER NOT NULL,
  open            REAL    NOT NULL,
  high            REAL    NOT NULL,
  low             REAL    NOT NULL,
  close           REAL    NOT NULL,
  volume          REAL    NOT NULL,
  quote_volume    REAL    NOT NULL,
  trades          INTEGER NOT NULL DEFAULT 0,
  taker_buy_base  REAL    NOT NULL DEFAULT 0,
  taker_buy_quote REAL    NOT NULL DEFAULT 0,
  -- 'rest' | 'ws' | 'archive'. Lets the health page prove which bars came
  -- from the immutable archive versus a live socket.
  origin          TEXT    NOT NULL DEFAULT 'rest',
  PRIMARY KEY (symbol, timeframe, open_time)
) WITHOUT ROWID;

-- ── historical archive manifest (data.binance.vision) ────────────────────
CREATE TABLE IF NOT EXISTS archive_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT    NOT NULL,
  data_type     TEXT    NOT NULL,  -- 'klines' | 'aggTrades'
  timeframe     TEXT,              -- null for trade archives
  period        TEXT    NOT NULL,  -- 'monthly' | 'daily'
  period_key    TEXT    NOT NULL,  -- 'YYYY-MM' or 'YYYY-MM-DD'
  url           TEXT    NOT NULL,
  -- 'pending' | 'downloaded' | 'imported' | 'missing' | 'failed'
  status        TEXT    NOT NULL,
  bytes         INTEGER,
  rows_imported INTEGER,
  -- Binance publishes a .CHECKSUM next to every file; we verify and record it
  -- so a truncated download can never masquerade as real history.
  sha256        TEXT,
  checksum_ok   INTEGER,
  error         TEXT,
  attempted_at  INTEGER,
  completed_at  INTEGER,
  UNIQUE (symbol, data_type, timeframe, period, period_key)
);

-- ── per-source health, for the Health page ───────────────────────────────
CREATE TABLE IF NOT EXISTS provider_health (
  provider       TEXT PRIMARY KEY,
  label          TEXT    NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_ok_at     INTEGER,
  last_fail_at   INTEGER,
  last_reason    TEXT,
  last_detail    TEXT,
  last_latency_ms INTEGER,
  ok_count       INTEGER NOT NULL DEFAULT 0,
  fail_count     INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);

-- ── detected holes in the candle history ─────────────────────────────────
CREATE TABLE IF NOT EXISTS data_gaps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol       TEXT    NOT NULL,
  timeframe    TEXT    NOT NULL,
  gap_start    INTEGER NOT NULL,
  gap_end      INTEGER NOT NULL,
  missing_bars INTEGER NOT NULL,
  detected_at  INTEGER NOT NULL,
  resolved_at  INTEGER,
  UNIQUE (symbol, timeframe, gap_start)
);

CREATE INDEX IF NOT EXISTS idx_gaps_open ON data_gaps (symbol, timeframe) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_archive_status ON archive_files (status, symbol);
`,
  },
  {
    id: 2,
    name: "recommendations_immutable",
    sql: `
-- ── recommendations: APPEND ONLY ─────────────────────────────────────────
-- Immutability is enforced by the DATABASE, not by convention. The triggers
-- below make UPDATE and DELETE raise an error, so no future code path — not
-- a bug, not a well-meaning "fix", not a migration written in a hurry — can
-- quietly revise a losing call. A bot that can edit its own history has no
-- track record, and the track record is the only thing that makes the rest
-- of this worth anything.
CREATE TABLE IF NOT EXISTS recommendations (
  id                TEXT PRIMARY KEY,
  symbol            TEXT    NOT NULL,
  direction         TEXT    NOT NULL CHECK (direction IN ('long','short')),
  setup             TEXT    NOT NULL,
  regime            TEXT    NOT NULL,
  timeframe         TEXT    NOT NULL,
  exchange          TEXT    NOT NULL,
  generated_at      INTEGER NOT NULL,
  as_of_candle      INTEGER NOT NULL,

  entry_low         REAL    NOT NULL,
  entry_high        REAL    NOT NULL,
  entry_mid         REAL    NOT NULL,
  stop              REAL    NOT NULL,
  stop_basis        TEXT    NOT NULL,
  -- Targets as JSON: they are read as a unit and never queried individually.
  targets_json      TEXT    NOT NULL,

  risk_reward       REAL    NOT NULL,
  position_size     REAL    NOT NULL,
  position_notional REAL    NOT NULL,
  risk_amount       REAL    NOT NULL,
  risk_percent      REAL    NOT NULL,

  confidence        REAL    NOT NULL,
  final_score       REAL    NOT NULL,
  confidence_components_json TEXT NOT NULL,
  invalidation_json TEXT    NOT NULL,
  expires_at        INTEGER NOT NULL,

  report            TEXT    NOT NULL,
  -- SHA-256 over the defining fields; a row that no longer hashes to this
  -- was altered outside the append-only path.
  integrity_hash    TEXT    NOT NULL,

  -- The full pipeline run that produced it, for the audit page.
  pipeline_json     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rec_symbol ON recommendations (symbol, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_rec_generated ON recommendations (generated_at DESC);

CREATE TRIGGER IF NOT EXISTS recommendations_no_update
BEFORE UPDATE ON recommendations
BEGIN
  SELECT RAISE(ABORT, 'recommendations are immutable: record a recommendation_events row instead');
END;

CREATE TRIGGER IF NOT EXISTS recommendations_no_delete
BEFORE DELETE ON recommendations
BEGIN
  SELECT RAISE(ABORT, 'recommendations are immutable: they are never deleted');
END;

-- ── every subsequent fact about a recommendation ─────────────────────────
-- Also append-only. The current state of a trade is DERIVED by replaying its
-- events, never by mutating a status column — which is what makes the
-- history reconstructible and the backtest reproducible.
CREATE TABLE IF NOT EXISTS recommendation_events (
  id                TEXT PRIMARY KEY,
  recommendation_id TEXT    NOT NULL REFERENCES recommendations(id),
  kind              TEXT    NOT NULL,
  at                INTEGER NOT NULL,
  candle_time       INTEGER,
  price             REAL,
  payload_json      TEXT    NOT NULL DEFAULT '{}',
  arabic            TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_rec ON recommendation_events (recommendation_id, at);
CREATE INDEX IF NOT EXISTS idx_events_kind ON recommendation_events (kind, at DESC);

CREATE TRIGGER IF NOT EXISTS recommendation_events_no_update
BEFORE UPDATE ON recommendation_events
BEGIN
  SELECT RAISE(ABORT, 'recommendation events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS recommendation_events_no_delete
BEFORE DELETE ON recommendation_events
BEGIN
  SELECT RAISE(ABORT, 'recommendation events are immutable');
END;

-- ── rejected analyses: the bad shown as plainly as the good ──────────────
-- Section 7 rule 4. Every coin analysed that produced NO recommendation is
-- recorded with the stage it died at and exactly why.
CREATE TABLE IF NOT EXISTS rejected_analyses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol         TEXT    NOT NULL,
  timeframe      TEXT    NOT NULL,
  analyzed_at    INTEGER NOT NULL,
  failed_stage   TEXT    NOT NULL,
  failed_number  INTEGER NOT NULL,
  reason         TEXT    NOT NULL,
  final_score    REAL,
  vetoes_json    TEXT    NOT NULL DEFAULT '[]',
  pipeline_json  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rejected_time ON rejected_analyses (analyzed_at DESC);
CREATE INDEX IF NOT EXISTS idx_rejected_stage ON rejected_analyses (failed_stage, analyzed_at DESC);
CREATE INDEX IF NOT EXISTS idx_rejected_symbol ON rejected_analyses (symbol, analyzed_at DESC);
`,
  },
];
