import { NextResponse } from "next/server";
import { loadSettings, saveSettings, sanitizeSettings, storageConfigured, DEFAULT_SETTINGS, type TraderSettings } from "@/lib/store";

/**
 * User-configurable autonomous-trader settings, persisted server-side so the
 * 24/7 cron respects them. GET → current settings; POST → save (values are
 * clamped to safe bounds). When no cloud storage is configured, returns the
 * defaults and reports configured:false (the UI shows a hint).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const configured = storageConfigured();
  const settings = configured ? await loadSettings() : { ...DEFAULT_SETTINGS };
  return NextResponse.json({ configured, settings, defaults: DEFAULT_SETTINGS });
}

export async function POST(req: Request) {
  if (!storageConfigured()) {
    return NextResponse.json({ ok: false, error: "storage-not-configured" }, { status: 200 });
  }
  let body: Partial<TraderSettings>;
  try {
    body = (await req.json()) as Partial<TraderSettings>;
  } catch {
    return NextResponse.json({ ok: false, error: "bad-request" }, { status: 400 });
  }
  const settings = sanitizeSettings(body);
  await saveSettings(settings);
  return NextResponse.json({ ok: true, settings });
}
