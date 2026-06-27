import { NextResponse } from "next/server";
import { storageConfigured, loadJournal } from "@/lib/store";

/**
 * Read-only view of the server-side (24/7) trade journal.
 * `serverActive` tells the client whether the cloud brain is configured — when
 * it is, the in-app watcher stays silent to avoid duplicate Telegram alerts.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  if (!storageConfigured()) return NextResponse.json({ serverActive: false, trades: [] });
  const trades = await loadJournal();
  return NextResponse.json({ serverActive: true, trades }, { headers: { "cache-control": "no-store" } });
}
