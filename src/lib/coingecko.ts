/**
 * CoinGecko integration helpers (server-side).
 *
 * Free public API — no key required. We proxy through Next route handlers so
 * the browser never hits CoinGecko directly (avoids CORS + shares a server
 * cache so we respect the free-tier rate limit).
 */
import type { Coin } from "@/lib/mock-data";
import { COIN_META, colorOf, DEX_SYMBOLS } from "@/lib/coin-meta";

export const CG_BASE = "https://api.coingecko.com/api/v3";

/** Known ids/colors for the curated set (used by the chart route + signals). */
export const UNIVERSE: { symbol: string; id: string; color: string }[] = COIN_META.map((c) => ({
  symbol: c.symbol,
  id: c.cgId,
  color: c.color,
}));

export const ID_BY_SYMBOL = Object.fromEntries(UNIVERSE.map((u) => [u.symbol, u.id]));

/** How many top coins (by market cap) to surface, and page size (CG max 250). */
export const MARKETS_LIMIT = 300;
const PER_PAGE = 150;

type CgMarket = {
  id: string;
  symbol: string;
  name: string;
  image: string;
  market_cap_rank: number | null;
  current_price: number;
  price_change_percentage_24h: number | null;
  price_change_percentage_7d_in_currency: number | null;
  market_cap: number;
  total_volume: number;
  sparkline_in_7d?: { price: number[] };
};

/** Downsample a series to ~`points` evenly-spaced samples. */
export function downsample(arr: number[], points: number): number[] {
  if (arr.length <= points) return arr;
  const step = (arr.length - 1) / (points - 1);
  return Array.from({ length: points }, (_, i) => arr[Math.round(i * step)]);
}

/** Fetch the top-N coins by market cap (with real logos), mapped to `Coin`. */
export async function fetchMarkets(): Promise<Coin[]> {
  const pages = Math.ceil(MARKETS_LIMIT / PER_PAGE);
  const requests = Array.from({ length: pages }, (_, i) =>
    fetch(
      `${CG_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc` +
        `&per_page=${PER_PAGE}&page=${i + 1}&sparkline=true&price_change_percentage=24h,7d`,
      { next: { revalidate: 30 }, headers: { accept: "application/json" } }
    )
  );

  // Resilient: if a later page is rate-limited, still return earlier pages.
  const settled = await Promise.allSettled(requests);
  const data: CgMarket[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value.ok) data.push(...((await r.value.json()) as CgMarket[]));
  }
  if (data.length === 0) throw new Error("CoinGecko markets failed (all pages)");

  return data.map((m): Coin => {
    const symbol = m.symbol.toUpperCase();
    return {
      symbol,
      name: m.name,
      price: m.current_price,
      change24h: m.price_change_percentage_24h ?? 0,
      change7d: m.price_change_percentage_7d_in_currency ?? 0,
      marketCap: m.market_cap,
      volume24h: m.total_volume,
      color: colorOf(symbol), // brand color if known, else a deterministic hue
      spark: downsample(m.sparkline_in_7d?.price ?? [], 80), // 80 pts → enough for indicators
      image: m.image,
      rank: m.market_cap_rank ?? undefined,
      dex: DEX_SYMBOLS.has(symbol),
    };
  });
}

/** Fetch a price series for one coin over `days`, downsampled for charting. */
export async function fetchChart(id: string, days: number): Promise<number[]> {
  const url = `${CG_BASE}/coins/${id}/market_chart?vs_currency=usd&days=${days}`;
  const res = await fetch(url, { next: { revalidate: 30 }, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`CoinGecko chart ${res.status}`);
  const data = (await res.json()) as { prices: [number, number][] };
  return downsample(data.prices.map((p) => p[1]), 64);
}
