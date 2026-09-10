"use client";

import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type { ApiResponse, Meta } from "@/lib/api";
import type { CoinMarket, FearGreed, GlobalStats, Series, Timeframe } from "@/lib/market/types";
import type { ScanResult } from "@/lib/engine/scan";
import type { Recommendation } from "@/lib/engine/recommendation";
import type { MarketRegime } from "@/lib/analysis/regime";
import type { BacktestResult } from "@/lib/bot/backtest";
import type { LedgerStats, Position, PositionEvent, BotConfig } from "@/lib/bot/types";

/**
 * Data access for the client.
 *
 * Every hook returns the payload alongside its `meta`, so a component can
 * always tell where a number came from and whether it is stale or synthetic.
 * Provenance travels with the data rather than being looked up separately —
 * that is what makes the demo banner impossible to forget.
 */

export type WithMeta<T> = { data: T | undefined; meta: Meta | undefined };

async function get<T>(url: string): Promise<{ data: T; meta: Meta }> {
  const res = await fetch(url, { cache: "no-store" });
  const body = (await res.json()) as ApiResponse<T>;
  if (!body.ok) throw new Error(body.error);
  return { data: body.data, meta: body.meta };
}

type Opts<T> = Omit<UseQueryOptions<{ data: T; meta: Meta }, Error>, "queryKey" | "queryFn">;

export function useMarkets(limit = 100, opts?: Opts<CoinMarket[]>) {
  return useQuery({
    queryKey: ["markets", limit],
    queryFn: () => get<CoinMarket[]>(`/api/markets?limit=${limit}`),
    refetchInterval: 45_000,
    ...opts,
  });
}

export function useGlobal(opts?: Opts<GlobalStats>) {
  return useQuery({
    queryKey: ["global"],
    queryFn: () => get<GlobalStats>("/api/global"),
    refetchInterval: 120_000,
    ...opts,
  });
}

export function useSentiment(opts?: Opts<FearGreed>) {
  return useQuery({
    queryKey: ["sentiment"],
    queryFn: () => get<FearGreed>("/api/sentiment"),
    refetchInterval: 10 * 60_000,
    ...opts,
  });
}

export function useCandles(symbol: string, timeframe: Timeframe, limit = 300) {
  return useQuery({
    queryKey: ["candles", symbol, timeframe, limit],
    queryFn: () => get<Series>(`/api/candles?symbol=${symbol}&tf=${timeframe}&limit=${limit}`),
    refetchInterval: timeframe === "15m" ? 30_000 : 90_000,
    enabled: Boolean(symbol),
  });
}

export function useRecommendations(tier: 1 | 2 | 3 = 2, limit = 60) {
  return useQuery({
    queryKey: ["recommendations", tier, limit],
    queryFn: () => get<ScanResult>(`/api/recommendations?tier=${tier}&limit=${limit}`),
    // The scan is cached server-side; this only decides how often we ask.
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
}

export function useAnalysis(symbol: string) {
  return useQuery({
    queryKey: ["analyze", symbol],
    queryFn: () =>
      get<{ recommendation: Recommendation | null; market: MarketRegime }>(
        `/api/analyze?symbol=${symbol}`,
      ),
    enabled: Boolean(symbol),
    refetchInterval: 120_000,
  });
}

export type BotSnapshot = {
  open: Position[];
  closed: Position[];
  events: PositionEvent[];
  stats: LedgerStats;
  equityR: { at: number; cumulative: number }[];
  bySector: Record<string, LedgerStats>;
  byGrade: Record<string, LedgerStats>;
  config: BotConfig;
  startedAt: number;
  lastTickAt: number;
  durable: boolean;
  mode: "paper";
};

export function useBot() {
  return useQuery({
    queryKey: ["bot"],
    queryFn: () => get<BotSnapshot>("/api/bot"),
    refetchInterval: 30_000,
  });
}

export function useBacktest(symbol: string, timeframe: Timeframe = "4h", enabled = true) {
  return useQuery({
    queryKey: ["backtest", symbol, timeframe],
    queryFn: () => get<BacktestResult>(`/api/backtest?symbol=${symbol}&tf=${timeframe}`),
    enabled: enabled && Boolean(symbol),
    // Historical results do not change between refreshes.
    staleTime: 10 * 60_000,
    refetchInterval: false,
  });
}

export function useIntegrity(symbol: string) {
  return useQuery({
    queryKey: ["integrity", symbol],
    queryFn: () =>
      get<{
        consensus: number | null;
        quotes: { venue: string; price: number }[];
        spreadPct: number | null;
        trustworthy: boolean;
      }>(`/api/integrity?symbol=${symbol}`),
    enabled: Boolean(symbol),
    refetchInterval: 30_000,
  });
}

export function useTelegram() {
  return useQuery({
    queryKey: ["telegram"],
    queryFn: () =>
      get<{ configured: boolean; chatResolved: boolean; note: string }>("/api/telegram"),
    staleTime: 60_000,
  });
}
