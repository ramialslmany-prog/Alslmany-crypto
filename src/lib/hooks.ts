"use client";

import { useQuery, useQueries } from "@tanstack/react-query";
import type { Coin } from "@/lib/mock-data";
import { coins as mockCoins } from "@/lib/mock-data";
import type { ValidationResult } from "@/lib/validation";
import type { Recommendation, Style, Market } from "@/lib/signal-engine";
import type { Candle, Interval } from "@/lib/candles";

type MarketsResponse = { source: "coingecko" | "mock"; updatedAt: number; coins: Coin[] };
type ChartResponse = { source: "coingecko" | "coingecko-spark" | "mock"; symbol: string; days: number; prices: number[] };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Live market snapshot. `initialData` is the seeded mock so the first paint
 * (and SSR hydration) matches exactly — then it swaps to live on first fetch.
 */
export function useMarkets() {
  const query = useQuery({
    queryKey: ["markets"],
    queryFn: () => getJson<MarketsResponse>("/api/markets"),
    initialData: { source: "mock", updatedAt: 0, coins: mockCoins } as MarketsResponse,
    // Treat the seed as already stale → render it instantly, then refetch live now.
    initialDataUpdatedAt: 0,
    refetchInterval: 30_000, // matches the server cache TTL — freshest prices, no extra CoinGecko load
  });
  return {
    coins: query.data.coins,
    isLive: query.data.source === "coingecko",
    isFetching: query.isFetching,
  };
}

export function useCoin(symbol: string): Coin {
  const { coins } = useMarkets();
  return coins.find((c) => c.symbol === symbol) ?? mockCoins.find((c) => c.symbol === symbol) ?? mockCoins[0];
}

export function useChart(symbol: string, days: number) {
  const fallback = mockCoins.find((c) => c.symbol === symbol)?.spark ?? mockCoins[0].spark;
  const query = useQuery({
    queryKey: ["chart", symbol, days],
    queryFn: () => getJson<ChartResponse>(`/api/chart?symbol=${symbol}&days=${days}`),
    initialData: { source: "mock", symbol, days, prices: fallback } as ChartResponse,
    initialDataUpdatedAt: 0,
    refetchInterval: 60_000,
  });
  return {
    prices: query.data.prices?.length ? query.data.prices : fallback,
    isLive: query.data.source.startsWith("coingecko"),
    isFetching: query.isFetching,
  };
}

/**
 * Real-time multi-exchange price validation. No seed — the panel shows a
 * skeleton on first load, then the live verdict. Refetches every 12s.
 */
export function usePriceValidation(symbol: string) {
  const query = useQuery({
    queryKey: ["validate", symbol],
    queryFn: () => getJson<ValidationResult>(`/api/validate?symbol=${symbol}`),
    refetchInterval: 12_000,
    staleTime: 8_000,
  });
  return { data: query.data, isLoading: query.isLoading, isFetching: query.isFetching };
}

export type FearGreed = { value: number; classification: string; source: string };

/** The real Crypto Fear & Greed Index (alternative.me). */
export function useFearGreed(): FearGreed {
  const query = useQuery({
    queryKey: ["feargreed"],
    queryFn: () => getJson<FearGreed>("/api/feargreed"),
    initialData: { value: 50, classification: "Neutral", source: "loading" },
    initialDataUpdatedAt: 0,
    refetchInterval: 600_000,
  });
  return query.data;
}

export type NewsItem = { title: string; link: string; pubDate: string; source: string };

/** Live crypto headlines (real RSS via /api/news). */
export function useNews() {
  const query = useQuery({
    queryKey: ["news"],
    queryFn: () => getJson<{ items: NewsItem[]; updatedAt: number }>("/api/news"),
    refetchInterval: 600_000,
    staleTime: 300_000,
  });
  return { items: query.data?.items ?? [], isLoading: query.isLoading };
}

import type { JTrade } from "@/lib/ai-journal";

export type ServerJournalResp = { serverActive: boolean; trades: JTrade[] };

/** The 24/7 server-side trade journal (Upstash). When `serverActive`, the cloud
 *  loop is the brain — the page mirrors it and the in-app watcher stays silent. */
export function useServerJournal() {
  const query = useQuery({
    queryKey: ["serverJournal"],
    queryFn: () => getJson<ServerJournalResp>("/api/journal"),
    initialData: { serverActive: false, trades: [] } as ServerJournalResp,
    initialDataUpdatedAt: 0,
    refetchInterval: 15_000,
  });
  return { serverActive: !!query.data.serverActive, trades: query.data.trades ?? [] };
}

export type WhaleTrade = { id: string; symbol: string; side: "accumulation" | "distribution"; price: number; amountUsd: number; ts: number };
type WhalesResponse = { source: string; updatedAt: number; trades: WhaleTrade[]; netBuyUsd: number; netSellUsd: number };

/** Real large-print whale feed (Binance aggTrades via /api/whales). */
export function useWhales() {
  const query = useQuery({
    queryKey: ["whales"],
    queryFn: () => getJson<WhalesResponse>("/api/whales"),
    refetchInterval: 20_000,
    staleTime: 10_000,
  });
  return {
    trades: query.data?.trades ?? [],
    netBuyUsd: query.data?.netBuyUsd ?? 0,
    netSellUsd: query.data?.netSellUsd ?? 0,
    isLive: query.data?.source === "binance",
    isLoading: query.isLoading,
  };
}

export type StructureRow = {
  symbol: string; price: number; trend: "up" | "down" | "range"; structure: string;
  bias: "bullish" | "bearish" | "neutral"; rsi: number; support: number; resistance: number;
  fvg: "bull" | "bear" | null; volRatio: number; source: string;
};
type StructureResponse = { interval: string; updatedAt: number; rows: StructureRow[]; bullish: number; bearish: number; neutral: number };

/** Smart-money market-structure board (/api/structure). */
export function useStructure(tf: "day" | "swing" | "macro") {
  const query = useQuery({
    queryKey: ["structure", tf],
    queryFn: () => getJson<StructureResponse>(`/api/structure?tf=${tf}`),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  return { data: query.data, isLoading: query.isLoading };
}

export type BacktestResult = {
  symbol: string; interval: string; style: string; source: string; error?: string;
  fromTs: number; toTs: number; bars: number; trades: number; wins: number; losses: number;
  winRate: number; totalReturnPct: number; avgPct: number; profitFactor: number; avgBars: number;
  bestPct: number; worstPct: number; equityCurve: number[];
  recent: { entry: number; exit: number; retPct: number; bars: number; outcome: string }[];
};

/** Walk-forward strategy backtest (/api/backtest). Manual trigger via `enabled`. */
export function useBacktest(symbol: string, style: string, enabled: boolean) {
  const query = useQuery({
    queryKey: ["backtest", symbol, style],
    queryFn: () => getJson<BacktestResult>(`/api/backtest?symbol=${symbol}&style=${style}`),
    enabled,
    staleTime: 300_000,
  });
  return { data: query.data, isLoading: query.isFetching };
}

type CandlesResponse = { symbol: string; interval: Interval; source: string; candles: Candle[] };

/** Real OHLCV candles for the candlestick chart (/api/candles), refreshed live. */
export function useCandles(symbol: string, interval: Interval, limit = 180) {
  const query = useQuery({
    queryKey: ["candles", symbol, interval, limit],
    queryFn: () => getJson<CandlesResponse>(`/api/candles?symbol=${symbol}&interval=${interval}&limit=${limit}`),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  return {
    candles: query.data?.candles ?? [],
    source: query.data?.source,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/** One rigorous multi-timeframe recommendation, cached & deduped via React Query. */
export function useSignal(symbol: string, style: Style, market: Market) {
  const query = useQuery({
    queryKey: ["signal", symbol, style, market],
    queryFn: () => getJson<Recommendation>(`/api/signals?symbol=${symbol}&style=${style}&market=${market}`),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  return { rec: query.data, isLoading: query.isLoading, isError: query.isError };
}

/**
 * Market-leader regime read (BTC on 4h/1d). Shared & cached so every surface
 * that gates on "is the market falling?" hits one deduped query, not N fetches.
 */
export function useBtcRegime() {
  const { rec, isLoading } = useSignal("BTC", "swing", "spot");
  return { bearish: rec ? rec.trend === "down" : null, trend: rec?.trend, isLoading };
}

export type SignalRow = { symbol: string; rec: Recommendation | undefined; isLoading: boolean };

/** Rule-based (non-AI) recommendations for a watchlist + trading style + market. */
export function useSignalsBatch(symbols: string[], style: Style, market: Market): SignalRow[] {
  const results = useQueries({
    queries: symbols.map((sym) => ({
      queryKey: ["signal", sym, style, market],
      queryFn: () => getJson<Recommendation>(`/api/signals?symbol=${sym}&style=${style}&market=${market}`),
      refetchInterval: 30_000,
      staleTime: 15_000,
    })),
  });
  return symbols.map((symbol, i) => ({ symbol, rec: results[i].data, isLoading: results[i].isLoading }));
}
