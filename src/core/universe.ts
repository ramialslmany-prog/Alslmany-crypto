/**
 * Which symbols are worth analysing at all.
 *
 * Ranking by 24-hour quote volume is the right ordering — it reflects real
 * tradability rather than market cap or reputation — but the raw ranking is
 * not a universe. Two kinds of pair sit at the very top of it and neither can
 * be traded by anything in this system:
 *
 *  - STABLECOIN PAIRS. USDC/USDT turns over billions a day and moves a
 *    fraction of a percent a year. It has no trend, no structure and no
 *    levels; the analysis would burn on it and find nothing, forever. It was
 *    literally rank 1 the first time this ran.
 *  - LEVERAGED TOKENS. BTCUP, ETHDOWN and friends are derivatives with decay
 *    built in. Their chart is not the underlying's chart, and reading it as
 *    one produces confident nonsense.
 *
 * Excluding them is not an opinion about their value. It is the same rule as
 * everywhere else here: analyse only what the system can actually act on.
 */

/** Stable-value assets. A pair of two of these has nothing to analyse. */
const STABLES = new Set([
  "USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI", "USDP", "UST", "USDD",
  "PYUSD", "EURI", "AEUR", "USD1", "XUSD", "SUSD",
]);

/**
 * Leveraged-token suffixes.
 *
 * Each requires at least three characters of a real base in front of it. The
 * first version did not, and quietly excluded JUP — a perfectly ordinary coin
 * whose ticker happens to end in "UP". A filter that removes real assets is a
 * worse failure than one that lets an odd pair through, because the loss is
 * invisible: nobody notices the coin that was never analysed.
 */
const LEVERAGED = [
  /^.{3,}(UP|DOWN)$/,
  /^.{3,}(BULL|BEAR)$/,
  /^.{2,}[35][LS]$/,
];

export interface UniverseCandidate {
  readonly symbol: string;
  readonly quoteVolume: number;
}

export function baseOf(symbol: string, quote: string): string {
  return symbol.endsWith(quote) ? symbol.slice(0, -quote.length) : symbol;
}

/** True when this pair cannot produce a tradable analysis, whatever its volume. */
export function isUntradablePair(symbol: string, quote: string): boolean {
  const base = baseOf(symbol, quote);
  if (base.length === 0) return true;
  if (STABLES.has(base)) return true;
  return LEVERAGED.some((re) => re.test(base));
}

/**
 * Rank and cut.
 *
 * The exclusions happen BEFORE the cut, so asking for the top 100 gives 100
 * tradable coins rather than 100 rows of which the first handful are
 * stablecoin pairs nobody can trade.
 */
export function selectUniverse(
  candidates: readonly UniverseCandidate[],
  quote: string,
  limit: number,
): { symbols: string[]; excluded: string[] } {
  const excluded: string[] = [];
  const kept: UniverseCandidate[] = [];

  for (const c of candidates) {
    if (!c.symbol.endsWith(quote) || !Number.isFinite(c.quoteVolume)) continue;
    if (isUntradablePair(c.symbol, quote)) {
      excluded.push(c.symbol);
      continue;
    }
    kept.push(c);
  }

  kept.sort((a, b) => b.quoteVolume - a.quoteVolume);
  return { symbols: kept.slice(0, limit).map((c) => c.symbol), excluded };
}
