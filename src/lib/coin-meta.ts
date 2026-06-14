/**
 * Single source of truth for the tradable universe.
 * Client-safe (no server-only imports) so both the API layer and UI share it.
 */
export interface CoinMeta {
  symbol: string;
  name: string;
  cgId: string; // CoinGecko id
  color: string; // brand color (not provided by APIs)
}

export const COIN_META: CoinMeta[] = [
  { symbol: "BTC", name: "Bitcoin", cgId: "bitcoin", color: "#F7931A" },
  { symbol: "ETH", name: "Ethereum", cgId: "ethereum", color: "#627EEA" },
  { symbol: "SOL", name: "Solana", cgId: "solana", color: "#14F195" },
  { symbol: "BNB", name: "BNB", cgId: "binancecoin", color: "#F3BA2F" },
  { symbol: "XRP", name: "XRP", cgId: "ripple", color: "#9CA3AF" },
  { symbol: "AVAX", name: "Avalanche", cgId: "avalanche-2", color: "#E84142" },
  { symbol: "LINK", name: "Chainlink", cgId: "chainlink", color: "#2A5ADA" },
  { symbol: "DOGE", name: "Dogecoin", cgId: "dogecoin", color: "#C2A633" },
  { symbol: "ADA", name: "Cardano", cgId: "cardano", color: "#0033AD" },
  { symbol: "DOT", name: "Polkadot", cgId: "polkadot", color: "#E6007A" },
  { symbol: "MATIC", name: "Polygon", cgId: "matic-network", color: "#8247E5" },
  { symbol: "TRX", name: "Tron", cgId: "tron", color: "#FF060A" },
  { symbol: "LTC", name: "Litecoin", cgId: "litecoin", color: "#B8B8B8" },
  { symbol: "ATOM", name: "Cosmos", cgId: "cosmos", color: "#6F7390" },
  { symbol: "UNI", name: "Uniswap", cgId: "uniswap", color: "#FF007A" },
  { symbol: "XLM", name: "Stellar", cgId: "stellar", color: "#14B6E7" },
  { symbol: "NEAR", name: "NEAR", cgId: "near", color: "#00EC97" },
  { symbol: "APT", name: "Aptos", cgId: "aptos", color: "#4DC8B0" },
  { symbol: "ARB", name: "Arbitrum", cgId: "arbitrum", color: "#28A0F0" },
  { symbol: "OP", name: "Optimism", cgId: "optimism", color: "#FF0420" },
  { symbol: "INJ", name: "Injective", cgId: "injective-protocol", color: "#00D2FF" },
  { symbol: "FIL", name: "Filecoin", cgId: "filecoin", color: "#0090FF" },
  { symbol: "ICP", name: "Internet Computer", cgId: "internet-computer", color: "#3B00B9" },
  { symbol: "SHIB", name: "Shiba Inu", cgId: "shiba-inu", color: "#FFA409" },
];

export const SYMBOLS = COIN_META.map((c) => c.symbol);
export const COLOR_BY_SYMBOL: Record<string, string> = Object.fromEntries(COIN_META.map((c) => [c.symbol, c.color]));
export const NAME_BY_SYMBOL: Record<string, string> = Object.fromEntries(COIN_META.map((c) => [c.symbol, c.name]));

/** Liquid majors with reliable Binance/OKX spot pairs — used for single-coin detail. */
export const SIGNAL_WATCHLIST = [
  "BTC", "ETH", "SOL", "BNB", "XRP", "AVAX", "LINK", "DOGE",
  "ADA", "DOT", "LTC", "ATOM", "TRX", "UNI", "NEAR", "INJ",
];

/** Known DEX / DeFi tokens — used to tag and filter the scanner. */
export const DEX_SYMBOLS = new Set([
  "UNI", "SUSHI", "CAKE", "CRV", "BAL", "DYDX", "GMX", "1INCH", "RUNE", "JOE",
  "RAY", "JUP", "AERO", "VELO", "OSMO", "ZRX", "KNC", "LRC", "CETUS", "ORCA",
  "QUICK", "SNX", "PENDLE", "GNS", "DRIFT", "THE", "FXS", "CVX", "VRTX", "JTO",
  "AAVE", "MKR", "COMP", "LDO", "RPL",
]);
export const isDex = (symbol: string) => DEX_SYMBOLS.has(symbol);

/** Stablecoins — excluded from trade signals (they don't trend). */
export const STABLE_SYMBOLS = new Set([
  "USDT", "USDC", "DAI", "USDD", "TUSD", "USDE", "FDUSD", "RLUSD", "PYUSD", "USDP",
  "GUSD", "BUSD", "USDF", "USD1", "USDX", "CRVUSD", "FRAX", "LUSD", "USDB", "USDS",
  "EURT", "EURS", "USTC", "BUIDL", "USDG", "USDY",
]);
export const isStable = (symbol: string) => STABLE_SYMBOLS.has(symbol);

/** Ranking bonus that lightly favors liquid (higher market-cap) coins. */
export const liqBonus = (rank?: number) => (!rank ? 0 : rank <= 30 ? 40 : rank <= 100 ? 25 : rank <= 200 ? 10 : 0);

/** Brand color if known, otherwise a stable hue derived from the symbol. */
export function colorOf(symbol: string): string {
  if (COLOR_BY_SYMBOL[symbol]) return COLOR_BY_SYMBOL[symbol];
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) % 360;
  return `hsl(${h} 68% 62%)`;
}
