import "server-only";
import { cached } from "./cache";
import { getSeries, priceIntegrity } from "./exchanges";
import {
  fetchFearGreed,
  fetchGlobal,
  fetchMarkets,
  fetchMarketsFromExchange,
  globalFromMarkets,
} from "./coingecko";
import {
  syntheticCandles,
  syntheticFearGreed,
  syntheticGlobal,
  syntheticMarkets,
} from "./synthetic";
import type {
  CoinMarket,
  FearGreed,
  GlobalStats,
  Series,
  Sourced,
  Timeframe,
} from "./types";

/**
 * The single door to market data for everything above this layer.
 *
 * Each loader walks a fallback chain from best to worst source and always
 * returns provenance alongside the value. Callers never guess where a number
 * came from, and `degraded` is what the UI uses to decide whether to warn.
 *
 * The final rung of every chain is synthetic data. It is a demo mode, not a
 * silent substitute: it always reports `source: "synthetic"`, and the shell
 * renders a standing banner whenever that reaches the client.
 */

const TTL = {
  candles: { "15m": 30_000, "1h": 60_000, "4h": 180_000, "1d": 300_000 } as Record<
    Timeframe,
    number
  >,
  markets: 45_000,
  global: 120_000,
  sentiment: 15 * 60_000,
  integrity: 20_000,
};

export async function loadSeries(
  symbol: string,
  timeframe: Timeframe,
  limit = 300,
): Promise<Sourced<Series>> {
  const result = await cached<Series>(
    `series:${symbol}:${timeframe}:${limit}`,
    TTL.candles[timeframe],
    async () => {
      try {
        return await getSeries(symbol, timeframe, limit);
      } catch {
        return {
          symbol: symbol.toUpperCase(),
          timeframe,
          candles: syntheticCandles(symbol, timeframe, limit),
          source: "synthetic" as const,
          fetchedAt: Date.now(),
        };
      }
    },
  );

  const synthetic = result.value.source === "synthetic";
  return {
    data: result.value,
    source: result.value.source,
    fetchedAt: result.fetchedAt,
    degraded: result.degraded || synthetic,
    note: synthetic ? "no exchange reachable — demo series" : result.note,
  };
}

export async function loadMarkets(limit = 250): Promise<Sourced<CoinMarket[]>> {
  const result = await cached<{ markets: CoinMarket[]; source: string }>(
    "markets:top",
    TTL.markets,
    async () => {
      try {
        return { markets: await fetchMarkets(250, 1), source: "coingecko" };
      } catch {
        try {
          return { markets: await fetchMarketsFromExchange(), source: "binance" };
        } catch {
          return { markets: syntheticMarkets(), source: "synthetic" };
        }
      }
    },
  );

  const synthetic = result.value.source === "synthetic";
  return {
    data: result.value.markets.slice(0, limit),
    source: result.value.source as Sourced<CoinMarket[]>["source"],
    fetchedAt: result.fetchedAt,
    degraded: result.degraded || synthetic,
    note: synthetic ? "no market data provider reachable — demo list" : result.note,
  };
}

export async function loadGlobal(): Promise<Sourced<GlobalStats>> {
  const result = await cached<{ stats: GlobalStats; source: string }>(
    "global:stats",
    TTL.global,
    async () => {
      try {
        return { stats: await fetchGlobal(), source: "coingecko" };
      } catch {
        try {
          const markets = await fetchMarkets(250, 1);
          return { stats: globalFromMarkets(markets), source: "coingecko" };
        } catch {
          return { stats: syntheticGlobal(), source: "synthetic" };
        }
      }
    },
  );

  const synthetic = result.value.source === "synthetic";
  return {
    data: result.value.stats,
    source: result.value.source as Sourced<GlobalStats>["source"],
    fetchedAt: result.fetchedAt,
    degraded: result.degraded || synthetic,
    note: synthetic ? "global aggregates unavailable — demo figures" : result.note,
  };
}

export async function loadSentiment(): Promise<Sourced<FearGreed>> {
  const result = await cached<{ fng: FearGreed; source: string }>(
    "sentiment:fng",
    TTL.sentiment,
    async () => {
      try {
        return { fng: await fetchFearGreed(), source: "alternative.me" };
      } catch {
        return { fng: syntheticFearGreed(), source: "synthetic" };
      }
    },
  );

  const synthetic = result.value.source === "synthetic";
  return {
    data: result.value.fng,
    source: result.value.source as Sourced<FearGreed>["source"],
    fetchedAt: result.fetchedAt,
    degraded: result.degraded || synthetic,
    note: synthetic ? "sentiment provider unreachable — demo value" : result.note,
  };
}

export async function loadIntegrity(symbol: string) {
  return cached(`integrity:${symbol}`, TTL.integrity, () => priceIntegrity(symbol));
}

/** Load several timeframes at once — the analysis layer always wants a stack. */
export async function loadStack(
  symbol: string,
  timeframes: Timeframe[],
  limit = 300,
): Promise<Record<Timeframe, Series | null>> {
  const settled = await Promise.all(
    timeframes.map(async (tf) => {
      try {
        return [tf, (await loadSeries(symbol, tf, limit)).data] as const;
      } catch {
        return [tf, null] as const;
      }
    }),
  );
  return Object.fromEntries(settled) as Record<Timeframe, Series | null>;
}
