/**
 * Derivatives history.
 *
 * Open interest, the long/short ratios and funding — stored so the backtest
 * reads the same stage 5 the live bot does. Without this half, stage 5 votes
 * in production and is "unavailable" in every backtest, and the backtest
 * quietly stops being a test of the strategy that actually trades.
 *
 * Every read is point-in-time (`asOf`), for the same reason the candle reads
 * are: a derivative reading published after the decision moment is a reading
 * from the future.
 */
import type { Db } from "@/storage/db";
import type { MetricRow } from "@/data/archive/binance-vision";
import type { FundingRate, LongShortRatio, OpenInterest } from "@/core/types";

export class DerivativesRepo {
  constructor(private readonly db: Db) {}

  upsertMetrics(symbol: string, rows: readonly MetricRow[]): number {
    if (rows.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT INTO derivatives (
        symbol, timestamp, open_interest, open_interest_value,
        top_account_ratio, top_position_ratio, account_ratio, taker_volume_ratio
      ) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT (symbol, timestamp) DO UPDATE SET
        open_interest = excluded.open_interest,
        open_interest_value = excluded.open_interest_value,
        top_account_ratio = excluded.top_account_ratio,
        top_position_ratio = excluded.top_position_ratio,
        account_ratio = excluded.account_ratio,
        taker_volume_ratio = excluded.taker_volume_ratio
    `);

    const insert = this.db.transaction((batch: readonly MetricRow[]) => {
      let n = 0;
      for (const r of batch) {
        stmt.run(
          symbol, r.timestamp, r.openInterest, r.openInterestValue,
          r.topTraderAccountRatio, r.topTraderPositionRatio,
          r.accountRatio, r.takerVolumeRatio,
        );
        n++;
      }
      return n;
    });

    return insert(rows);
  }

  upsertFunding(symbol: string, rows: readonly FundingRate[]): number {
    if (rows.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT INTO funding_rates (symbol, funding_time, rate, interval_hours)
      VALUES (?,?,?,?)
      ON CONFLICT (symbol, funding_time) DO UPDATE SET rate = excluded.rate
    `);
    const insert = this.db.transaction((batch: readonly FundingRate[]) => {
      let n = 0;
      for (const r of batch) {
        stmt.run(symbol, r.fundingTime, r.rate, r.intervalHours);
        n++;
      }
      return n;
    });
    return insert(rows);
  }

  /** Open-interest series as the stage expects it, up to `asOf`. */
  openInterest(symbol: string, asOf: number, limit: number): OpenInterest[] {
    const rows = this.db.prepare<[string, number, number], {
      timestamp: number; open_interest: number; open_interest_value: number;
    }>(`
      SELECT timestamp, open_interest, open_interest_value FROM derivatives
      WHERE symbol = ? AND timestamp <= ?
      ORDER BY timestamp DESC LIMIT ?
    `).all(symbol, asOf, limit);

    return rows.reverse().map((r) => ({
      symbol,
      openInterest: r.open_interest,
      openInterestValue: r.open_interest_value,
      timestamp: r.timestamp,
    }));
  }

  /**
   * Long/short series, up to `asOf`.
   *
   * Built from the ACCOUNT ratio — the share of accounts positioned each way
   * — because that is what the crowding veto is about. The position-size
   * ratio would say something different and is kept separately.
   */
  longShort(symbol: string, asOf: number, limit: number): LongShortRatio[] {
    const rows = this.db.prepare<[string, number, number], {
      timestamp: number; account_ratio: number | null;
    }>(`
      SELECT timestamp, account_ratio FROM derivatives
      WHERE symbol = ? AND timestamp <= ? AND account_ratio IS NOT NULL
      ORDER BY timestamp DESC LIMIT ?
    `).all(symbol, asOf, limit);

    return rows.reverse().map((r) => {
      const ratio = r.account_ratio ?? 1;
      // ratio = long/short, so long share = ratio / (1 + ratio).
      const longPct = (ratio / (1 + ratio)) * 100;
      return {
        symbol,
        longAccountPct: longPct,
        shortAccountPct: 100 - longPct,
        ratio,
        timestamp: r.timestamp,
      };
    });
  }

  funding(symbol: string, asOf: number, limit: number): FundingRate[] {
    const rows = this.db.prepare<[string, number, number], {
      funding_time: number; rate: number; interval_hours: number;
    }>(`
      SELECT funding_time, rate, interval_hours FROM funding_rates
      WHERE symbol = ? AND funding_time <= ?
      ORDER BY funding_time DESC LIMIT ?
    `).all(symbol, asOf, limit);

    return rows.reverse().map((r) => ({
      symbol,
      rate: r.rate,
      fundingTime: r.funding_time,
      intervalHours: r.interval_hours,
    }));
  }

  coverage(symbol: string): { rows: number; first: number; last: number } | null {
    const r = this.db.prepare<[string], { n: number; first: number | null; last: number | null }>(
      "SELECT COUNT(*) AS n, MIN(timestamp) AS first, MAX(timestamp) AS last FROM derivatives WHERE symbol = ?",
    ).get(symbol);
    return r && r.n > 0 && r.first !== null && r.last !== null
      ? { rows: r.n, first: r.first, last: r.last }
      : null;
  }
}
