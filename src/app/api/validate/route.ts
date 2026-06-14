import { NextResponse } from "next/server";
import { fetchAllTickers } from "@/lib/exchanges";
import { validate } from "@/lib/validation";

// Always fresh — this is a real-time integrity check, not cacheable content.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") ?? "BTC").toUpperCase();

  const sources = await fetchAllTickers(symbol);
  const result = validate(symbol, sources);

  return NextResponse.json(result, {
    headers: { "cache-control": "no-store" },
  });
}
