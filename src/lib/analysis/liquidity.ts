/**
 * Order-book mathematics.
 *
 * Pure and dependency-free, so it can be exercised in tests and reused on the
 * client. Fetching lives in `@/lib/market/liquidity`; nothing here touches the
 * network.
 *
 * A stop-loss is a promise about the maximum you will lose, and that promise is
 * only as good as the liquidity standing at that price. A stop on a thin book
 * does not fill where it was set — it eats through the bids and fills lower.
 * That gap between the loss you planned and the loss you take is invisible on
 * any chart, and it is where "a small loss" quietly becomes a large one.
 *
 * So this module answers the question a chart cannot: if I had to get out of
 * this size right now, what would it actually cost me?
 */

export type BookLevel = { price: number; quantity: number };

export type OrderBook = {
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
  fetchedAt: number;
};

export type SlippageEstimate = {
  /** Notional the estimate was computed for, in quote currency. */
  notional: number;
  /** Volume-weighted fill price after walking the book. */
  averagePrice: number;
  /** Best available price before walking. */
  bestPrice: number;
  /** Cost of the walk, as a percentage of the best price. */
  slippagePct: number;
  /** True when the visible book could not absorb the whole order. */
  exceedsBook: boolean;
  /** Notional actually fillable from the visible book. */
  fillableNotional: number;
};

/**
 * Walk one side of the book to fill a notional amount.
 * Selling walks the bids, buying walks the asks.
 */
export function estimateSlippage(
  book: OrderBook,
  notional: number,
  side: "buy" | "sell",
): SlippageEstimate {
  const levels = side === "sell" ? book.bids : book.asks;
  const best = levels[0]?.price ?? 0;

  if (!(best > 0) || !(notional > 0)) {
    return {
      notional,
      averagePrice: best,
      bestPrice: best,
      slippagePct: 0,
      exceedsBook: true,
      fillableNotional: 0,
    };
  }

  let remaining = notional;
  let spent = 0;
  let units = 0;

  for (const level of levels) {
    const levelNotional = level.price * level.quantity;
    const take = Math.min(remaining, levelNotional);
    const takenUnits = take / level.price;
    spent += take;
    units += takenUnits;
    remaining -= take;
    if (remaining <= 0) break;
  }

  const exceedsBook = remaining > 0;
  const averagePrice = units > 0 ? spent / units : best;
  // Slippage is always expressed as a cost, whichever side we are on.
  const slippagePct =
    side === "sell"
      ? ((best - averagePrice) / best) * 100
      : ((averagePrice - best) / best) * 100;

  return {
    notional,
    averagePrice,
    bestPrice: best,
    slippagePct: Math.max(0, slippagePct),
    exceedsBook,
    fillableNotional: spent,
  };
}

export type LiquidityRead = {
  symbol: string;
  /** Best bid/ask spread as a percentage. */
  spreadPct: number;
  /** Quote-currency depth within 1% of mid, both sides summed. */
  depth1PctNotional: number;
  depth2PctNotional: number;
  /** Slippage exiting a $1,000 position — the retail reference size. */
  exit1k: SlippageEstimate;
  exit10k: SlippageEstimate;
  /** 0–100. Below 40, a stop here should not be trusted to fill near its price. */
  score: number;
  fetchedAt: number;
};

function depthWithin(levels: BookLevel[], mid: number, pct: number): number {
  const bound = mid * (pct / 100);
  return levels
    .filter((l) => Math.abs(l.price - mid) <= bound)
    .reduce((sum, l) => sum + l.price * l.quantity, 0);
}

export function readLiquidity(book: OrderBook): LiquidityRead {
  const bestBid = book.bids[0]?.price ?? 0;
  const bestAsk = book.asks[0]?.price ?? 0;
  const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
  const spreadPct = mid > 0 && bestAsk > 0 && bestBid > 0 ? ((bestAsk - bestBid) / mid) * 100 : 100;

  const depth1 = depthWithin(book.bids, mid, 1) + depthWithin(book.asks, mid, 1);
  const depth2 = depthWithin(book.bids, mid, 2) + depthWithin(book.asks, mid, 2);

  const exit1k = estimateSlippage(book, 1_000, "sell");
  const exit10k = estimateSlippage(book, 10_000, "sell");

  // Score blends the three things that decide whether a stop is honest: a tight
  // spread, real depth near mid, and a cheap exit at a realistic size.
  const spreadScore = Math.max(0, 100 - spreadPct * 500);
  const depthScore = Math.min(100, (depth1 / 250_000) * 100);
  const exitScore = Math.max(0, 100 - exit10k.slippagePct * 120);
  const score = Math.round(spreadScore * 0.25 + depthScore * 0.4 + exitScore * 0.35);

  return {
    symbol: book.symbol,
    spreadPct,
    depth1PctNotional: depth1,
    depth2PctNotional: depth2,
    exit1k,
    exit10k,
    score: Math.max(0, Math.min(100, score)),
    fetchedAt: book.fetchedAt,
  };
}
