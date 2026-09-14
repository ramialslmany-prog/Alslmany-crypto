/**
 * Manifest of every archive file we tried to obtain.
 *
 * This table is what turns "I have history from 2019" from a belief into a
 * verifiable claim: each row records the URL, the SHA-256, whether it matched
 * the published checksum, and how many bars it contributed. A backtest run on
 * history with unverified or missing months should say so, and this is where
 * that answer comes from.
 */
import type { Db } from "@/storage/db";
import type { ArchiveTarget } from "@/data/archive/binance-vision";

export type ArchiveStatus = "pending" | "downloaded" | "imported" | "missing" | "failed";

export interface ArchiveRecord {
  readonly symbol: string;
  readonly dataType: string;
  readonly timeframe: string | null;
  readonly period: string;
  readonly periodKey: string;
  readonly url: string;
  readonly status: ArchiveStatus;
  readonly bytes: number | null;
  readonly rowsImported: number | null;
  readonly sha256: string | null;
  readonly checksumOk: boolean | null;
  readonly error: string | null;
  readonly completedAt: number | null;
}

interface Row {
  symbol: string;
  data_type: string;
  timeframe: string | null;
  period: string;
  period_key: string;
  url: string;
  status: string;
  bytes: number | null;
  rows_imported: number | null;
  sha256: string | null;
  checksum_ok: number | null;
  error: string | null;
  completed_at: number | null;
}

const toRecord = (r: Row): ArchiveRecord => ({
  symbol: r.symbol,
  dataType: r.data_type,
  timeframe: r.timeframe,
  period: r.period,
  periodKey: r.period_key,
  url: r.url,
  status: r.status as ArchiveStatus,
  bytes: r.bytes,
  rowsImported: r.rows_imported,
  sha256: r.sha256,
  checksumOk: r.checksum_ok === null ? null : r.checksum_ok === 1,
  error: r.error,
  completedAt: r.completed_at,
});

export class ArchiveRepo {
  constructor(private readonly db: Db) {}

  /** Has this exact file already been imported? Drives resumable downloads. */
  isImported(t: ArchiveTarget): boolean {
    const r = this.db
      .prepare<[string, string, string | null, string, string], { status: string }>(
        `SELECT status FROM archive_files
         WHERE symbol = ? AND data_type = ? AND timeframe IS ? AND period = ? AND period_key = ?`,
      )
      .get(t.symbol, t.dataType, t.timeframe ?? null, t.period, t.periodKey);
    return r?.status === "imported";
  }

  /**
   * A file the venue does not publish (404) is recorded as `missing` and never
   * retried — most 404s are permanent (the symbol did not exist that month),
   * and retrying them every run wastes the whole download budget.
   */
  isKnownMissing(t: ArchiveTarget): boolean {
    const r = this.db
      .prepare<[string, string, string | null, string, string], { status: string }>(
        `SELECT status FROM archive_files
         WHERE symbol = ? AND data_type = ? AND timeframe IS ? AND period = ? AND period_key = ?`,
      )
      .get(t.symbol, t.dataType, t.timeframe ?? null, t.period, t.periodKey);
    return r?.status === "missing";
  }

  record(
    t: ArchiveTarget,
    url: string,
    status: ArchiveStatus,
    extra: {
      bytes?: number;
      rowsImported?: number;
      sha256?: string;
      checksumOk?: boolean | null;
      error?: string;
    } = {},
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO archive_files
           (symbol, data_type, timeframe, period, period_key, url, status,
            bytes, rows_imported, sha256, checksum_ok, error, attempted_at, completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (symbol, data_type, timeframe, period, period_key) DO UPDATE SET
           status        = excluded.status,
           bytes         = COALESCE(excluded.bytes, archive_files.bytes),
           rows_imported = COALESCE(excluded.rows_imported, archive_files.rows_imported),
           sha256        = COALESCE(excluded.sha256, archive_files.sha256),
           checksum_ok   = excluded.checksum_ok,
           error         = excluded.error,
           attempted_at  = excluded.attempted_at,
           completed_at  = excluded.completed_at`,
      )
      .run(
        t.symbol,
        t.dataType,
        t.timeframe ?? null,
        t.period,
        t.periodKey,
        url,
        status,
        extra.bytes ?? null,
        extra.rowsImported ?? null,
        extra.sha256 ?? null,
        extra.checksumOk === undefined ? null : extra.checksumOk === null ? null : extra.checksumOk ? 1 : 0,
        extra.error ?? null,
        now,
        status === "imported" || status === "missing" ? now : null,
      );
  }

  forSymbol(symbol: string, timeframe?: string): ArchiveRecord[] {
    const rows = timeframe
      ? this.db
          .prepare<[string, string], Row>(
            `SELECT * FROM archive_files WHERE symbol = ? AND timeframe = ? ORDER BY period_key`,
          )
          .all(symbol, timeframe)
      : this.db
          .prepare<[string], Row>(`SELECT * FROM archive_files WHERE symbol = ? ORDER BY period_key`)
          .all(symbol);
    return rows.map(toRecord);
  }

  /** Counts by status — the Health page's archive summary. */
  summary(): { status: string; count: number; rows: number }[] {
    return this.db
      .prepare<[], { status: string; count: number; rows: number }>(
        `SELECT status, COUNT(*) AS count, COALESCE(SUM(rows_imported), 0) AS rows
         FROM archive_files GROUP BY status ORDER BY status`,
      )
      .all();
  }

  /** Imported files whose checksum could NOT be verified — an honesty flag. */
  unverified(): ArchiveRecord[] {
    return this.db
      .prepare<[], Row>(
        `SELECT * FROM archive_files WHERE status = 'imported' AND checksum_ok IS NOT 1
         ORDER BY symbol, period_key`,
      )
      .all()
      .map(toRecord);
  }
}
