/**
 * Candle persistence.
 *
 * Reads always return candles ascending by openTime with no duplicates, which
 * is the invariant every indicator depends on. Writes are idempotent: the same
 * bar arriving from REST, from the websocket, and later from the archive
 * converges on one row rather than triple-counting its volume.
 */
import type { Db } from "@/storage/db";
import type { Candle } from "@/core/types";
import { type Timeframe, candleGap, tfMillis } from "@/shared/time";

export type CandleOrigin = "rest" | "ws" | "archive";

interface Row {
  open_time: number;
  close_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quote_volume: number;
  trades: number;
  taker_buy_base: number;
  taker_buy_quote: number;
}

const toCandle = (r: Row): Candle => ({
  openTime: r.open_time,
  closeTime: r.close_time,
  open: r.open,
  high: r.high,
  low: r.low,
  close: r.close,
  volume: r.volume,
  quoteVolume: r.quote_volume,
  trades: r.trades,
  takerBuyBase: r.taker_buy_base,
  takerBuyQuote: r.taker_buy_quote,
});

const SELECT_COLS = `open_time, close_time, open, high, low, close, volume,
  quote_volume, trades, taker_buy_base, taker_buy_quote`;

export class CandleRepo {
  constructor(private readonly db: Db) {}

  /**
   * Insert or replace. The archive is authoritative: a bar that arrives from
   * `archive` overwrites a live-captured one, because the archive is the
   * venue's own settled record while a websocket bar can be a partial capture.
   * Anything else leaves an existing archive row alone.
   */
  upsertMany(
    symbol: string,
    timeframe: Timeframe,
    candles: readonly Candle[],
    origin: CandleOrigin = "rest",
  ): number {
    if (candles.length === 0) return 0;

    const stmt = this.db.prepare(`
      INSERT INTO candles (
        symbol, timeframe, open_time, close_time, open, high, low, close,
        volume, quote_volume, trades, taker_buy_base, taker_buy_quote, origin
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (symbol, timeframe, open_time) DO UPDATE SET
        close_time      = excluded.close_time,
        open            = excluded.open,
        high            = excluded.high,
        low             = excluded.low,
        close           = excluded.close,
        volume          = excluded.volume,
        quote_volume    = excluded.quote_volume,
        trades          = excluded.trades,
        taker_buy_base  = excluded.taker_buy_base,
        taker_buy_quote = excluded.taker_buy_quote,
        origin          = excluded.origin
      WHERE candles.origin != 'archive' OR excluded.origin = 'archive'
    `);

    const run = this.db.transaction((rows: readonly Candle[]) => {
      let n = 0;
      for (const c of rows) {
        stmt.run(
          symbol,
          timeframe,
          c.openTime,
          c.closeTime,
          c.open,
          c.high,
          c.low,
          c.close,
          c.volume,
          c.quoteVolume,
          c.trades,
          c.takerBuyBase,
          c.takerBuyQuote,
          origin,
        );
        n++;
      }
      return n;
    });
    return run(candles);
  }

  /** Candles with openTime in [from, to], ascending. */
  range(symbol: string, timeframe: Timeframe, from: number, to: number): Candle[] {
    return this.db
      .prepare<[string, string, number, number], Row>(
        `SELECT ${SELECT_COLS} FROM candles
         WHERE symbol = ? AND timeframe = ? AND open_time >= ? AND open_time <= ?
         ORDER BY open_time ASC`,
      )
      .all(symbol, timeframe, from, to)
      .map(toCandle);
  }

  /** The most recent `limit` candles, returned ASCENDING. */
  latest(symbol: string, timeframe: Timeframe, limit: number): Candle[] {
    const rows = this.db
      .prepare<[string, string, number], Row>(
        `SELECT ${SELECT_COLS} FROM candles
         WHERE symbol = ? AND timeframe = ?
         ORDER BY open_time DESC LIMIT ?`,
      )
      .all(symbol, timeframe, limit);
    return rows.reverse().map(toCandle);
  }

  /** Most recent candles at or before `asOf` — the backtest's only read path. */
  latestAsOf(symbol: string, timeframe: Timeframe, asOf: number, limit: number): Candle[] {
    const rows = this.db
      .prepare<[string, string, number, number], Row>(
        `SELECT ${SELECT_COLS} FROM candles
         WHERE symbol = ? AND timeframe = ? AND open_time <= ?
         ORDER BY open_time DESC LIMIT ?`,
      )
      .all(symbol, timeframe, asOf, limit);
    return rows.reverse().map(toCandle);
  }

  coverage(
    symbol: string,
    timeframe: Timeframe,
  ): { first: number; last: number; count: number } | null {
    const r = this.db
      .prepare<[string, string], { first: number | null; last: number | null; count: number }>(
        `SELECT MIN(open_time) AS first, MAX(open_time) AS last, COUNT(*) AS count
         FROM candles WHERE symbol = ? AND timeframe = ?`,
      )
      .get(symbol, timeframe);
    if (!r || r.count === 0 || r.first == null || r.last == null) return null;
    return { first: r.first, last: r.last, count: r.count };
  }

  /**
   * Holes in the stored series.
   *
   * A gap is not cosmetic: an indicator computed across one treats two
   * non-adjacent bars as consecutive, which quietly distorts every average and
   * every swing above it. The health page surfaces these so they get backfilled.
   */
  findGaps(
    symbol: string,
    timeframe: Timeframe,
  ): { gapStart: number; gapEnd: number; missingBars: number }[] {
    const times = this.db
      .prepare<[string, string], { open_time: number }>(
        `SELECT open_time FROM candles WHERE symbol = ? AND timeframe = ? ORDER BY open_time ASC`,
      )
      .all(symbol, timeframe)
      .map((r) => r.open_time);

    const step = tfMillis(timeframe);
    const out: { gapStart: number; gapEnd: number; missingBars: number }[] = [];
    for (let i = 1; i < times.length; i++) {
      const missing = candleGap(times[i - 1], times[i], timeframe);
      if (missing > 0) {
        out.push({ gapStart: times[i - 1] + step, gapEnd: times[i] - step, missingBars: missing });
      }
    }
    return out;
  }

  /** Distinct (symbol, timeframe) pairs we hold any history for. */
  storedSeries(): { symbol: string; timeframe: Timeframe }[] {
    return this.db
      .prepare<[], { symbol: string; timeframe: string }>(
        `SELECT DISTINCT symbol, timeframe FROM candles ORDER BY symbol, timeframe`,
      )
      .all()
      .map((r) => ({ symbol: r.symbol, timeframe: r.timeframe as Timeframe }));
  }

  count(): number {
    return (
      this.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM candles").get()?.n ?? 0
    );
  }
}
