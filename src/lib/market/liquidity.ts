import "server-only";
import { z } from "zod";
import { fetchJson } from "./http";
import { toPair } from "./exchanges";
import { readLiquidity, type OrderBook, type LiquidityRead } from "@/lib/analysis/liquidity";

/**
 * Fetching the order book.
 *
 * The maths that interprets it lives in `@/lib/analysis/liquidity` so it stays
 * pure and testable; this module is only the network boundary.
 */

const BINANCE = "https://api.binance.com";

const DepthSchema = z.object({
  bids: z.array(z.tuple([z.string(), z.string()]).rest(z.string())),
  asks: z.array(z.tuple([z.string(), z.string()]).rest(z.string())),
});

export async function fetchOrderBook(symbol: string, limit = 500): Promise<OrderBook> {
  const pair = toPair(symbol);
  const raw = DepthSchema.parse(
    await fetchJson(`${BINANCE}/api/v3/depth?symbol=${pair}&limit=${limit}`),
  );

  const toLevels = (rows: string[][]) =>
    rows
      .map((r) => ({ price: Number(r[0]), quantity: Number(r[1]) }))
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.quantity) && l.quantity > 0);

  return {
    symbol: symbol.toUpperCase(),
    bids: toLevels(raw.bids),
    asks: toLevels(raw.asks),
    fetchedAt: Date.now(),
  };
}

export async function loadLiquidity(symbol: string): Promise<LiquidityRead> {
  return readLiquidity(await fetchOrderBook(symbol));
}

export type { OrderBook, LiquidityRead };
