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
import { BinanceVisionArchive, parseMetrics } from "@/data/archive/binance-vision";
import { DerivativesRepo } from "@/storage/repositories/derivatives";
import { HealthRepo } from "@/storage/repositories/health";
import type { MarketDataSource } from "@/data/market-source";
import type { AppConfig } from "@/shared/config";
import type { Db } from "@/storage/db";
import { createLogger } from "@/shared/logger";
import { dayKeysBetween } from "@/shared/time";

const log = createLogger("derivatives");

export interface DerivativesReport {
  readonly symbol: string;
  readonly days: number;
  readonly imported: number;
  readonly missing: number;
  readonly failed: number;
  readonly fundingRows: number;
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

    for (const [i, key] of days.entries()) {
      onProgress?.(i + 1, days.length, key);

      const r = await this.archive.fetch({
        symbol,
        dataType: "metrics",
        period: "daily",
        periodKey: key,
        // Metrics exist for USD-M futures only. A spot-only symbol simply has
        // no file, which the manifest records as missing rather than failed.
        market: "um",
      });

      if (!r.available) {
        // A 404 is expected for days before the symbol listed on futures, and
        // for the current day. Only a real transport failure is an error.
        if (r.reason === "http_error" || r.reason === "unsupported_symbol") missing++;
        else {
          failed++;
          if (errors.length < 5) errors.push(`${key}: ${r.detail ?? r.reason}`);
        }
        continue;
      }

      imported += this.repo.upsertMetrics(symbol, parseMetrics(r.value.csv));
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
    log.info("derivatives backfilled", { symbol, imported, missing, failed, fundingRows });

    return {
      symbol,
      days: days.length,
      imported,
      missing,
      failed,
      fundingRows,
      first: coverage?.first ?? null,
      last: coverage?.last ?? null,
      errors,
    };
  }
}
