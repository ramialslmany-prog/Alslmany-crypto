import "server-only";
import { mapLimit } from "@/lib/utils";
import { loadSentiment, loadStack, loadGlobal, loadMarkets } from "@/lib/market/feed";
import { readMacro } from "@/lib/analysis/macro";
import type { SupplyInput } from "@/lib/analysis/tokenomics";
import type { CoinMarket } from "@/lib/market/types";
import { fetchDerivatives } from "@/lib/market/derivatives";
import { loadLiquidity } from "@/lib/market/liquidity";
import { cached } from "@/lib/market/cache";
import { scanUniverse, type UniverseEntry } from "@/lib/market/universe";
import { closes, correlation } from "@/lib/analysis/indicators";
import { classifyMarket, computeBreadth, type MarketRegime } from "@/lib/analysis/regime";
import type { Candle, Series, Timeframe } from "@/lib/market/types";
import { rankRecommendations, recommend, type Recommendation } from "./recommendation";

/**
 * Market scan.
 *
 * Establishes the market regime first, then analyses each asset inside it.
 * That order is deliberate: an asset's own chart cannot be read honestly
 * without knowing what the tide is doing, and the regime sets the risk budget
 * every individual plan is sized against.
 */

const STACK: Timeframe[] = ["1d", "4h", "1h", "15m"];

/** Public venues rate-limit; six in flight keeps us comfortably inside them. */
const CONCURRENCY = 6;

export type ScanResult = {
  market: MarketRegime;
  recommendations: Recommendation[];
  scannedAt: number;
  scanned: number;
  /** Symbols we could not analyse, and why. */
  skipped: { symbol: string; reason: string }[];
  /** Provenance of the candles behind the scan, so the UI can name it. */
  source: string;
  degraded: boolean;
};

export async function scanMarket(options: {
  maxTier?: 1 | 2 | 3;
  /** Cap the universe, mostly to keep interactive requests responsive. */
  limit?: number;
} = {}): Promise<ScanResult> {
  const maxTier = options.maxTier ?? 2;
  const universe = scanUniverse(maxTier).slice(0, options.limit ?? 60);

  // ── 1. The tide ──
  const [btcStack, sentiment, global, markets] = await Promise.all([
    loadStack("BTC", STACK),
    loadSentiment().catch(() => null),
    loadGlobal().catch(() => null),
    loadMarkets(250).catch(() => null),
  ]);

  const btcAnchor = btcStack["1d"] ?? btcStack["4h"];
  if (!btcAnchor) {
    throw new Error("cannot establish market regime — no Bitcoin series available");
  }

  // ── 2. Every asset's stack, fetched with a concurrency ceiling ──
  const loaded = await mapLimit(universe, CONCURRENCY, async (entry) => {
    try {
      // Derivatives come along for the ride; the order book does not. Depth is
      // a per-asset request that would multiply the scan's call count for
      // information only the accepted candidates end up needing, so it is
      // fetched in the deep dive instead.
      const [stack, derivatives] = await Promise.all([
        loadStack(entry.symbol, STACK),
        cached(`deriv:${entry.symbol}`, 120_000, () => fetchDerivatives(entry.symbol))
          .then((r) => r.value)
          .catch(() => null),
      ]);
      return { entry, stack, derivatives, error: null as string | null };
    } catch (err) {
      return {
        entry,
        stack: {} as Partial<Record<Timeframe, Series | null>>,
        derivatives: null,
        error: err instanceof Error ? err.message : "unavailable",
      };
    }
  });

  // ── 3. Breadth, measured on what we actually loaded ──
  const dailySeries = loaded
    .map((l) => l.stack["1d"]?.candles)
    .filter((c): c is Candle[] => Array.isArray(c) && c.length >= 60);

  const market = classifyMarket({
    btcCandles: btcAnchor.candles,
    breadth: computeBreadth(dailySeries),
    fearGreed: sentiment?.data.value ?? null,
    btcDominance: global?.data.btcDominance ?? null,
  });

  // ── 4. Per-asset recommendations, inside that regime ──
  // Rotation is computed once for the whole scan rather than per asset: it is
  // a property of the market, not of any one coin.
  const macro = markets
    ? readMacro({ markets: markets.data, btcDominance: global?.data.btcDominance ?? null })
    : null;
  // Rows without usable supply figures are dropped rather than stored as
  // null, so a lookup miss and "no supply data" are the same thing.
  const supplyBySymbol = new Map<string, SupplyInput>();
  for (const m of markets?.data ?? []) {
    const supply = toSupply(m);
    if (supply) supplyBySymbol.set(m.symbol, supply);
  }

  const btcDaily = btcStack["1d"]?.candles ?? null;
  const skipped: { symbol: string; reason: string }[] = [];
  const recommendations: Recommendation[] = [];

  for (const { entry, stack, derivatives, error } of loaded) {
    if (error) {
      skipped.push({ symbol: entry.symbol, reason: error });
      continue;
    }
    const own = stack["1d"]?.candles ?? null;
    const btcCorrelation =
      btcDaily && own && entry.symbol !== "BTC"
        ? correlation(closes(own), closes(btcDaily))
        : null;

    const rec = recommend({
      entry, stack, market, btcCorrelation, derivatives,
      supply: supplyBySymbol.get(entry.symbol) ?? null,
      macro,
    });
    if (rec) recommendations.push(rec);
    else skipped.push({ symbol: entry.symbol, reason: "insufficient higher-timeframe data" });
  }

  return {
    market,
    recommendations: rankRecommendations(recommendations),
    scannedAt: Date.now(),
    scanned: loaded.length,
    skipped,
    source: btcAnchor.source,
    degraded:
      btcAnchor.source === "synthetic" ||
      recommendations.some((r) => r.degraded),
  };
}

/** Deep-dive one asset, with the same regime context a scan would give it. */
export async function analyzeSymbol(entry: UniverseEntry): Promise<{
  recommendation: Recommendation | null;
  market: MarketRegime;
}> {
  const [btcStack, ownStack, sentiment, global, derivatives, liquidity, markets] = await Promise.all([
    loadStack("BTC", STACK),
    loadStack(entry.symbol, STACK),
    loadSentiment().catch(() => null),
    loadGlobal().catch(() => null),
    // Both are optional: many assets have no perpetual market, and a blocked
    // depth endpoint must degrade the analysis rather than fail it.
    cached(`deriv:${entry.symbol}`, 120_000, () => fetchDerivatives(entry.symbol))
      .then((r) => r.value)
      .catch(() => null),
    cached(`liquidity:${entry.symbol}`, 45_000, () => loadLiquidity(entry.symbol))
      .then((r) => r.value)
      .catch(() => null),
    loadMarkets(250).catch(() => null),
  ]);

  const btcAnchor = btcStack["1d"] ?? btcStack["4h"];
  if (!btcAnchor) throw new Error("cannot establish market regime");

  const market = classifyMarket({
    btcCandles: btcAnchor.candles,
    // A single-asset view has no breadth of its own to measure.
    breadth: null,
    fearGreed: sentiment?.data.value ?? null,
    btcDominance: global?.data.btcDominance ?? null,
  });

  const btcDaily = btcStack["1d"]?.candles ?? null;
  const own = ownStack["1d"]?.candles ?? null;
  const btcCorrelation =
    btcDaily && own && entry.symbol !== "BTC" ? correlation(closes(own), closes(btcDaily)) : null;

  return {
    recommendation: recommend({
      entry,
      stack: ownStack,
      market,
      btcCorrelation,
      derivatives,
      liquidity,
      supply: markets ? toSupply(markets.data.find((m) => m.symbol === entry.symbol)) : null,
      macro: markets
        ? readMacro({ markets: markets.data, btcDominance: global?.data.btcDominance ?? null })
        : null,
    }),
    market,
  };
}

/**
 * Project a market row onto the supply figures the tokenomics read needs.
 *
 * CoinGecko does not expose max supply on this endpoint, so `maxSupply` is left
 * null and the eventual supply falls back to what has been minted. That
 * understates dilution for a capped token rather than overstating it — the
 * safer direction to be wrong in.
 */
function toSupply(market: CoinMarket | undefined): SupplyInput | null {
  if (!market || !(market.circulating > 0) || !(market.marketCap > 0)) return null;
  return {
    circulating: market.circulating,
    maxSupply: null,
    totalSupply: null,
    marketCap: market.marketCap,
    fullyDiluted: null,
    athChangePct: market.athChangePct,
    rank: market.rank,
  };
}
