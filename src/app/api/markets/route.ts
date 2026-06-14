import { NextResponse } from "next/server";
import { fetchMarkets } from "@/lib/coingecko";
import { coins as mockCoins } from "@/lib/mock-data";

// Revalidate the shared server cache every 30s (respects CoinGecko free tier).
export const revalidate = 30;

export async function GET() {
  try {
    const coins = await fetchMarkets();
    return NextResponse.json({ source: "coingecko", updatedAt: Date.now(), coins });
  } catch (err) {
    // Graceful degradation — the UI keeps working on the seeded snapshot.
    console.warn("[api/markets] falling back to mock:", (err as Error).message);
    return NextResponse.json({ source: "mock", updatedAt: Date.now(), coins: mockCoins });
  }
}
