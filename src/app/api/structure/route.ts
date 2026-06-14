import { NextResponse } from "next/server";
import { fetchCandles, type Interval } from "@/lib/candles";
import { analyzeTimeframe } from "@/lib/signal-engine";
import { swings, last } from "@/lib/indicators";

/**
 * Smart-money market-structure board. For each major we read real klines and
 * derive: dominant trend (EMA stack), market structure (BOS / CHoCH), momentum,
 * the nearest swing support/resistance, fair-value gap, and volume conviction.
 * All deterministic from candles — the "smart money" lens (ICT/SMC), no mock.
 */
export const dynamic = "force-dynamic";

const MAJORS = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "LINK", "DOT"];
const TF: Record<string, Interval> = { day: "1h", swing: "4h", macro: "1d" };

export interface StructureRow {
  symbol: string;
  price: number;
  trend: "up" | "down" | "range";
  structure: string;
  bias: "bullish" | "bearish" | "neutral";
  rsi: number;
  support: number;
  resistance: number;
  fvg: "bull" | "bear" | null;
  volRatio: number;
  source: string;
}

async function analyzeOne(symbol: string, interval: Interval): Promise<StructureRow | null> {
  try {
    const { candles, source } = await fetchCandles(symbol, interval, 200);
    if (candles.length < 60) return null;
    const a = analyzeTimeframe(interval, candles);
    const sw = swings(candles, 2);
    const price = a.close;
    const resistance = sw.highs.length ? last(sw.highs).price : Math.max(...candles.slice(-20).map((c) => c.h));
    const support = sw.lows.length ? last(sw.lows).price : Math.min(...candles.slice(-20).map((c) => c.l));
    return {
      symbol,
      price,
      trend: a.trend,
      structure: a.structure,
      bias: a.bias > 0.6 ? "bullish" : a.bias < -0.6 ? "bearish" : "neutral",
      rsi: a.rsi,
      support,
      resistance,
      fvg: a.fvg,
      volRatio: a.volRatio,
      source,
    };
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const tfKey = searchParams.get("tf") ?? "swing";
  const interval = TF[tfKey] ?? "4h";
  const rows = (await Promise.all(MAJORS.map((s) => analyzeOne(s, interval)))).filter(Boolean) as StructureRow[];
  const bullish = rows.filter((r) => r.bias === "bullish").length;
  const bearish = rows.filter((r) => r.bias === "bearish").length;
  return NextResponse.json(
    { interval, updatedAt: Date.now(), rows, bullish, bearish, neutral: rows.length - bullish - bearish },
    { headers: { "cache-control": "no-store" } }
  );
}
