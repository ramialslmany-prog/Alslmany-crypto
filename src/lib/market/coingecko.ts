import "server-only";
import { z } from "zod";
import { fetchJson } from "./http";
import { toPair } from "./exchanges";
import { UNIVERSE } from "./universe";
import type { CoinMarket, FearGreed, GlobalStats } from "./types";

/**
 * Reference data: the coin list, global aggregates and market sentiment.
 *
 * CoinGecko's free tier rate-limits aggressively, so every call here has a
 * working fallback built from exchange tickers. The site degrades in quality,
 * never into an error page.
 */

const CG = "https://api.coingecko.com/api/v3";

const MarketRowSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  image: z.string().nullable().optional(),
  current_price: z.number().nullable(),
  market_cap: z.number().nullable(),
  market_cap_rank: z.number().nullable(),
  total_volume: z.number().nullable(),
  high_24h: z.number().nullable(),
  low_24h: z.number().nullable(),
  ath: z.number().nullable(),
  ath_change_percentage: z.number().nullable(),
  circulating_supply: z.number().nullable(),
  price_change_percentage_1h_in_currency: z.number().nullable().optional(),
  price_change_percentage_24h_in_currency: z.number().nullable().optional(),
  price_change_percentage_7d_in_currency: z.number().nullable().optional(),
  sparkline_in_7d: z.object({ price: z.array(z.number()) }).nullable().optional(),
});

const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export async function fetchMarkets(perPage = 250, page = 1): Promise<CoinMarket[]> {
  const url =
    `${CG}/coins/markets?vs_currency=usd&order=market_cap_desc` +
    `&per_page=${perPage}&page=${page}&sparkline=true` +
    `&price_change_percentage=1h%2C24h%2C7d`;
  const rows = z.array(MarketRowSchema).parse(await fetchJson(url, { timeout: 9000 }));

  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol.toUpperCase(),
    name: r.name,
    image: r.image ?? null,
    price: n(r.current_price),
    marketCap: n(r.market_cap),
    rank: n(r.market_cap_rank),
    volume24h: n(r.total_volume),
    changePct1h: n(r.price_change_percentage_1h_in_currency),
    changePct24h: n(r.price_change_percentage_24h_in_currency),
    changePct7d: n(r.price_change_percentage_7d_in_currency),
    high24h: n(r.high_24h),
    low24h: n(r.low_24h),
    ath: n(r.ath),
    athChangePct: n(r.ath_change_percentage),
    circulating: n(r.circulating_supply),
    // Thin the 7d sparkline to ~56 points; more is invisible at render size.
    sparkline: thin(r.sparkline_in_7d?.price ?? [], 56),
  }));
}

function thin(values: number[], target: number): number[] {
  if (values.length <= target) return values;
  const step = values.length / target;
  const out: number[] = [];
  for (let i = 0; i < target; i++) out.push(values[Math.floor(i * step)]);
  out.push(values[values.length - 1]);
  return out;
}

// ── Fallback: rebuild a market list from exchange tickers ────────────────

const BinanceAllTickers = z.array(
  z.object({
    symbol: z.string(),
    lastPrice: z.string(),
    priceChangePercent: z.string(),
    highPrice: z.string(),
    lowPrice: z.string(),
    quoteVolume: z.string(),
  }),
);

/**
 * When CoinGecko is unavailable we can still show live prices, volume and 24h
 * change for our own universe — everything the recommendation engine actually
 * needs. Market cap and 7d change are simply reported as unknown rather than
 * invented.
 */
export async function fetchMarketsFromExchange(): Promise<CoinMarket[]> {
  const rows = BinanceAllTickers.parse(
    await fetchJson("https://api.binance.com/api/v3/ticker/24hr", { timeout: 10000 }),
  );
  const wanted = new Map(UNIVERSE.map((u) => [toPair(u.symbol), u]));
  const out: CoinMarket[] = [];

  for (const r of rows) {
    const entry = wanted.get(r.symbol);
    if (!entry) continue;
    const price = Number(r.lastPrice);
    if (!Number.isFinite(price) || price <= 0) continue;
    out.push({
      id: entry.id,
      symbol: entry.symbol,
      name: entry.name,
      image: null,
      price,
      marketCap: 0,
      rank: 0,
      volume24h: Number(r.quoteVolume) || 0,
      changePct1h: 0,
      changePct24h: Number(r.priceChangePercent) || 0,
      changePct7d: 0,
      high24h: Number(r.highPrice) || 0,
      low24h: Number(r.lowPrice) || 0,
      ath: 0,
      athChangePct: 0,
      circulating: 0,
      sparkline: [],
    });
  }

  // Volume is the only ordering we can honestly claim without market caps.
  out.sort((a, b) => b.volume24h - a.volume24h);
  return out.map((c, i) => ({ ...c, rank: i + 1 }));
}

// ── Global aggregates ────────────────────────────────────────────────────

const GlobalSchema = z.object({
  data: z.object({
    total_market_cap: z.record(z.number()),
    total_volume: z.record(z.number()),
    market_cap_percentage: z.record(z.number()),
    market_cap_change_percentage_24h_usd: z.number().nullable(),
    active_cryptocurrencies: z.number().nullable(),
  }),
});

export async function fetchGlobal(): Promise<GlobalStats> {
  const raw = GlobalSchema.parse(await fetchJson(`${CG}/global`, { timeout: 8000 }));
  const d = raw.data;
  return {
    totalMarketCap: n(d.total_market_cap.usd),
    totalVolume24h: n(d.total_volume.usd),
    marketCapChangePct24h: n(d.market_cap_change_percentage_24h_usd),
    btcDominance: n(d.market_cap_percentage.btc),
    ethDominance: n(d.market_cap_percentage.eth),
    activeCoins: n(d.active_cryptocurrencies),
  };
}

/** Derive global aggregates from a market list when the endpoint is blocked. */
export function globalFromMarkets(markets: CoinMarket[]): GlobalStats {
  const totalMarketCap = markets.reduce((s, m) => s + m.marketCap, 0);
  const totalVolume24h = markets.reduce((s, m) => s + m.volume24h, 0);
  const btc = markets.find((m) => m.symbol === "BTC");
  const eth = markets.find((m) => m.symbol === "ETH");
  const weighted =
    totalMarketCap > 0
      ? markets.reduce((s, m) => s + m.changePct24h * (m.marketCap / totalMarketCap), 0)
      : 0;
  return {
    totalMarketCap,
    totalVolume24h,
    marketCapChangePct24h: weighted,
    btcDominance: totalMarketCap > 0 && btc ? (btc.marketCap / totalMarketCap) * 100 : 0,
    ethDominance: totalMarketCap > 0 && eth ? (eth.marketCap / totalMarketCap) * 100 : 0,
    activeCoins: markets.length,
  };
}

// ── Sentiment ────────────────────────────────────────────────────────────

const FngSchema = z.object({
  data: z.array(
    z.object({
      value: z.string(),
      value_classification: z.string(),
      timestamp: z.string(),
    }),
  ),
});

export async function fetchFearGreed(): Promise<FearGreed> {
  const raw = FngSchema.parse(
    await fetchJson("https://api.alternative.me/fng/?limit=2", { timeout: 7000 }),
  );
  const [today, yesterday] = raw.data;
  if (!today) throw new Error("empty fear & greed response");
  return {
    value: Number(today.value) || 50,
    label: today.value_classification,
    updatedAt: Number(today.timestamp) * 1000 || Date.now(),
    previous: yesterday ? Number(yesterday.value) || null : null,
  };
}

/** Attach the localisable label bucket without another round-trip. */
export function fearGreedBucket(value: number) {
  if (value <= 24) return "extreme-fear" as const;
  if (value <= 44) return "fear" as const;
  if (value <= 55) return "neutral" as const;
  if (value <= 74) return "greed" as const;
  return "extreme-greed" as const;
}
