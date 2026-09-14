/**
 * Ingestion — how candles actually get into the database.
 *
 * Deliberate ordering, cheapest and most trustworthy first:
 *   1. ARCHIVE for everything older than the current month. It is the venue's
 *      own settled record, checksum-verified, and one request covers a month.
 *   2. REST to close the gap between the archive's end and now.
 *   3. WEBSOCKET (wired in Stage 5) keeps it current from there.
 *
 * Doing it the other way round — paging REST back through years — burns the
 * rate-limit budget for data that was available as a single zip.
 *
 * Everything written here is CLOSED candles only. The forming bar is dropped
 * at this boundary so nothing downstream has to remember to.
 */
import { BinanceVisionArchive, type ArchiveMarket } from "@/data/archive/binance-vision";
import type { MarketDataSource } from "@/data/market-source";
import { ArchiveRepo } from "@/storage/repositories/archive";
import { CandleRepo } from "@/storage/repositories/candles";
import { HealthRepo } from "@/storage/repositories/health";
import type { Db } from "@/storage/db";
import type { AppConfig } from "@/shared/config";
import { createLogger } from "@/shared/logger";
import { type Timeframe, dropUnclosed, lastClosedOpenTime, tfMillis } from "@/shared/time";
import type { Candle } from "@/core/types";

const log = createLogger("ingest");

export interface BackfillReport {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly archiveFiles: number;
  readonly archiveImported: number;
  readonly archiveMissing: number;
  readonly archiveFailed: number;
  readonly archiveUnverified: number;
  readonly restCandles: number;
  readonly totalStored: number;
  readonly first: number | null;
  readonly last: number | null;
  readonly gaps: number;
  readonly errors: string[];
}

export class Ingestor {
  private readonly candles: CandleRepo;
  private readonly archiveRepo: ArchiveRepo;
  private readonly health: HealthRepo;
  private readonly archive: BinanceVisionArchive;

  constructor(
    private readonly db: Db,
    private readonly cfg: AppConfig,
    private readonly source: MarketDataSource,
  ) {
    this.candles = new CandleRepo(db);
    this.archiveRepo = new ArchiveRepo(db);
    this.health = new HealthRepo(db);
    this.archive = new BinanceVisionArchive(cfg);
  }

  /**
   * Fill history for one series from `from` to the last closed candle.
   *
   * `onProgress` exists because a first run over years of 5m data is a long
   * operation and the operator deserves to see it move.
   */
  async backfill(
    symbol: string,
    timeframe: Timeframe,
    from: number,
    opts: {
      market?: ArchiveMarket;
      useArchive?: boolean;
      onProgress?: (done: number, total: number, label: string) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<BackfillReport> {
    const now = Date.now();
    const errors: string[] = [];
    const market = opts.market ?? "spot";
    const useArchive =
      (opts.useArchive ?? true) && this.source.capabilities.historicalArchive;

    let archiveFiles = 0;
    let archiveImported = 0;
    let archiveMissing = 0;
    let archiveFailed = 0;
    let archiveUnverified = 0;

    if (useArchive) {
      const targets = this.archive.planKlineTargets(symbol, timeframe, from, now, market);
      archiveFiles = targets.length;

      for (let i = 0; i < targets.length; i++) {
        if (opts.signal?.aborted) break;
        const t = targets[i];
        opts.onProgress?.(i, targets.length, `${t.periodKey}`);

        // Resumable: never re-download what is already imported, and never
        // retry a file the venue has already told us does not exist.
        if (this.archiveRepo.isImported(t)) {
          archiveImported++;
          continue;
        }
        if (this.archiveRepo.isKnownMissing(t)) {
          archiveMissing++;
          continue;
        }

        const r = await this.archive.fetch(t);
        if (!r.available) {
          const is404 = (r.detail ?? "").includes("404");
          this.archiveRepo.record(t, "", is404 ? "missing" : "failed", { error: r.detail });
          if (is404) archiveMissing++;
          else {
            archiveFailed++;
            errors.push(`${t.periodKey}: ${r.detail ?? r.reason}`);
          }
          continue;
        }

        const parsed = this.archive.parseKlineCsv(r.value.csv, timeframe);
        // The archive contains only settled bars, but the current day's daily
        // file can include the bar in progress. Drop it here regardless.
        const closed = dropUnclosed(parsed, timeframe, now);
        const written = this.candles.upsertMany(symbol, timeframe, closed, "archive");

        this.archiveRepo.record(t, r.value.url, "imported", {
          bytes: r.value.bytes,
          rowsImported: written,
          sha256: r.value.sha256,
          checksumOk: r.value.checksumOk,
        });
        archiveImported++;
        if (r.value.checksumOk !== true) archiveUnverified++;
      }
      opts.onProgress?.(targets.length, targets.length, "الأرشيف");
    }

    // ── close the tail with REST ───────────────────────────────────────────
    const coverage = this.candles.coverage(symbol, timeframe);
    const step = tfMillis(timeframe);
    const restFrom = coverage ? coverage.last + step : from;
    const lastClosed = lastClosedOpenTime(now, timeframe);

    let restCandles = 0;
    if (restFrom <= lastClosed && !opts.signal?.aborted) {
      const needed = Math.ceil((lastClosed - restFrom) / step) + 1;
      const r = await this.source.klines({
        symbol,
        timeframe,
        startTime: restFrom,
        limit: Math.min(needed, 5000),
        market: market === "um" ? "perp" : "spot",
      });
      this.health.record(`${this.source.id}:klines`, `${this.source.label} — الشموع`, r);

      if (r.available) {
        const closed = dropUnclosed(r.value, timeframe, now);
        restCandles = this.candles.upsertMany(symbol, timeframe, closed, "rest");
      } else {
        errors.push(`REST: ${r.detail ?? r.reason}`);
      }
    }

    const finalCoverage = this.candles.coverage(symbol, timeframe);
    const gaps = this.recordGaps(symbol, timeframe);

    return {
      symbol,
      timeframe,
      archiveFiles,
      archiveImported,
      archiveMissing,
      archiveFailed,
      archiveUnverified,
      restCandles,
      totalStored: finalCoverage?.count ?? 0,
      first: finalCoverage?.first ?? null,
      last: finalCoverage?.last ?? null,
      gaps: gaps.length,
      errors,
    };
  }

  /** Top up a series to the latest closed candle. The routine 24/7 path. */
  async sync(
    symbol: string,
    timeframe: Timeframe,
    opts: { market?: "spot" | "perp"; maxBars?: number } = {},
  ): Promise<{ written: number; error?: string }> {
    const now = Date.now();
    const step = tfMillis(timeframe);
    const lastClosed = lastClosedOpenTime(now, timeframe);
    const coverage = this.candles.coverage(symbol, timeframe);

    if (coverage && coverage.last >= lastClosed) return { written: 0 };

    // Overlap by one bar so a revised final bar is corrected rather than left.
    const startTime = coverage ? coverage.last : undefined;
    const needed = coverage
      ? Math.ceil((lastClosed - coverage.last) / step) + 1
      : (opts.maxBars ?? 500);

    const r = await this.source.klines({
      symbol,
      timeframe,
      startTime,
      limit: Math.min(needed, opts.maxBars ?? 1000),
      market: opts.market ?? "spot",
    });
    this.health.record(`${this.source.id}:klines`, `${this.source.label} — الشموع`, r);
    if (!r.available) return { written: 0, error: r.detail ?? r.reason };

    const closed = dropUnclosed(r.value, timeframe, now);
    return { written: this.candles.upsertMany(symbol, timeframe, closed, "rest") };
  }

  /** Detect gaps and persist them so the Health page can show real holes. */
  recordGaps(symbol: string, timeframe: Timeframe): { gapStart: number; gapEnd: number; missingBars: number }[] {
    const gaps = this.candles.findGaps(symbol, timeframe);
    const now = Date.now();

    const insert = this.db.prepare(
      `INSERT INTO data_gaps (symbol, timeframe, gap_start, gap_end, missing_bars, detected_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT (symbol, timeframe, gap_start) DO UPDATE SET
         gap_end = excluded.gap_end,
         missing_bars = excluded.missing_bars,
         resolved_at = NULL`,
    );
    const openStarts = new Set(gaps.map((g) => g.gapStart));

    const run = this.db.transaction(() => {
      for (const g of gaps) insert.run(symbol, timeframe, g.gapStart, g.gapEnd, g.missingBars, now);
      // Anything previously recorded that is no longer a gap has been filled.
      const previous = this.db
        .prepare<[string, string], { gap_start: number }>(
          `SELECT gap_start FROM data_gaps WHERE symbol = ? AND timeframe = ? AND resolved_at IS NULL`,
        )
        .all(symbol, timeframe);
      for (const p of previous) {
        if (!openStarts.has(p.gap_start)) {
          this.db
            .prepare(
              `UPDATE data_gaps SET resolved_at = ? WHERE symbol = ? AND timeframe = ? AND gap_start = ?`,
            )
            .run(now, symbol, timeframe, p.gap_start);
        }
      }
    });
    run();
    return gaps;
  }

  /**
   * Refresh the venue universe, and discover listing dates for symbols that
   * do not have one yet (bounded per run — it is one request per symbol).
   */
  async refreshUniverse(maxListingLookups = 20): Promise<{ symbols: number; listingDates: number }> {
    const { SymbolRepo } = await import("@/storage/repositories/symbols");
    const repo = new SymbolRepo(this.db);

    const r = await this.source.symbols("spot");
    this.health.record(`${this.source.id}:symbols`, `${this.source.label} — قائمة العملات`, r);
    if (!r.available) return { symbols: 0, listingDates: 0 };

    const count = repo.upsertMany(this.source.id, r.value);

    let listingDates = 0;
    const missing = repo.missingListingDate(this.source.id, "spot").slice(0, maxListingLookups);
    const withFirstCandle = this.source as MarketDataSource & {
      firstCandleTime?: (s: string) => Promise<{ available: boolean; value?: number }>;
    };
    if (typeof withFirstCandle.firstCandleTime === "function") {
      for (const sym of missing) {
        const f = await withFirstCandle.firstCandleTime(sym);
        if (f.available && typeof f.value === "number") {
          repo.setListedAt(this.source.id, "spot", sym, f.value);
          listingDates++;
        }
      }
    } else {
      // Venues without a cheap listing probe: fall back to the first stored bar.
      for (const sym of missing) {
        const cov = this.candles.coverage(sym, "1d");
        if (cov) {
          repo.setListedAt(this.source.id, "spot", sym, cov.first);
          listingDates++;
        }
      }
    }

    log.info("universe refreshed", { symbols: count, listingDates });
    return { symbols: count, listingDates };
  }

  /** Candles for analysis: closed only, ascending, from the database. */
  read(symbol: string, timeframe: Timeframe, limit: number, asOf = Date.now()): Candle[] {
    const lastClosed = lastClosedOpenTime(asOf, timeframe);
    return this.candles.latestAsOf(symbol, timeframe, lastClosed, limit);
  }
}
