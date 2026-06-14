import { NextResponse } from "next/server";
import { fetchCandles } from "@/lib/candles";
import { analyzeTimeframe, buildRecommendation, STYLE_TF, type Style, type Market } from "@/lib/signal-engine";

export const dynamic = "force-dynamic";

const VALID_STYLES: Style[] = ["scalp", "day", "swing"];

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") ?? "BTC").toUpperCase();
  const style = (searchParams.get("style") ?? "day") as Style;
  const s = VALID_STYLES.includes(style) ? style : "day";
  const market: Market = searchParams.get("market") === "futures" ? "futures" : "spot";

  const { ltf, htf } = STYLE_TF[s];

  // Fetch both timeframes in parallel (klines aren't CoinGecko-rate-limited).
  const [ltfRes, htfRes] = await Promise.all([fetchCandles(symbol, ltf, 220), fetchCandles(symbol, htf, 220)]);

  const ltfAnalysis = analyzeTimeframe(ltf, ltfRes.candles);
  const htfAnalysis = analyzeTimeframe(htf, htfRes.candles);
  const rec = buildRecommendation(symbol, s, ltfAnalysis, htfAnalysis, ltfRes.source, market);

  return NextResponse.json(rec, { headers: { "cache-control": "no-store" } });
}
