/**
 * Fees and slippage.
 *
 * A backtest that fills at the close with no costs is a fiction, and the
 * fiction is always flattering: it turns losing strategies into winning ones
 * and makes every scalp look viable. Two costs are modelled here.
 *
 * FEES are the easy part — a fixed rate on notional.
 *
 * SLIPPAGE is modelled by WALKING THE ORDER BOOK captured at signal time,
 * because that is what actually happens: a market order eats levels until it
 * is filled, and its average price is worse than the top of book by an amount
 * that depends on how deep the book is right there. A flat "assume 5bp"
 * constant would hide exactly the cases that matter — thin books, large
 * positions, volatile moments.
 *
 * When no book is available (a backtest over archived candles), the fallback
 * estimates from the bar's own volume and range, which at least scales with
 * liquidity instead of pretending it is constant.
 */
import type { Candle, OrderBook } from "@/core/types";
import type { OrderSide } from "@/core/execution/types";

export interface CostModel {
  /** Taker fee in basis points. Binance spot standard is 10bp. */
  readonly takerFeeBps: number;
  readonly makerFeeBps: number;
  /** Floor on slippage, so a perfect book does not imply a perfect fill. */
  readonly minSlippageBps: number;
  /** Cap, to keep a pathological book from producing absurd numbers. */
  readonly maxSlippageBps: number;
}

export const DEFAULT_COSTS: CostModel = {
  takerFeeBps: 10,
  makerFeeBps: 10,
  minSlippageBps: 1,
  maxSlippageBps: 300,
};

export interface FillEstimate {
  /** Average price actually achieved. */
  readonly price: number;
  readonly slippage: number;
  readonly slippageBps: number;
  readonly fee: number;
  readonly feeBps: number;
  /** True when the book could not absorb the whole order. */
  readonly partialLiquidity: boolean;
  readonly basis: string;
}

/**
 * Walk the book to fill `quantity`, and report the average price.
 *
 * A buy consumes asks from the best upward; a sell consumes bids downward.
 * If the visible book runs out, the remainder is priced at the last level
 * plus a penalty, and `partialLiquidity` is set so the caller knows the
 * estimate is optimistic.
 */
export function fillFromBook(
  book: OrderBook,
  side: OrderSide,
  quantity: number,
  costs: CostModel = DEFAULT_COSTS,
): FillEstimate {
  const levels = side === "buy" ? book.asks : book.bids;
  const best = levels[0]?.price;

  if (!best || quantity <= 0) {
    return degenerate(best ?? 0, quantity, costs, "دفتر أوامر فارغ");
  }

  let remaining = quantity;
  let cost = 0;
  let lastPrice = best;

  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.quantity);
    cost += take * level.price;
    remaining -= take;
    lastPrice = level.price;
  }

  let partialLiquidity = false;
  if (remaining > 0) {
    // The book was not deep enough. Price the rest worse than the last level
    // rather than pretending it filled there — an optimistic estimate here is
    // exactly the lie that makes illiquid symbols look tradeable.
    partialLiquidity = true;
    const penalty = side === "buy" ? 1.005 : 0.995;
    cost += remaining * lastPrice * penalty;
  }

  const avgPrice = cost / quantity;
  return finalize(avgPrice, best, side, quantity, costs, partialLiquidity,
    `مشي دفتر الأوامر عبر ${levels.length} مستوى${partialLiquidity ? " — العمق لم يكفِ" : ""}`);
}

/**
 * Fallback when no book snapshot exists.
 *
 * Scales with the bar's own participation: a market order worth 5% of a bar's
 * volume moves price far more than one worth 0.05%. The square-root shape is
 * the standard market-impact approximation and is used here because it is at
 * least directionally right, not because it is precise.
 */
export function fillFromLiquidity(
  candle: Candle,
  side: OrderSide,
  quantity: number,
  referencePrice: number,
  costs: CostModel = DEFAULT_COSTS,
): FillEstimate {
  const barNotional = candle.quoteVolume > 0 ? candle.quoteVolume : candle.volume * candle.close;
  const orderNotional = quantity * referencePrice;

  // Participation rate: our size as a fraction of everything that traded.
  const participation = barNotional > 0 ? orderNotional / barNotional : 1;
  // Bar range as a proxy for how jumpy prices are right now.
  const rangeBps = referencePrice > 0 ? ((candle.high - candle.low) / referencePrice) * 10_000 : 20;

  const impactBps = Math.sqrt(Math.max(0, participation)) * rangeBps * 0.5;
  const slippageBps = clamp(impactBps, costs.minSlippageBps, costs.maxSlippageBps);
  const slippage = referencePrice * (slippageBps / 10_000);
  const price = side === "buy" ? referencePrice + slippage : referencePrice - slippage;

  return finalize(price, referencePrice, side, quantity, costs, participation > 0.1,
    `تقدير من سيولة الشمعة: المشاركة ${(participation * 100).toFixed(3)}% من حجمها`);
}

function finalize(
  price: number,
  reference: number,
  side: OrderSide,
  quantity: number,
  costs: CostModel,
  partialLiquidity: boolean,
  basis: string,
): FillEstimate {
  const rawSlippage = side === "buy" ? price - reference : reference - price;
  const boundedBps = clamp(
    reference > 0 ? (rawSlippage / reference) * 10_000 : costs.minSlippageBps,
    costs.minSlippageBps,
    costs.maxSlippageBps,
  );
  const slippage = reference * (boundedBps / 10_000);
  const finalPrice = side === "buy" ? reference + slippage : reference - slippage;

  const notional = finalPrice * quantity;
  const fee = notional * (costs.takerFeeBps / 10_000);

  return {
    price: finalPrice,
    slippage,
    slippageBps: boundedBps,
    fee,
    feeBps: costs.takerFeeBps,
    partialLiquidity,
    basis,
  };
}

function degenerate(price: number, quantity: number, costs: CostModel, basis: string): FillEstimate {
  const slippage = price * (costs.maxSlippageBps / 10_000);
  const notional = price * quantity;
  return {
    price: price + slippage,
    slippage,
    slippageBps: costs.maxSlippageBps,
    fee: notional * (costs.takerFeeBps / 10_000),
    feeBps: costs.takerFeeBps,
    partialLiquidity: true,
    basis,
  };
}

const clamp = (n: number, lo: number, hi: number): number =>
  Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;

/**
 * Total round-trip cost in basis points.
 *
 * Worth computing before a trade: a setup with a 1.8 reward-to-risk where the
 * round trip costs 40bp on a 1.5% stop is a materially worse trade than the
 * headline number suggests.
 */
export function roundTripCostBps(costs: CostModel, estimatedSlippageBps: number): number {
  return (costs.takerFeeBps + estimatedSlippageBps) * 2;
}
