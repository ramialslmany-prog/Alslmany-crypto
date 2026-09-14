/**
 * The contract every venue adapter implements.
 *
 * Nothing above this file may import a venue module directly — the pipeline
 * receives a `MarketDataSource` and cannot tell Binance from Bybit. That is
 * what makes a geo-block or an outage a one-line config change.
 *
 * Capability honesty: venues differ (OKX has no aggregated long/short account
 * ratio, spot venues have no funding). Rather than returning zeros, an adapter
 * declares what it supports in `capabilities` and returns `not_implemented`
 * for the rest, so the analysis stage records "unavailable" and takes the
 * declared confidence penalty.
 */
import type { Availability } from "@/shared/availability";
import type { Timeframe } from "@/shared/time";
import type {
  Candle,
  FundingRate,
  GlobalMarket,
  Liquidation,
  LongShortRatio,
  MarketType,
  OpenInterest,
  OrderBook,
  SymbolInfo,
  Ticker24h,
  Trade,
} from "@/core/types";

export interface MarketCapabilities {
  readonly spot: boolean;
  readonly perp: boolean;
  readonly funding: boolean;
  readonly openInterest: boolean;
  readonly longShortRatio: boolean;
  /** Real-time forced-liquidation stream. */
  readonly liquidations: boolean;
  /** Bulk historical archive (Binance Vision and equivalents). */
  readonly historicalArchive: boolean;
  readonly websocket: boolean;
  /**
   * Whether klines carry the taker-buy split (aggressor breakdown).
   * Binance does; Bybit and OKX do not. Cumulative volume delta is only
   * honest when this is true — when false the flow stage must report
   * "unavailable" rather than compute a delta from zeros.
   */
  readonly klineTakerBreakdown: boolean;
}

export interface KlineRequest {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly limit?: number;
  /** Inclusive lower bound on openTime. */
  readonly startTime?: number;
  /** Inclusive upper bound on openTime. */
  readonly endTime?: number;
  readonly market?: MarketType;
}

/** Live-stream event envelope. Consumers subscribe once and switch on `type`. */
export type StreamEvent =
  | { type: "candle"; symbol: string; timeframe: Timeframe; candle: Candle; closed: boolean }
  | { type: "trade"; symbol: string; trade: Trade }
  | { type: "book"; symbol: string; book: OrderBook }
  | { type: "liquidation"; liquidation: Liquidation }
  | { type: "status"; state: "connected" | "disconnected" | "reconnecting"; detail?: string };

export interface StreamSubscription {
  readonly symbols: readonly string[];
  readonly timeframes?: readonly Timeframe[];
  readonly channels: readonly ("candle" | "trade" | "book" | "liquidation")[];
  readonly market?: MarketType;
}

export interface MarketStream {
  /** Resolves once the socket is open and subscribed. */
  start(): Promise<void>;
  stop(): Promise<void>;
  on(handler: (event: StreamEvent) => void): () => void;
  readonly connected: boolean;
}

export interface MarketDataSource {
  /** Stable id used in `source` labels and the health page: "binance". */
  readonly id: string;
  /** Arabic display name. */
  readonly label: string;
  readonly capabilities: MarketCapabilities;

  /** Venue clock — drives the drift check on the health page. */
  serverTime(): Promise<Availability<number>>;

  /** Every tradable symbol for the configured quote asset. */
  symbols(market?: MarketType): Promise<Availability<SymbolInfo[]>>;

  ticker24h(symbols?: string[]): Promise<Availability<Ticker24h[]>>;

  /**
   * Klines. Adapters MUST return candles ordered by openTime ascending and
   * MUST NOT strip the forming candle — `dropUnclosed` at the call site owns
   * that decision so backtests and live runs behave identically.
   */
  klines(req: KlineRequest): Promise<Availability<Candle[]>>;

  orderBook(symbol: string, depth?: number, market?: MarketType): Promise<Availability<OrderBook>>;

  /** Recent aggregated trades, ascending by time. */
  recentTrades(symbol: string, limit?: number, market?: MarketType): Promise<Availability<Trade[]>>;

  fundingRate(symbol: string): Promise<Availability<FundingRate>>;
  fundingHistory(symbol: string, limit?: number): Promise<Availability<FundingRate[]>>;
  openInterest(symbol: string): Promise<Availability<OpenInterest>>;
  openInterestHistory(
    symbol: string,
    period: "5m" | "15m" | "1h" | "4h" | "1d",
    limit?: number,
  ): Promise<Availability<OpenInterest[]>>;
  longShortRatio(
    symbol: string,
    period: "5m" | "15m" | "1h" | "4h" | "1d",
    limit?: number,
  ): Promise<Availability<LongShortRatio[]>>;

  /** Live socket. Adapters without websocket support return null. */
  createStream(sub: StreamSubscription): MarketStream | null;
}

/** Market-wide aggregates come from a separate provider (CoinGecko). */
export interface GlobalMarketSource {
  readonly id: string;
  global(): Promise<Availability<GlobalMarket>>;
}
