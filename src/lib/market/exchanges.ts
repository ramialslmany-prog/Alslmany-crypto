import "server-only";
import { z } from "zod";
import { fetchJson, firstSuccess } from "./http";
import {
  sanitizeCandles,
  type Candle,
  type DataSource,
  type Series,
  type Ticker,
  type Timeframe,
} from "./types";

/**
 * Spot-market adapters over three public exchanges.
 *
 * Each venue is queried with the same interface and normalised into our
 * Candle/Ticker shapes. We fail over in order rather than depending on any
 * single exchange staying reachable — Binance is geo-blocked in some regions,
 * OKX and Bybit cover the gap.
 */

const toNum = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** Upstream row shapes: arrays of string|number of varying length. */
const RowSchema = z.array(z.union([z.string(), z.number(), z.null()]));
const RowsSchema = z.array(RowSchema);

// ── Binance ──────────────────────────────────────────────────────────────
const BINANCE = "https://api.binance.com";

const BINANCE_TF: Record<Timeframe, string> = {
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
};

async function binanceCandles(pair: string, tf: Timeframe, limit: number): Promise<Candle[]> {
  const url = `${BINANCE}/api/v3/klines?symbol=${pair}&interval=${BINANCE_TF[tf]}&limit=${limit}`;
  const rows = RowsSchema.parse(await fetchJson(url));
  return rows.map((r) => ({
    t: toNum(r[0]),
    o: toNum(r[1]),
    h: toNum(r[2]),
    l: toNum(r[3]),
    c: toNum(r[4]),
    v: toNum(r[5]),
  }));
}

const BinanceTickerSchema = z.object({
  symbol: z.string(),
  lastPrice: z.string(),
  priceChangePercent: z.string(),
  highPrice: z.string(),
  lowPrice: z.string(),
  quoteVolume: z.string(),
});

async function binanceTicker(pair: string): Promise<Ticker> {
  const raw = BinanceTickerSchema.parse(
    await fetchJson(`${BINANCE}/api/v3/ticker/24hr?symbol=${pair}`),
  );
  return {
    symbol: pair,
    price: toNum(raw.lastPrice),
    changePct24h: toNum(raw.priceChangePercent),
    high24h: toNum(raw.highPrice),
    low24h: toNum(raw.lowPrice),
    quoteVolume24h: toNum(raw.quoteVolume),
    source: "binance",
  };
}

// ── OKX ──────────────────────────────────────────────────────────────────
const OKX = "https://www.okx.com";

const OKX_TF: Record<Timeframe, string> = {
  "15m": "15m",
  "1h": "1H",
  "4h": "4H",
  "1d": "1D",
};

const OkxEnvelope = z.object({ code: z.string(), data: z.unknown() });

function okxInst(pair: string) {
  // BTCUSDT -> BTC-USDT
  return pair.endsWith("USDT") ? `${pair.slice(0, -4)}-USDT` : pair;
}

async function okxCandles(pair: string, tf: Timeframe, limit: number): Promise<Candle[]> {
  const url = `${OKX}/api/v5/market/candles?instId=${okxInst(pair)}&bar=${OKX_TF[tf]}&limit=${Math.min(limit, 300)}`;
  const env = OkxEnvelope.parse(await fetchJson(url));
  if (env.code !== "0") throw new Error(`OKX code ${env.code}`);
  const rows = RowsSchema.parse(env.data);
  // OKX returns newest-first.
  return rows
    .map((r) => ({
      t: toNum(r[0]),
      o: toNum(r[1]),
      h: toNum(r[2]),
      l: toNum(r[3]),
      c: toNum(r[4]),
      v: toNum(r[5]),
    }))
    .reverse();
}

async function okxTicker(pair: string): Promise<Ticker> {
  const url = `${OKX}/api/v5/market/ticker?instId=${okxInst(pair)}`;
  const env = OkxEnvelope.parse(await fetchJson(url));
  if (env.code !== "0") throw new Error(`OKX code ${env.code}`);
  const row = z
    .array(
      z.object({
        last: z.string(),
        high24h: z.string(),
        low24h: z.string(),
        volCcy24h: z.string(),
        open24h: z.string(),
      }),
    )
    .parse(env.data)[0];
  if (!row) throw new Error("OKX empty ticker");
  const last = toNum(row.last);
  const open = toNum(row.open24h);
  return {
    symbol: pair,
    price: last,
    changePct24h: open > 0 ? ((last - open) / open) * 100 : 0,
    high24h: toNum(row.high24h),
    low24h: toNum(row.low24h),
    quoteVolume24h: toNum(row.volCcy24h),
    source: "okx",
  };
}

// ── Bybit ────────────────────────────────────────────────────────────────
const BYBIT = "https://api.bybit.com";

const BYBIT_TF: Record<Timeframe, string> = {
  "15m": "15",
  "1h": "60",
  "4h": "240",
  "1d": "D",
};

async function bybitCandles(pair: string, tf: Timeframe, limit: number): Promise<Candle[]> {
  const url = `${BYBIT}/v5/market/kline?category=spot&symbol=${pair}&interval=${BYBIT_TF[tf]}&limit=${Math.min(limit, 1000)}`;
  const env = z
    .object({ retCode: z.number(), result: z.object({ list: z.unknown() }) })
    .parse(await fetchJson(url));
  if (env.retCode !== 0) throw new Error(`Bybit retCode ${env.retCode}`);
  const rows = RowsSchema.parse(env.result.list);
  // Bybit returns newest-first.
  return rows
    .map((r) => ({
      t: toNum(r[0]),
      o: toNum(r[1]),
      h: toNum(r[2]),
      l: toNum(r[3]),
      c: toNum(r[4]),
      v: toNum(r[5]),
    }))
    .reverse();
}

async function bybitTicker(pair: string): Promise<Ticker> {
  const url = `${BYBIT}/v5/market/tickers?category=spot&symbol=${pair}`;
  const env = z
    .object({ retCode: z.number(), result: z.object({ list: z.unknown() }) })
    .parse(await fetchJson(url));
  if (env.retCode !== 0) throw new Error(`Bybit retCode ${env.retCode}`);
  const row = z
    .array(
      z.object({
        lastPrice: z.string(),
        highPrice24h: z.string(),
        lowPrice24h: z.string(),
        turnover24h: z.string(),
        price24hPcnt: z.string(),
      }),
    )
    .parse(env.result.list)[0];
  if (!row) throw new Error("Bybit empty ticker");
  return {
    symbol: pair,
    price: toNum(row.lastPrice),
    changePct24h: toNum(row.price24hPcnt) * 100,
    high24h: toNum(row.highPrice24h),
    low24h: toNum(row.lowPrice24h),
    quoteVolume24h: toNum(row.turnover24h),
    source: "bybit",
  };
}

// ── Public interface ─────────────────────────────────────────────────────

export type VenueName = Extract<DataSource, "binance" | "okx" | "bybit">;

/** Convert a base symbol ("BTC") into the USDT spot pair used upstream. */
export function toPair(symbol: string): string {
  const s = symbol.toUpperCase().replace(/[-_/]/g, "");
  return s.endsWith("USDT") ? s : `${s}USDT`;
}

export function toBase(pair: string): string {
  const s = pair.toUpperCase();
  return s.endsWith("USDT") ? s.slice(0, -4) : s;
}

/**
 * Fetch a candle series, failing over across venues.
 * A series shorter than `minBars` is rejected so the analysis layer never
 * runs indicators over a stub of data and reports false confidence.
 */
export async function getSeries(
  symbol: string,
  timeframe: Timeframe,
  limit = 300,
  minBars = 60,
): Promise<Series> {
  const pair = toPair(symbol);
  const { value, name } = await firstSuccess<{ candles: Candle[]; venue: VenueName }>([
    {
      name: "binance",
      run: async () => ({ candles: await binanceCandles(pair, timeframe, limit), venue: "binance" as const }),
    },
    {
      name: "okx",
      run: async () => ({ candles: await okxCandles(pair, timeframe, limit), venue: "okx" as const }),
    },
    {
      name: "bybit",
      run: async () => ({ candles: await bybitCandles(pair, timeframe, limit), venue: "bybit" as const }),
    },
  ]);

  const candles = sanitizeCandles(value.candles);
  if (candles.length < minBars) {
    throw new Error(`${pair} ${timeframe}: only ${candles.length} usable bars from ${name}`);
  }

  return {
    symbol: toBase(pair),
    timeframe,
    candles,
    source: value.venue,
    fetchedAt: Date.now(),
  };
}

export async function getTicker(symbol: string): Promise<Ticker> {
  const pair = toPair(symbol);
  const { value } = await firstSuccess<Ticker>([
    { name: "binance", run: () => binanceTicker(pair) },
    { name: "okx", run: () => okxTicker(pair) },
    { name: "bybit", run: () => bybitTicker(pair) },
  ]);
  return { ...value, symbol: toBase(pair) };
}

/**
 * Cross-venue price check. Agreement across independent order books is the
 * cheapest defence against acting on a bad or manipulated print.
 */
export async function priceIntegrity(symbol: string): Promise<{
  consensus: number | null;
  quotes: { venue: VenueName; price: number }[];
  spreadPct: number | null;
  trustworthy: boolean;
}> {
  const pair = toPair(symbol);
  const settled = await Promise.allSettled([
    binanceTicker(pair),
    okxTicker(pair),
    bybitTicker(pair),
  ]);
  const venues: VenueName[] = ["binance", "okx", "bybit"];
  const quotes = settled
    .map((r, i) =>
      r.status === "fulfilled" && r.value.price > 0
        ? { venue: venues[i], price: r.value.price }
        : null,
    )
    .filter((q): q is { venue: VenueName; price: number } => q !== null);

  if (quotes.length === 0) {
    return { consensus: null, quotes: [], spreadPct: null, trustworthy: false };
  }

  const prices = quotes.map((q) => q.price).sort((a, b) => a - b);
  const mid = prices[Math.floor(prices.length / 2)];
  const spreadPct =
    prices.length > 1 ? ((prices[prices.length - 1] - prices[0]) / mid) * 100 : 0;

  return {
    consensus: mid,
    quotes,
    spreadPct,
    // Independent books rarely disagree by more than a few tenths of a percent
    // on a healthy spot market; wider than 1% means something is off.
    trustworthy: quotes.length >= 2 && spreadPct <= 1,
  };
}
