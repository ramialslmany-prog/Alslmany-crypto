/**
 * Server-side persistence for the 24/7 trade journal. Pluggable backend:
 *   1) Upstash / Vercel KV  (KV_REST_API_URL + KV_REST_API_TOKEN)   — preferred
 *   2) GitHub Gist          (GITHUB_STORAGE_TOKEN + GIST_ID)         — zero-extra-account fallback
 * Whichever is configured wins. Server-only (no "use client").
 */

export interface JTradeS {
  id: string;
  symbol: string;
  entry: number;
  stop: number;
  targets: number[];
  confidence: number;
  issuedAt: number;
  status: "open" | "tp1" | "tp2" | "tp3" | "breakeven" | "stopped" | "expired";
  hit?: number;
  closedAt?: number;
  exitPrice?: number;
  retPct?: number;
  warned?: boolean;
}

const GIST_FILE = "alslmany-journal.json";

function kvCreds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}
function gistCreds() {
  const token = process.env.GITHUB_STORAGE_TOKEN;
  const id = process.env.GIST_ID;
  return token && id ? { token, id } : null;
}

export function storageConfigured(): boolean {
  return !!(kvCreds() || gistCreds());
}

const KV_KEY = "alslmany:journal";

export async function loadJournal(): Promise<JTradeS[]> {
  const kv = kvCreds();
  if (kv) {
    try {
      const r = await fetch(kv.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
        body: JSON.stringify(["GET", KV_KEY]),
        cache: "no-store",
      });
      const j = (await r.json()) as { result?: unknown };
      if (typeof j.result === "string") return JSON.parse(j.result) as JTradeS[];
    } catch {
      /* fall through */
    }
    return [];
  }
  const g = gistCreds();
  if (g) {
    try {
      const r = await fetch(`https://api.github.com/gists/${g.id}`, {
        headers: { Authorization: `token ${g.token}`, "User-Agent": "alslmany", Accept: "application/vnd.github+json" },
        cache: "no-store",
      });
      const j = (await r.json()) as { files?: Record<string, { content?: string }> };
      const content = j.files?.[GIST_FILE]?.content;
      if (content) return JSON.parse(content) as JTradeS[];
    } catch {
      /* fall through */
    }
    return [];
  }
  return [];
}

/* ---- small meta store (e.g. last-message timestamp for the hourly heartbeat) ---- */
const META_KV_KEY = "alslmany:meta";
const META_GIST_FILE = "alslmany-meta.json";

export async function loadMeta(): Promise<Record<string, number>> {
  const kv = kvCreds();
  if (kv) {
    try {
      const r = await fetch(kv.url, { method: "POST", headers: { Authorization: `Bearer ${kv.token}`, "content-type": "application/json" }, body: JSON.stringify(["GET", META_KV_KEY]), cache: "no-store" });
      const j = (await r.json()) as { result?: unknown };
      if (typeof j.result === "string") return JSON.parse(j.result) as Record<string, number>;
    } catch { /* ignore */ }
    return {};
  }
  const g = gistCreds();
  if (g) {
    try {
      const r = await fetch(`https://api.github.com/gists/${g.id}`, { headers: { Authorization: `token ${g.token}`, "User-Agent": "alslmany", Accept: "application/vnd.github+json" }, cache: "no-store" });
      const j = (await r.json()) as { files?: Record<string, { content?: string }> };
      const content = j.files?.[META_GIST_FILE]?.content;
      if (content) return JSON.parse(content) as Record<string, number>;
    } catch { /* ignore */ }
  }
  return {};
}

export async function saveMeta(meta: Record<string, number>): Promise<void> {
  const data = JSON.stringify(meta);
  const kv = kvCreds();
  if (kv) {
    await fetch(kv.url, { method: "POST", headers: { Authorization: `Bearer ${kv.token}`, "content-type": "application/json" }, body: JSON.stringify(["SET", META_KV_KEY, data]), cache: "no-store" }).catch(() => {});
    return;
  }
  const g = gistCreds();
  if (g) {
    await fetch(`https://api.github.com/gists/${g.id}`, { method: "PATCH", headers: { Authorization: `token ${g.token}`, "User-Agent": "alslmany", "content-type": "application/json", Accept: "application/vnd.github+json" }, body: JSON.stringify({ files: { [META_GIST_FILE]: { content: data } } }) }).catch(() => {});
  }
}

/* ---- user-configurable trader settings (respected by the 24/7 cron) ---- */
export interface TraderSettings {
  maxOpen: number; // 1..5 concurrent positions
  minConfidence: number; // 60..85 confidence bar for new entries
  entriesEnabled: boolean; // master switch for opening new trades (exits always run)
}
export const DEFAULT_SETTINGS: TraderSettings = { maxOpen: 3, minConfidence: 70, entriesEnabled: true };
const SETTINGS_KV_KEY = "alslmany:settings";
const SETTINGS_GIST_FILE = "alslmany-settings.json";
const clampInt = (n: unknown, lo: number, hi: number, d: number) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
};

/** Normalize any partial/untrusted input into safe, bounded settings. */
export function sanitizeSettings(raw: Partial<TraderSettings> | undefined | null): TraderSettings {
  return {
    maxOpen: clampInt(raw?.maxOpen, 1, 5, DEFAULT_SETTINGS.maxOpen),
    minConfidence: clampInt(raw?.minConfidence, 60, 85, DEFAULT_SETTINGS.minConfidence),
    entriesEnabled: raw?.entriesEnabled === undefined ? DEFAULT_SETTINGS.entriesEnabled : !!raw.entriesEnabled,
  };
}

export async function loadSettings(): Promise<TraderSettings> {
  const kv = kvCreds();
  if (kv) {
    try {
      const r = await fetch(kv.url, { method: "POST", headers: { Authorization: `Bearer ${kv.token}`, "content-type": "application/json" }, body: JSON.stringify(["GET", SETTINGS_KV_KEY]), cache: "no-store" });
      const j = (await r.json()) as { result?: unknown };
      if (typeof j.result === "string") return sanitizeSettings(JSON.parse(j.result));
    } catch { /* ignore */ }
    return { ...DEFAULT_SETTINGS };
  }
  const g = gistCreds();
  if (g) {
    try {
      const r = await fetch(`https://api.github.com/gists/${g.id}`, { headers: { Authorization: `token ${g.token}`, "User-Agent": "alslmany", Accept: "application/vnd.github+json" }, cache: "no-store" });
      const j = (await r.json()) as { files?: Record<string, { content?: string }> };
      const content = j.files?.[SETTINGS_GIST_FILE]?.content;
      if (content) return sanitizeSettings(JSON.parse(content));
    } catch { /* ignore */ }
  }
  return { ...DEFAULT_SETTINGS };
}

export async function saveSettings(settings: TraderSettings): Promise<void> {
  const data = JSON.stringify(sanitizeSettings(settings));
  const kv = kvCreds();
  if (kv) {
    await fetch(kv.url, { method: "POST", headers: { Authorization: `Bearer ${kv.token}`, "content-type": "application/json" }, body: JSON.stringify(["SET", SETTINGS_KV_KEY, data]), cache: "no-store" }).catch(() => {});
    return;
  }
  const g = gistCreds();
  if (g) {
    await fetch(`https://api.github.com/gists/${g.id}`, { method: "PATCH", headers: { Authorization: `token ${g.token}`, "User-Agent": "alslmany", "content-type": "application/json", Accept: "application/vnd.github+json" }, body: JSON.stringify({ files: { [SETTINGS_GIST_FILE]: { content: data } } }) }).catch(() => {});
  }
}

export async function saveJournal(journal: JTradeS[]): Promise<void> {
  const data = JSON.stringify(journal.slice(0, 80));
  const kv = kvCreds();
  if (kv) {
    await fetch(kv.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
      body: JSON.stringify(["SET", KV_KEY, data]),
      cache: "no-store",
    }).catch(() => {});
    return;
  }
  const g = gistCreds();
  if (g) {
    await fetch(`https://api.github.com/gists/${g.id}`, {
      method: "PATCH",
      headers: { Authorization: `token ${g.token}`, "User-Agent": "alslmany", "content-type": "application/json", Accept: "application/vnd.github+json" },
      body: JSON.stringify({ files: { [GIST_FILE]: { content: data } } }),
    }).catch(() => {});
  }
}
