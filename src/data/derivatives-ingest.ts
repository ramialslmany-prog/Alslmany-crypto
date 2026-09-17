/**
 * Building the derivatives history.
 *
 * Binance publishes one metrics file per symbol per DAY for USD-M futures —
 * open interest and the long/short ratios at five-minute resolution. That is
 * the only free archive of what stage 5 reads live, and importing it is what
 * keeps the backtest a test of the strategy that actually trades rather than
 * of a crippled version of it.
 *
 * Funding comes from the REST endpoint instead: it settles every eight hours,
 * so the whole history is a few hundred rows and there is no archive to pull.
 */
import { BinanceVisionArchive, parseLiquidations, parseMetrics } from "@/data/archive/binance-vision";
import { DerivativesRepo } from "@/storage/repositories/derivatives";
import { HealthRepo } from "@/storage/repositories/health";
import type { MarketDataSource } from "@/data/market-source";
import type { AppConfig } from "@/shared/config";
import type { Db } from "@/storage/db";
import { createLogger } from "@/shared/logger";
import { dayKeysBetween } from "@/shared/time";

const log = createLogger("derivatives");

/**
 * Stop probing the liquidation archive after this many consecutive absences
 * with nothing found yet.
 *
 * Binance does not publish a liquidation snapshot for every symbol or every
 * era, and the first run of this code walked 1,096 days of 404s per symbol —
 * roughly half an hour each — to conclude what the first thirty already had.
 */
const GIVE_UP_AFTER = 30;

/** How many archive files to request at once. */
const FETCH_WINDOW = 6;

export interface DerivativesReport {
  readonly symbol: string;
  readonly days: number;
  readonly imported: number;
  readonly missing: number;
  readonly failed: number;
  readonly fundingRows: number;
  readonly liquidationRows: number;
  /** Days whose liquidation file the venue does not publish. */
  readonly liquidationMissing: number;
  /** Days whose file downloaded but yielded no parseable row. */
  readonly liquidationEmpty: number;
  /** True when the pass gave up early — see GIVE_UP_AFTER. */
  readonly liquidationAbandoned: boolean;
  readonly first: number | null;
  readonly last: number | null;
  readonly errors: readonly string[];
}

export class DerivativesIngestor {
  private readonly repo: DerivativesRepo;
  private readonly health: HealthRepo;
  private readonly archive: BinanceVisionArchive;

  constructor(
    db: Db,
    private readonly cfg: AppConfig,
    private readonly source: MarketDataSource,
  ) {
    this.repo = new DerivativesRepo(db);
    this.health = new HealthRepo(db);
    this.archive = new BinanceVisionArchive(cfg);
  }

  async backfill(
    symbol: string,
    from: number,
    to: number = Date.now(),
    onProgress?: (done: number, total: number, key: string) => void,
  ): Promise<DerivativesReport> {
    const days = dayKeysBetween(from, to);
    const errors: string[] = [];
    let imported = 0;
    let missing = 0;
    let failed = 0;

    // Fetched a few days at a time rather than one after another. Three years
    // is 1,096 files, and the first version spent close to an hour per symbol
    // waiting on latency rather than on bandwidth. The window is deliberately
    // small: the archive is a courtesy, not a service to hammer, and the
    // shared rate limiter still governs the host.
    let done = 0;
    for (let i = 0; i < days.length; i += FETCH_WINDOW) {
      const batch = days.slice(i, i + FETCH_WINDOW);
      const results = await Promise.all(batch.map((key) => this.archive.fetch({
        symbol,
        dataType: "metrics",
        period: "daily",
        periodKey: key,
        // Metrics exist for USD-M futures only. A spot-only symbol simply has
        // no file, which the manifest records as missing rather than failed.
        market: "um",
      })));

      for (const [j, r] of results.entries()) {
        done++;
        onProgress?.(done, days.length, batch[j]);

        if (!r.available) {
          // A 404 is expected for days before the symbol listed on futures,
          // and for the current day. Only a transport failure is an error.
          if (r.reason === "http_error" || r.reason === "unsupported_symbol") missing++;
          else {
            failed++;
            if (errors.length < 5) errors.push(`${batch[j]}: ${r.detail ?? r.reason}`);
          }
          continue;
        }

        imported += this.repo.upsertMetrics(symbol, parseMetrics(r.value.csv));
      }
    }

    // ── liquidations ──────────────────────────────────────────────────────
    //
    // A separate pass rather than a second data type in the loop above: the
    // two archives have different start dates per symbol, and interleaving
    // them would make one file's 404 look like the other's.
    //
    // Two things this pass learned the hard way. It COUNTS its misses — the
    // first version silently skipped every absent day, so a wrong path and a
    // symbol with no futures history produced the identical output of zero,
    // and there was no way to tell which. And it GIVES UP: 1,096 sequential
    // fetches that all 404 is an hour of somebody's evening spent proving
    // something the first thirty already proved.
    let liquidationRows = 0;
    let liquidationMissing = 0;
    let liquidationEmpty = 0;
    let consecutiveMisses = 0;
    let liquidationAbandoned = false;

    for (const [i, key] of days.entries()) {
      if (consecutiveMisses >= GIVE_UP_AFTER && liquidationRows === 0) {
        liquidationAbandoned = true;
        log.warn("liquidation archive abandoned — nothing published for this symbol", {
          symbol, checkedDays: i, consecutiveMisses,
        });
        break;
      }

      onProgress?.(i + 1, days.length, `liq ${key}`);
      const r = await this.archive.fetch({
        symbol,
        dataType: "liquidationSnapshot",
        period: "daily",
        periodKey: key,
        market: "um",
      });

      if (!r.available) {
        liquidationMissing++;
        consecutiveMisses++;
        continue;
      }

      const parsed = parseLiquidations(r.value.csv);
      if (parsed.length === 0) {
        // The file EXISTS and parsed to nothing. That is a parser problem or a
        // format change, not an absent day, and it is worth telling apart.
        liquidationEmpty++;
        if (liquidationEmpty <= 3 && errors.length < 8) {
          errors.push(`liq ${key}: file present, 0 rows parsed — first line: ${r.value.csv.split("\n")[0]?.slice(0, 120)}`);
        }
      }
      consecutiveMisses = 0;
      liquidationRows += this.repo.upsertLiquidations(symbol, parsed);
    }

    // ── funding, from REST ─────────────────────────────────────────────────
    let fundingRows = 0;
    const funding = await this.source.fundingHistory(symbol, 1000);
    this.health.record(`${this.source.id}:fundingHistory`, `${this.source.label} — تاريخ التمويل`, funding);
    if (funding.available) {
      fundingRows = this.repo.upsertFunding(symbol, funding.value);
    } else if (errors.length < 5) {
      errors.push(`funding: ${funding.detail ?? funding.reason}`);
    }

    const coverage = this.repo.coverage(symbol);
    log.info("derivatives backfilled", { symbol, imported, missing, failed, fundingRows, liquidationRows });

    return {
      symbol,
      days: days.length,
      imported,
      missing,
      failed,
      fundingRows,
      liquidationRows,
      liquidationMissing,
      liquidationEmpty,
      liquidationAbandoned,
      first: coverage?.first ?? null,
      last: coverage?.last ?? null,
      errors,
    };
  }
}
