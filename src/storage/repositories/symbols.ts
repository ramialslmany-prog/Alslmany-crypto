/**
 * The tradable universe, cached from the venue.
 *
 * `listed_at` matters more than it looks: discovering a symbol's true listing
 * date costs one extra request per symbol, and the eligibility filter needs it
 * for every candidate on every scan. Caching it here turns a recurring cost
 * into a one-off, and gives the backtester the point-in-time universe it needs
 * to avoid survivorship bias.
 */
import type { Db } from "@/storage/db";
import type { MarketType, SymbolInfo } from "@/core/types";

interface Row {
  symbol: string;
  native_symbol: string;
  base: string;
  quote: string;
  market: string;
  status: string;
  price_precision: number;
  qty_precision: number;
  min_notional: number;
  listed_at: number | null;
}

const toInfo = (r: Row): SymbolInfo => ({
  symbol: r.symbol,
  nativeSymbol: r.native_symbol,
  base: r.base,
  quote: r.quote,
  market: r.market as MarketType,
  status: r.status as SymbolInfo["status"],
  pricePrecision: r.price_precision,
  quantityPrecision: r.qty_precision,
  minNotional: r.min_notional,
  listedAt: r.listed_at ?? undefined,
});

const COLS = `symbol, native_symbol, base, quote, market, status,
  price_precision, qty_precision, min_notional, listed_at`;

export class SymbolRepo {
  constructor(private readonly db: Db) {}

  upsertMany(exchange: string, symbols: readonly SymbolInfo[]): number {
    if (symbols.length === 0) return 0;
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO symbols (
        symbol, market, exchange, native_symbol, base, quote, status,
        price_precision, qty_precision, min_notional, listed_at,
        first_seen_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (exchange, market, symbol) DO UPDATE SET
        native_symbol   = excluded.native_symbol,
        status          = excluded.status,
        price_precision = excluded.price_precision,
        qty_precision   = excluded.qty_precision,
        min_notional    = excluded.min_notional,
        -- Never overwrite a known listing date with NULL: the venue reports it
        -- inconsistently, and losing it would silently re-admit new listings.
        listed_at       = COALESCE(excluded.listed_at, symbols.listed_at),
        updated_at      = excluded.updated_at
    `);
    const run = this.db.transaction((rows: readonly SymbolInfo[]) => {
      for (const s of rows) {
        stmt.run(
          s.symbol,
          s.market,
          exchange,
          s.nativeSymbol,
          s.base,
          s.quote,
          s.status,
          s.pricePrecision,
          s.quantityPrecision,
          s.minNotional,
          s.listedAt ?? null,
          now,
          now,
        );
      }
      return rows.length;
    });
    return run(symbols);
  }

  /** Record a listing date discovered from the first available candle. */
  setListedAt(exchange: string, market: MarketType, symbol: string, listedAt: number): void {
    this.db
      .prepare(
        `UPDATE symbols SET listed_at = ?, updated_at = ?
         WHERE exchange = ? AND market = ? AND symbol = ?`,
      )
      .run(listedAt, Date.now(), exchange, market, symbol);
  }

  get(exchange: string, market: MarketType, symbol: string): SymbolInfo | null {
    const r = this.db
      .prepare<[string, string, string], Row>(
        `SELECT ${COLS} FROM symbols WHERE exchange = ? AND market = ? AND symbol = ?`,
      )
      .get(exchange, market, symbol);
    return r ? toInfo(r) : null;
  }

  all(exchange: string, market: MarketType = "spot"): SymbolInfo[] {
    return this.db
      .prepare<[string, string], Row>(
        `SELECT ${COLS} FROM symbols WHERE exchange = ? AND market = ? ORDER BY symbol`,
      )
      .all(exchange, market)
      .map(toInfo);
  }

  tradable(exchange: string, market: MarketType = "spot"): SymbolInfo[] {
    return this.all(exchange, market).filter((s) => s.status === "trading");
  }

  /** Symbols still missing a listing date — the backfill worklist. */
  missingListingDate(exchange: string, market: MarketType = "spot"): string[] {
    return this.db
      .prepare<[string, string], { symbol: string }>(
        `SELECT symbol FROM symbols
         WHERE exchange = ? AND market = ? AND listed_at IS NULL AND status = 'trading'
         ORDER BY symbol`,
      )
      .all(exchange, market)
      .map((r) => r.symbol);
  }
}
