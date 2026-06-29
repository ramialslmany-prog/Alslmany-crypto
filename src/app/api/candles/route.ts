import { NextResponse } from "next/server";
import { fetchCandles, type Interval } from "@/lib/candles";

/**
 * Real OHLCV candles for the client candlestick chart. Proxies the multi-venue
 * fetcher (Binance → OKX → Bybit → synthetic) so keys/CORS stay server-side.
 */
export const dynamic = "force-dynamic";

const VALID: Interval[] = ["15m", "1h", "4h", "1d"];

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") ?? "BTC").toUpperCase();
  const ivParam = searchParams.get("interval") as Interval | null;
  const interval: Interval = ivParam && VALID.includes(ivParam) ? ivParam : "1h";
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "180", 10) || 180, 30), 500);

  const { source, candles } = await fetchCandles(symbol, interval, limit);
  return NextResponse.json(
    { symbol, interval, source, candles },
    { headers: { "cache-control": "no-store" } }
  );
}
