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
];
