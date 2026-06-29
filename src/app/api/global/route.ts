import { NextResponse } from "next/server";

/**
 * Global market stats (CoinGecko /global): total market cap, 24h volume,
 * BTC + ETH dominance, and the 24h market-cap change. Cached 60s.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/global", {
      headers: { accept: "application/json" },
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as {
      data?: {
        total_market_cap?: { usd?: number };
        total_volume?: { usd?: number };
        market_cap_percentage?: { btc?: number; eth?: number };
        market_cap_change_percentage_24h_usd?: number;
      };
    };
    const d = j.data ?? {};
    return NextResponse.json({
      source: "coingecko",
      totalMcap: d.total_market_cap?.usd ?? 0,
      totalVol: d.total_volume?.usd ?? 0,
      btcDominance: d.market_cap_percentage?.btc ?? 0,
      ethDominance: d.market_cap_percentage?.eth ?? 0,
      mcapChange24h: d.market_cap_change_percentage_24h_usd ?? 0,
    });
  } catch (err) {
    return NextResponse.json({ source: "unavailable", error: (err as Error).message, totalMcap: 0, totalVol: 0, btcDominance: 0, ethDominance: 0, mcapChange24h: 0 });
  }
}
