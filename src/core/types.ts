/**
 * Domain types. Pure data, no IO, no provider-specific shapes — every adapter
 * normalizes into these so the analysis pipeline never learns which venue it
 * is reading. Swapping Binance for Bybit must be invisible above this file.
 */
import type { Timeframe } from "@/shared/time";

export type { Timeframe };

/** A single OHLCV bar. `openTime` is the canonical identity of a candle. */
export interface Candle {
  /** Epoch ms, UTC, aligned to the timeframe grid. */
  readonly openTime: number;
  /** Exclusive: openTime + timeframe length. Stored to make gaps auditable. */
  readonly closeTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Base-asset volume. */
  readonly volume: number;
  /** Quote-asset volume (USDT) — the honest liquidity measure. */
  readonly quoteVolume: number;
  readonly trades: number;
  /** Base volume bought by the aggressor (taker buy). Enables true delta. */
  readonly takerBuyBase: number;
  readonly takerBuyQuote: number;
}

/** A closed-candle series, tagged so nothing can mix timeframes by accident. */
export interface CandleSeries {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly candles: readonly Candle[];
  /** Venue the candles came from, e.g. "binance:spot". */
  readonly source: string;
}

export type MarketType = "spot" | "perp";

/**
 * Venue metadata needed by the eligibility filter (Stage 1 of the pipeline).
 *
 * `symbol` is the CANONICAL id (BASE+QUOTE, uppercase, e.g. "BTCUSDT") and is
 * what the database, the config watchlist and the UI use everywhere. Venues
 * that spell it differently (OKX uses "BTC-USDT") translate inside their own
 * adapter, so switching venues never rewrites stored history.
 */
export interface SymbolInfo {
  readonly symbol: string; // canonical, e.g. "BTCUSDT"
  /** How this venue spells it, when different. */
  readonly nativeSymbol: string;
  readonly base: string; // "BTC"
  readonly quote: string; // "USDT"
  readonly market: MarketType;
  readonly status: "trading" | "halted" | "delisted";
  /** Exchange tick size / step size — needed for realistic order placement. */
  readonly pricePrecision: number;
  readonly quantityPrecision: number;
  readonly minNotional: number;
  /** First candle we can obtain. Drives the "listed < 90 days" rejection. */
  readonly listedAt?: number;
}

export interface Ticker24h {
  readonly symbol: string;
  readonly lastPrice: number;
  readonly quoteVolume: number;
  readonly priceChangePct: number;
  readonly highPrice: number;
  readonly lowPrice: number;
  /** Best bid/ask — the spread filter needs these, not the last trade. */
  readonly bidPrice: number;
  readonly askPrice: number;
}

export interface OrderBookLevel {
  readonly price: number;
  readonly quantity: number;
}

export interface OrderBook {
  readonly symbol: string;
  readonly bids: readonly OrderBookLevel[]; // descending price
  readonly asks: readonly OrderBookLevel[]; // ascending price
  readonly timestamp: number;
  /** Venue sequence id — lets the WS diff stream verify it did not skip. */
  readonly lastUpdateId: number;
}

/** One executed trade, aggressor-tagged. `buyerIsMaker` true ⇒ a sell hit the bid. */
export interface Trade {
  readonly id: number;
  readonly price: number;
  readonly quantity: number;
  readonly quoteQuantity: number;
  readonly timestamp: number;
  readonly buyerIsMaker: boolean;
}

export interface FundingRate {
  readonly symbol: string;
  readonly rate: number; // per interval, e.g. 0.0001 = 0.01%
  readonly fundingTime: number;
  readonly intervalHours: number;
}

export interface OpenInterest {
  readonly symbol: string;
  readonly openInterest: number; // base units
  readonly openInterestValue: number; // quote units
  readonly timestamp: number;
}

export interface LongShortRatio {
  readonly symbol: string;
  readonly longAccountPct: number;
  readonly shortAccountPct: number;
  readonly ratio: number;
  readonly timestamp: number;
}

export interface Liquidation {
  readonly symbol: string;
  /** Side of the LIQUIDATED position: a long liquidation prints as a sell. */
  readonly side: "long" | "short";
  readonly price: number;
  readonly quantity: number;
  readonly quoteQuantity: number;
  readonly timestamp: number;
}

/** Market-wide context used by Stage 2. */
export interface GlobalMarket {
  readonly totalMarketCap: number;
  readonly totalVolume24h: number;
  readonly btcDominance: number;
  readonly ethDominance: number;
  readonly timestamp: number;
}

export interface FearGreed {
  readonly value: number; // 0..100
  readonly classification: string;
  readonly timestamp: number;
}

export interface ProtocolTvl {
  readonly name: string;
  readonly symbol: string | null;
  readonly tvl: number;
  readonly change1d: number | null;
  readonly change7d: number | null;
  readonly revenue24h?: number | null;
}

/** Direction of a trade idea. `flat` = the pipeline allows nothing this cycle. */
export type Direction = "long" | "short";
export type AllowedDirection = Direction | "both" | "none";
