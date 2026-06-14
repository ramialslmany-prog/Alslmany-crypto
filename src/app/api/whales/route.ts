import { NextResponse } from "next/server";

/**
 * Real whale feed — large single prints from Binance aggregated trades.
 * For each major we pull recent aggTrades and keep the prints whose USD value
 * clears a per-coin threshold. `m` (buyer-is-maker) tells aggressor side:
 *   m === false → taker BOUGHT  → accumulation (green)
 *   m === true  → taker SOLD    → distribution (red)
 * No keys, no mock — if Binance is unreachable we say so honestly.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

const WATCH: { sym: string; min: number }[] = [
  { sym: "BTC", min: 250_000 },
  { sym: "ETH", min: 150_000 },
  { sym: "SOL", min: 100_000 },
  { sym: "BNB", min: 100_000 },
  { sym: "XRP", min: 80_000 },
  { sym: "DOGE", min: 60_000 },
];

interface AggTrade {
  p: string;
  q: string;
  T: number;
  m: boolean;
}
export interface WhaleTrade {
  id: string;
  symbol: string;
  side: "accumulation" | "distribution";
  price: number;
  amountUsd: number;
  ts: number;
}

async function pull(sym: string, min: number): Promise<WhaleTrade[]> {
  const url = `https://api.binance.com/api/v3/aggTrades?symbol=${sym}USDT&limit=1000`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3500);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", headers: { accept: "application/json" } });
    if (!res.ok) return [];
    const raw = (await res.json()) as AggTrade[];
    const out: WhaleTrade[] = [];
    for (const tr of raw) {
      const price = parseFloat(tr.p);
      const usd = price * parseFloat(tr.q);
      if (usd >= min) {
        out.push({
          id: `${sym}-${tr.T}-${tr.p}-${tr.q}`,
          symbol: sym,
          side: tr.m ? "distribution" : "accumulation",
          price,
          amountUsd: usd,
          ts: tr.T,
        });
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const batches = await Promise.all(WATCH.map((w) => pull(w.sym, w.min)));
  const all = batches.flat().sort((a, b) => b.ts - a.ts).slice(0, 40);
  const live = all.length > 0;
  const buy = all.filter((t) => t.side === "accumulation").reduce((s, t) => s + t.amountUsd, 0);
  const sell = all.filter((t) => t.side === "distribution").reduce((s, t) => s + t.amountUsd, 0);
  return NextResponse.json(
    { source: live ? "binance" : "unavailable", updatedAt: Date.now(), trades: all, netBuyUsd: buy, netSellUsd: sell },
    { headers: { "cache-control": "no-store" } }
  );
}
