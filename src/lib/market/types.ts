/** Canonical market vocabulary. Every adapter normalises into these shapes. */

export const TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Minutes per timeframe — used for horizon maths and time-based exits. */
export const TF_MINUTES: Record<Timeframe, number> = {
  "15m": 15,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
};

export type Candle = {
  /** Open time, epoch ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Base-asset volume. */
  v: number;
};

export type Series = {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  source: DataSource;
  fetchedAt: number;
};

export type DataSource = "binance" | "okx" | "bybit" | "coingecko" | "alternative.me" | "synthetic";

export type Ticker = {
  symbol: string;
  price: number;
  changePct24h: number;
  high24h: number;
  low24h: number;
  quoteVolume24h: number;
  source: DataSource;
};

export type CoinMarket = {
  id: string;
  symbol: string;
  name: string;
  image: string | null;
  price: number;
  marketCap: number;
  rank: number;
  volume24h: number;
  changePct1h: number;
  changePct24h: number;
  changePct7d: number;
  high24h: number;
  low24h: number;
  ath: number;
  athChangePct: number;
  circulating: number;
  sparkline: number[];
};

export type GlobalStats = {
  totalMarketCap: number;
  totalVolume24h: number;
  marketCapChangePct24h: number;
  btcDominance: number;
  ethDominance: number;
  activeCoins: number;
};

export type FearGreed = {
  value: number;
  label: string;
  updatedAt: number;
  previous: number | null;
};

/** A quoted result plus the provenance needed to show data honestly. */
export type Sourced<T> = {
  data: T;
  source: DataSource;
  fetchedAt: number;
  degraded: boolean;
  note?: string;
};

export function isCandle(c: unknown): c is Candle {
  if (typeof c !== "object" || c === null) return false;
  const x = c as Record<string, unknown>;
  return (
    typeof x.t === "number" &&
    typeof x.o === "number" &&
    typeof x.h === "number" &&
    typeof x.l === "number" &&
    typeof x.c === "number" &&
    typeof x.v === "number"
  );
}

/** Reject series that are too short or contain impossible bars. */
export function sanitizeCandles(candles: Candle[]): Candle[] {
  return candles
    .filter(
      (c) =>
        isCandle(c) &&
        Number.isFinite(c.c) &&
        c.c > 0 &&
        c.h >= c.l &&
        c.h >= c.c &&
        c.l <= c.c,
    )
    .sort((a, b) => a.t - b.t);
}
