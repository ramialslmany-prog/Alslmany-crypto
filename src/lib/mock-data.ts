/**
 * Deterministic mock market data.
 *
 * Everything here is seeded (no Math.random at render) so server and client
 * render identical markup — no hydration mismatches. When the real backend
 * lands, swap these exports for TanStack Query hooks hitting the API; the
 * component contracts (types below) stay the same.
 */

export type Coin = {
  symbol: string;
  name: string;
  price: number;
  change24h: number;
  change7d: number;
  marketCap: number;
  volume24h: number;
  color: string;
  spark: number[];
  image?: string; // real logo URL (from CoinGecko)
  rank?: number; // market-cap rank
  dex?: boolean; // tagged as a DEX / DeFi token
};

export type Signal = "BUY" | "SELL" | "ACCUMULATE" | "REDUCE";

export type Recommendation = {
  symbol: string;
  name: string;
  signal: Signal;
  confidence: number; // 0-100
  entry: number;
  target: number;
  stop: number;
  horizon: string;
  rationale: string;
  models: string[];
  color: string;
};

export type WhaleTx = {
  id: string;
  side: "accumulation" | "distribution";
  symbol: string;
  amountUsd: number;
  wallet: string;
  venue: string;
  minutesAgo: number;
};

/* ---- seeded PRNG so values are stable across SSR/CSR ---- */
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSpark(seed: number, len = 32, drift = 0): number[] {
  const rnd = mulberry32(seed);
  let v = 50;
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    v += (rnd() - 0.5) * 10 + drift;
    v = Math.max(10, Math.min(95, v));
    out.push(Number(v.toFixed(2)));
  }
  return out;
}

export const coins: Coin[] = [
  { symbol: "BTC", name: "Bitcoin", price: 71284.32, change24h: 2.41, change7d: 8.12, marketCap: 1_402_000_000_000, volume24h: 38_400_000_000, color: "#F7931A", spark: makeSpark(1, 32, 0.6) },
  { symbol: "ETH", name: "Ethereum", price: 3842.17, change24h: 3.88, change7d: 11.4, marketCap: 462_000_000_000, volume24h: 19_200_000_000, color: "#627EEA", spark: makeSpark(2, 32, 0.8) },
  { symbol: "SOL", name: "Solana", price: 186.44, change24h: 6.12, change7d: 18.7, marketCap: 86_000_000_000, volume24h: 5_100_000_000, color: "#14F195", spark: makeSpark(3, 32, 1.1) },
  { symbol: "BNB", name: "BNB", price: 612.9, change24h: -1.07, change7d: 2.3, marketCap: 89_000_000_000, volume24h: 1_900_000_000, color: "#F3BA2F", spark: makeSpark(4, 32, -0.2) },
  { symbol: "XRP", name: "XRP", price: 0.6231, change24h: -2.45, change7d: -4.1, marketCap: 34_000_000_000, volume24h: 1_400_000_000, color: "#9CA3AF", spark: makeSpark(5, 32, -0.5) },
  { symbol: "AVAX", name: "Avalanche", price: 41.28, change24h: 4.77, change7d: 9.9, marketCap: 16_000_000_000, volume24h: 720_000_000, color: "#E84142", spark: makeSpark(6, 32, 0.5) },
  { symbol: "LINK", name: "Chainlink", price: 18.93, change24h: 5.31, change7d: 14.2, marketCap: 11_800_000_000, volume24h: 640_000_000, color: "#2A5ADA", spark: makeSpark(7, 32, 0.9) },
  { symbol: "DOGE", name: "Dogecoin", price: 0.1622, change24h: -3.12, change7d: -1.4, marketCap: 23_000_000_000, volume24h: 1_200_000_000, color: "#C2A633", spark: makeSpark(8, 32, -0.3) },
];

export const recommendations: Recommendation[] = [
  {
    symbol: "SOL", name: "Solana", signal: "BUY", confidence: 91, entry: 184.2, target: 232.0, stop: 168.5,
    horizon: "5–9 days", color: "#14F195",
    rationale: "Smart-money accumulation zone reclaimed with rising spot CVD. Funding neutral while open interest builds — structurally bullish.",
    models: ["GPT-4o", "Claude", "DeepSeek"],
  },
  {
    symbol: "ETH", name: "Ethereum", signal: "ACCUMULATE", confidence: 84, entry: 3780, target: 4480, stop: 3520,
    horizon: "2–4 weeks", color: "#627EEA",
    rationale: "ETF inflows turning positive; ICT daily order block at 3.7k holding. Liquidity sweep of equal lows likely before continuation.",
    models: ["GPT-4o", "Claude"],
  },
  {
    symbol: "DOGE", name: "Dogecoin", signal: "REDUCE", confidence: 73, entry: 0.162, target: 0.131, stop: 0.178,
    horizon: "3–6 days", color: "#C2A633",
    rationale: "Distribution detected at range highs — exchange inflows spiking while spot demand fades. De-risk into strength.",
    models: ["Claude", "DeepSeek"],
  },
];

export const whaleFeed: WhaleTx[] = [
  { id: "w1", side: "accumulation", symbol: "BTC", amountUsd: 14_200_000, wallet: "0x7a…f3c1", venue: "Coinbase Prime", minutesAgo: 2 },
  { id: "w2", side: "accumulation", symbol: "SOL", amountUsd: 3_840_000, wallet: "0x91…aa20", venue: "Binance", minutesAgo: 6 },
  { id: "w3", side: "distribution", symbol: "DOGE", amountUsd: 1_120_000, wallet: "0x4d…7e9b", venue: "OKX", minutesAgo: 11 },
  { id: "w4", side: "accumulation", symbol: "ETH", amountUsd: 8_650_000, wallet: "0x2c…11df", venue: "Kraken", minutesAgo: 17 },
  { id: "w5", side: "distribution", symbol: "XRP", amountUsd: 980_000, wallet: "0xb8…5c4a", venue: "Bitstamp", minutesAgo: 24 },
  { id: "w6", side: "accumulation", symbol: "LINK", amountUsd: 2_210_000, wallet: "0x6f…90e2", venue: "Binance", minutesAgo: 31 },
];

export const portfolio = {
  totalValue: 284_910.44,
  change24hUsd: 6_842.19,
  change24hPct: 2.46,
  realizedPnl: 41_280.0,
  winRate: 68.4,
  allocations: [
    { symbol: "BTC", pct: 38, value: 108_265, color: "#F7931A" },
    { symbol: "ETH", pct: 27, value: 76_926, color: "#627EEA" },
    { symbol: "SOL", pct: 18, value: 51_283, color: "#14F195" },
    { symbol: "LINK", pct: 9, value: 25_641, color: "#2A5ADA" },
    { symbol: "Cash", pct: 8, value: 22_792, color: "#8A94B0" },
  ],
};

export const equityCurve = makeSpark(42, 48, 1.4);

export const fearGreed = { value: 74, label: "Greed" };

export const aiInsights = [
  { tag: "Macro", text: "Liquidity regime flipped risk-on — BTC dominance rolling over favors large-cap alts.", tone: "bull" as const },
  { tag: "On-chain", text: "Stablecoin supply on exchanges +2.1% (24h) — dry powder building for spot bids.", tone: "bull" as const },
  { tag: "Derivatives", text: "Funding elevated on perps; watch for a long-squeeze flush before the next leg.", tone: "warn" as const },
];

export const newsFeed = [
  { id: "n1", source: "Bloomberg", title: "Spot ETH ETFs log fourth straight day of net inflows", impact: 78, tone: "bull" as const, minutesAgo: 14 },
  { id: "n2", source: "The Block", title: "Solana network fees hit yearly high as DeFi activity surges", impact: 64, tone: "bull" as const, minutesAgo: 33 },
  { id: "n3", source: "Reuters", title: "Fed minutes signal patience; rate-cut odds for Q3 tick higher", impact: 71, tone: "bull" as const, minutesAgo: 52 },
];

/** Global stat band for the landing page — honest, real numbers. */
export const platformStats = [
  { label: "Coins scanned", value: "300", sub: "top by market cap, live" },
  { label: "Exchanges", value: "8", sub: "for price validation" },
  { label: "TA indicators", value: "8+", sub: "RSI · MACD · ATR · BB · VWAP" },
  { label: "AI analysis", value: "Live", sub: "LLM + rule engine" },
];
