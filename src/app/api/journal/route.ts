import { NextResponse } from "next/server";

/**
 * Read-only view of the server-side (24/7) trade journal stored in Upstash/KV.
 * The AI Trader page reads this so it shows exactly what the cloud loop is doing.
 * `serverActive` tells the client whether the 24/7 brain is configured — when it
 * is, the in-app watcher goes silent to avoid duplicate Telegram alerts.
 */
export const dynamic = "force-dynamic";

const KEY = "alslmany:journal";

function kvCreds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

export async function GET() {
  const c = kvCreds();
  if (!c) return NextResponse.json({ serverActive: false, trades: [] });
  try {
    const r = await fetch(c.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}`, "content-type": "application/json" },
      body: JSON.stringify(["GET", KEY]),
      cache: "no-store",
    });
    const j = (await r.json()) as { result?: unknown };
    const trades = typeof j.result === "string" ? JSON.parse(j.result) : [];
    return NextResponse.json({ serverActive: true, trades }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ serverActive: true, trades: [] });
  }
}
