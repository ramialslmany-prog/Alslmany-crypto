/**
 * The tradable universe.
 *
 * Static metadata for the assets we are willing to publish recommendations on.
 * Everything here has a deep USDT spot book across at least two of our venues,
 * which is what makes a stop-loss meaningful in the first place. Illiquid
 * listings are excluded on purpose: a signal you cannot exit is not a signal.
 */

export type UniverseEntry = {
  /** Base symbol, e.g. "BTC". */
  symbol: string;
  /** CoinGecko id, for metadata joins. */
  id: string;
  name: string;
  nameAr: string;
  /** Broad sector, used for correlation and concentration checks. */
  sector: Sector;
  /** Majors get looser filters; small caps need more evidence to qualify. */
  tier: 1 | 2 | 3;
};

export type Sector =
  | "store-of-value"
  | "smart-contract"
  | "defi"
  | "infrastructure"
  | "exchange"
  | "payments"
  | "gaming"
  | "meme"
  | "ai";

export const UNIVERSE: UniverseEntry[] = [
  { symbol: "BTC", id: "bitcoin", name: "Bitcoin", nameAr: "بيتكوين", sector: "store-of-value", tier: 1 },
  { symbol: "ETH", id: "ethereum", name: "Ethereum", nameAr: "إيثيريوم", sector: "smart-contract", tier: 1 },
  { symbol: "SOL", id: "solana", name: "Solana", nameAr: "سولانا", sector: "smart-contract", tier: 1 },
  { symbol: "BNB", id: "binancecoin", name: "BNB", nameAr: "بي إن بي", sector: "exchange", tier: 1 },
  { symbol: "XRP", id: "ripple", name: "XRP", nameAr: "ريبل", sector: "payments", tier: 1 },
  { symbol: "ADA", id: "cardano", name: "Cardano", nameAr: "كاردانو", sector: "smart-contract", tier: 1 },
  { symbol: "AVAX", id: "avalanche-2", name: "Avalanche", nameAr: "أفالانش", sector: "smart-contract", tier: 1 },
  { symbol: "DOGE", id: "dogecoin", name: "Dogecoin", nameAr: "دوجكوين", sector: "meme", tier: 1 },
  { symbol: "TRX", id: "tron", name: "TRON", nameAr: "ترون", sector: "smart-contract", tier: 1 },
  { symbol: "LINK", id: "chainlink", name: "Chainlink", nameAr: "تشين لينك", sector: "infrastructure", tier: 1 },
  { symbol: "DOT", id: "polkadot", name: "Polkadot", nameAr: "بولكادوت", sector: "infrastructure", tier: 2 },
  { symbol: "MATIC", id: "matic-network", name: "Polygon", nameAr: "بوليجون", sector: "infrastructure", tier: 2 },
  { symbol: "LTC", id: "litecoin", name: "Litecoin", nameAr: "لايتكوين", sector: "payments", tier: 2 },
  { symbol: "BCH", id: "bitcoin-cash", name: "Bitcoin Cash", nameAr: "بيتكوين كاش", sector: "payments", tier: 2 },
  { symbol: "NEAR", id: "near", name: "NEAR Protocol", nameAr: "نير", sector: "smart-contract", tier: 2 },
  { symbol: "UNI", id: "uniswap", name: "Uniswap", nameAr: "يوني سواب", sector: "defi", tier: 2 },
  { symbol: "ATOM", id: "cosmos", name: "Cosmos", nameAr: "كوزموس", sector: "infrastructure", tier: 2 },
  { symbol: "APT", id: "aptos", name: "Aptos", nameAr: "أبتوس", sector: "smart-contract", tier: 2 },
  { symbol: "ARB", id: "arbitrum", name: "Arbitrum", nameAr: "أربيتروم", sector: "infrastructure", tier: 2 },
  { symbol: "OP", id: "optimism", name: "Optimism", nameAr: "أوبتيمزم", sector: "infrastructure", tier: 2 },
  { symbol: "FIL", id: "filecoin", name: "Filecoin", nameAr: "فايل كوين", sector: "infrastructure", tier: 2 },
  { symbol: "INJ", id: "injective-protocol", name: "Injective", nameAr: "إنجكتف", sector: "defi", tier: 2 },
  { symbol: "SUI", id: "sui", name: "Sui", nameAr: "سوي", sector: "smart-contract", tier: 2 },
  { symbol: "TIA", id: "celestia", name: "Celestia", nameAr: "سيليستيا", sector: "infrastructure", tier: 2 },
  { symbol: "SEI", id: "sei-network", name: "Sei", nameAr: "ساي", sector: "smart-contract", tier: 3 },
  { symbol: "AAVE", id: "aave", name: "Aave", nameAr: "آفي", sector: "defi", tier: 2 },
  { symbol: "MKR", id: "maker", name: "Maker", nameAr: "ميكر", sector: "defi", tier: 2 },
  { symbol: "RUNE", id: "thorchain", name: "THORChain", nameAr: "ثورتشين", sector: "defi", tier: 3 },
  { symbol: "LDO", id: "lido-dao", name: "Lido DAO", nameAr: "ليدو", sector: "defi", tier: 3 },
  { symbol: "CRV", id: "curve-dao-token", name: "Curve", nameAr: "كيرف", sector: "defi", tier: 3 },
  { symbol: "ALGO", id: "algorand", name: "Algorand", nameAr: "ألجوراند", sector: "smart-contract", tier: 3 },
  { symbol: "VET", id: "vechain", name: "VeChain", nameAr: "في تشين", sector: "infrastructure", tier: 3 },
  { symbol: "ICP", id: "internet-computer", name: "Internet Computer", nameAr: "إنترنت كمبيوتر", sector: "infrastructure", tier: 3 },
  { symbol: "HBAR", id: "hedera-hashgraph", name: "Hedera", nameAr: "هيديرا", sector: "infrastructure", tier: 3 },
  { symbol: "ETC", id: "ethereum-classic", name: "Ethereum Classic", nameAr: "إيثيريوم كلاسيك", sector: "smart-contract", tier: 3 },
  { symbol: "XLM", id: "stellar", name: "Stellar", nameAr: "ستيلر", sector: "payments", tier: 3 },
  { symbol: "FTM", id: "fantom", name: "Fantom", nameAr: "فانتوم", sector: "smart-contract", tier: 3 },
  { symbol: "GRT", id: "the-graph", name: "The Graph", nameAr: "ذا جراف", sector: "infrastructure", tier: 3 },
  { symbol: "IMX", id: "immutable-x", name: "Immutable", nameAr: "إميوتابل", sector: "gaming", tier: 3 },
  { symbol: "SAND", id: "the-sandbox", name: "The Sandbox", nameAr: "ساندبوكس", sector: "gaming", tier: 3 },
  { symbol: "AXS", id: "axie-infinity", name: "Axie Infinity", nameAr: "آكسي", sector: "gaming", tier: 3 },
  { symbol: "RENDER", id: "render-token", name: "Render", nameAr: "ريندر", sector: "ai", tier: 3 },
  { symbol: "FET", id: "fetch-ai", name: "Artificial Superintelligence", nameAr: "فيتش", sector: "ai", tier: 3 },
  { symbol: "SHIB", id: "shiba-inu", name: "Shiba Inu", nameAr: "شيبا إينو", sector: "meme", tier: 3 },
  { symbol: "PEPE", id: "pepe", name: "Pepe", nameAr: "بيبي", sector: "meme", tier: 3 },
  { symbol: "WIF", id: "dogwifcoin", name: "dogwifhat", nameAr: "دوج ويف هات", sector: "meme", tier: 3 },
];

const BY_SYMBOL = new Map(UNIVERSE.map((u) => [u.symbol, u]));
const BY_ID = new Map(UNIVERSE.map((u) => [u.id, u]));

export function lookupSymbol(symbol: string): UniverseEntry | undefined {
  return BY_SYMBOL.get(symbol.toUpperCase());
}

export function lookupId(id: string): UniverseEntry | undefined {
  return BY_ID.get(id);
}

export function isTracked(symbol: string): boolean {
  return BY_SYMBOL.has(symbol.toUpperCase());
}

/** Scan universe, widest first — tier 1 and 2 carry the recommendation load. */
export function scanUniverse(maxTier: 1 | 2 | 3 = 3): UniverseEntry[] {
  return UNIVERSE.filter((u) => u.tier <= maxTier);
}

/** Localised display name. */
export function displayName(entry: UniverseEntry, lang: "ar" | "en"): string {
  return lang === "ar" ? entry.nameAr : entry.name;
}

/** Stablecoins and wrapped assets never produce a directional signal. */
const EXCLUDED = new Set([
  "USDT", "USDC", "DAI", "BUSD", "TUSD", "FDUSD", "USDD", "PYUSD",
  "WBTC", "WETH", "STETH", "WSTETH", "WBETH", "CBBTC",
]);

export function isSignalEligible(symbol: string): boolean {
  return !EXCLUDED.has(symbol.toUpperCase());
}
