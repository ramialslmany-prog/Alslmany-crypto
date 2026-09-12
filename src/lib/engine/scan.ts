import "server-only";
import { mapLimit } from "@/lib/utils";
import { loadSentiment, loadStack, loadGlobal } from "@/lib/market/feed";
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
  const [btcStack, sentiment, global] = await Promise.all([
    loadStack("BTC", STACK),
    loadSentiment().catch(() => null),
    loadGlobal().catch(() => null),
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

    const rec = recommend({ entry, stack, market, btcCorrelation, derivatives });
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
  const [btcStack, ownStack, sentiment, global, derivatives, liquidity] = await Promise.all([
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
    }),
    market,
  };
}
