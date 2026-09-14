/**
 * One normalizer for Binance kline rows, shared by the REST adapter and the
 * Binance Vision archive parser — because they emit the SAME 12 columns.
 *
 * Keeping a single implementation is not a tidiness point: if live klines and
 * archived klines were parsed differently, a backtest would be validating a
 * strategy against data the live bot never sees. That is the classic silent
 * backtest/live divergence, and it is designed out here.
 *
 * Column order (Binance, both REST and CSV):
 *   0 openTime · 1 open · 2 high · 3 low · 4 close · 5 volume
 *   6 closeTime · 7 quoteVolume · 8 trades
 *   9 takerBuyBase · 10 takerBuyQuote · 11 ignore
 */
import type { Candle } from "@/core/types";
import { type Timeframe, tfMillis } from "@/shared/time";

const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
};

/**
 * Binance reports closeTime as `openTime + interval - 1ms`. We store the
 * EXCLUSIVE boundary (`openTime + interval`) so candle arithmetic elsewhere is
 * plain addition and half-open intervals [open, close) compose without
 * off-by-one-millisecond bugs.
 */
export function binanceKlineRow(row: readonly unknown[], tf: Timeframe): Candle | null {
  if (!Array.isArray(row) || row.length < 11) return null;

  const openTime = num(row[0]);
  const open = num(row[1]);
  const high = num(row[2]);
  const low = num(row[3]);
  const close = num(row[4]);
  const volume = num(row[5]);
  const quoteVolume = num(row[7]);
  const trades = num(row[8]);
  const takerBuyBase = num(row[9]);
  const takerBuyQuote = num(row[10]);

  if (![openTime, open, high, low, close, volume].every(Number.isFinite)) return null;
  // A bar whose high is below its low, or with a non-positive price, is corrupt.
  if (high < low || open <= 0 || close <= 0 || low <= 0) return null;

  return {
    openTime,
    closeTime: openTime + tfMillis(tf),
    open,
    high,
    low,
    close,
    volume,
    quoteVolume: Number.isFinite(quoteVolume) ? quoteVolume : volume * close,
    trades: Number.isFinite(trades) ? trades : 0,
    takerBuyBase: Number.isFinite(takerBuyBase) ? takerBuyBase : 0,
    takerBuyQuote: Number.isFinite(takerBuyQuote) ? takerBuyQuote : 0,
  };
}

/**
 * Parse many rows, dropping corrupt ones, then sort and de-duplicate by
 * openTime. Exchanges occasionally return overlapping pages; a duplicated bar
 * would double-count volume in every downstream aggregate.
 */
export function binanceKlineRows(rows: readonly unknown[], tf: Timeframe): Candle[] {
  const out: Candle[] = [];
  for (const r of rows) {
    const c = binanceKlineRow(r as unknown[], tf);
    if (c) out.push(c);
  }
  return dedupeSorted(out);
}

/** Sort ascending by openTime and keep the LAST value for duplicate opens. */
export function dedupeSorted(candles: Candle[]): Candle[] {
  candles.sort((a, b) => a.openTime - b.openTime);
  const out: Candle[] = [];
  for (const c of candles) {
    const prev = out[out.length - 1];
    if (prev && prev.openTime === c.openTime) out[out.length - 1] = c;
    else out.push(c);
  }
  return out;
}
