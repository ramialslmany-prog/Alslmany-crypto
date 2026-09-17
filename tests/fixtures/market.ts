/**
 * A deterministic multi-timeframe market, for engine-level tests.
 *
 * Seeded, so the same prices appear on every machine and a backtest
 * regression is a real regression rather than a different random walk. The
 * path deliberately contains trends, ranges and a shock, because a pure
 * random walk produces almost no discoverable levels — and a backtest engine
 * that is only ever tested on a shapeless series is never tested at all.
 */
import type { Candle, SymbolInfo } from "@/core/types";
import type { Timeframe } from "@/shared/time";
import type { BacktestSymbol } from "@/core/backtest/engine";

const M15 = 900_000;
export const MARKET_START = Date.UTC(2023, 0, 2); // a Monday, so weeks align

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 15-minute candles with regime changes every ~40 days. */
export function generate15m(count: number, seed: number, start = 100): Candle[] {
  const rand = rng(seed);
  const gauss = () => {
    const u = Math.max(rand(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };

  const out: Candle[] = [];
  let price = start;
  const regimeLen = 40 * 96;

  for (let i = 0; i < count; i++) {
    const regime = Math.floor(i / regimeLen) % 4;
    const drift = regime === 0 ? 0.00018 : regime === 1 ? 0 : regime === 2 ? -0.00016 : 0.00005;
    const vol = regime === 3 ? 0.006 : 0.0022;

    // A range regime is mean-reverting, which is what creates the repeated
    // touches that become support and resistance.
    const pull = regime === 1 ? (start * Math.pow(1.02, Math.floor(i / regimeLen)) - price) * 0.0009 : 0;

    const open = price;
    const close = Math.max(0.01, open * (1 + drift + gauss() * vol) + pull);
    const wick = Math.abs(close - open) * (0.4 + rand()) + open * 0.0006;
    const volume = 500 + rand() * 900 + Math.abs(close - open) * 400;
    const takerShare = close >= open ? 0.5 + rand() * 0.15 : 0.35 + rand() * 0.15;

    out.push({
      openTime: MARKET_START + i * M15,
      closeTime: MARKET_START + (i + 1) * M15,
      open,
      high: Math.max(open, close) + wick,
      low: Math.max(0.005, Math.min(open, close) - wick),
      close,
      volume,
      quoteVolume: volume * close,
      trades: Math.round(80 + rand() * 200),
      takerBuyBase: volume * takerShare,
      takerBuyQuote: volume * takerShare * close,
    });
    price = close;
  }
  return out;
}

/** Roll `k` candles into one. Used to build 1h/4h/1d/1w from the 15m base. */
export function aggregate(src: readonly Candle[], k: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + k <= src.length; i += k) {
    const s = src.slice(i, i + k);
    out.push({
      openTime: s[0].openTime,
      closeTime: s[k - 1].closeTime,
      open: s[0].open,
      high: Math.max(...s.map((c) => c.high)),
      low: Math.min(...s.map((c) => c.low)),
      close: s[k - 1].close,
      volume: s.reduce((a, c) => a + c.volume, 0),
      quoteVolume: s.reduce((a, c) => a + c.quoteVolume, 0),
      trades: s.reduce((a, c) => a + c.trades, 0),
      takerBuyBase: s.reduce((a, c) => a + c.takerBuyBase, 0),
      takerBuyQuote: s.reduce((a, c) => a + c.takerBuyQuote, 0),
    });
  }
  return out;
}

export function symbolInfo(symbol: string): SymbolInfo {
  return {
    symbol, nativeSymbol: symbol, base: symbol.replace(/USDT$/, ""), quote: "USDT",
    market: "spot", status: "trading", pricePrecision: 2, quantityPrecision: 5,
    minNotional: 10,
  };
}

/** A full six-timeframe symbol built from one seeded 15m series. */
export function backtestSymbol(
  symbol: string, days: number, seed: number, startPrice = 100,
): BacktestSymbol {
  const m15 = generate15m(days * 96, seed, startPrice);
  const h1 = aggregate(m15, 4);
  const candles: Partial<Record<Timeframe, readonly Candle[]>> = {
    "15m": m15,
    "1h": h1,
    "4h": aggregate(h1, 4),
    "1d": aggregate(h1, 24),
    "1w": aggregate(h1, 168),
  };
  return {
    symbol,
    info: symbolInfo(symbol),
    listedAt: MARKET_START - 400 * 86_400_000,
    candles,
  };
}
