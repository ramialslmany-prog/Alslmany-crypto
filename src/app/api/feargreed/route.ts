import { NextResponse } from "next/server";

// The real Crypto Fear & Greed Index (alternative.me, free, no key). Updates daily.
export const revalidate = 600;

export async function GET() {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", {
      next: { revalidate: 600 },
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`fng ${res.status}`);
    const json = (await res.json()) as { data?: { value: string; value_classification: string }[] };
    const d = json.data?.[0];
    if (!d) throw new Error("no data");
    return NextResponse.json({
      value: Number(d.value),
      classification: d.value_classification,
      source: "alternative.me",
    });
  } catch {
    // Honest fallback — clearly not live.
    return NextResponse.json({ value: 50, classification: "Neutral", source: "fallback" });
  }
}
