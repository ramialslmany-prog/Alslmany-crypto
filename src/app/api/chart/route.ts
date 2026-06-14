import { NextResponse } from "next/server";
import { fetchChart, fetchMarkets, ID_BY_SYMBOL } from "@/lib/coingecko";
import { coins as mockCoins } from "@/lib/mock-data";

export const revalidate = 60;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") ?? "BTC").toUpperCase();
  const days = Number(searchParams.get("days") ?? "1");
  const id = ID_BY_SYMBOL[symbol] ?? "bitcoin";

  // Primary: high-resolution market_chart for the requested timeframe.
  try {
    const prices = await fetchChart(id, days);
    return NextResponse.json({ source: "coingecko", symbol, days, prices });
  } catch (err) {
    console.warn("[api/chart] market_chart failed:", (err as Error).message);
  }

  // Fallback 1: the live 7d sparkline from the cached markets snapshot.
  // Still real data — just coarser — and shares the markets cache (no extra
  // rate-limit pressure). Far better than serving mock.
  try {
    const markets = await fetchMarkets();
    const coin = markets.find((c) => c.symbol === symbol);
    if (coin?.spark?.length) {
      return NextResponse.json({ source: "coingecko-spark", symbol, days, prices: coin.spark });
    }
  } catch (err) {
    console.warn("[api/chart] markets fallback failed:", (err as Error).message);
  }

  // Fallback 2: seeded mock — the UI always renders something.
  const fallback = mockCoins.find((c) => c.symbol === symbol)?.spark ?? mockCoins[0].spark;
  return NextResponse.json({ source: "mock", symbol, days, prices: fallback });
}
