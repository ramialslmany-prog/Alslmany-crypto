/**
 * Presentation helpers. Every figure the user sees passes through here so
 * precision rules stay consistent across the whole product.
 */

/** Crypto prices span 5 orders of magnitude — pick decimals from the value. */
export function fmtPrice(n: number | null | undefined, currency = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  let decimals: number;
  if (abs >= 1000) decimals = 2;
  else if (abs >= 100) decimals = 2;
  else if (abs >= 1) decimals = 4;
  else if (abs >= 0.01) decimals = 5;
  else if (abs >= 0.0001) decimals = 6;
  else decimals = 8;
  const s = n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return currency ? `$${s}` : s;
}

/** Signed percentage, always with an explicit + or −. */
export function fmtPct(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(decimals)}%`;
}

/** Unsigned percentage, for gauges and shares. */
export function fmtPctPlain(n: number | null | undefined, decimals = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toFixed(decimals)}%`;
}

/** 1.24B / 890.5M / 12.3K — compact money for market caps and volume. */
export function fmtCompact(n: number | null | undefined, currency = true): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  const p = currency ? "$" : "";
  if (abs >= 1e12) return `${sign}${p}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${p}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${p}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${p}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${p}${abs.toFixed(2)}`;
}

export function fmtUsd(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** "2.4R" — risk multiples are the bot's native unit of account. */
export function fmtR(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(2)}R`;
}

/** Elapsed time in a compact bilingual-neutral form: 3d 4h / 12m. */
export function fmtDuration(ms: number, lang: "ar" | "en" = "en"): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  const u = lang === "ar"
    ? { d: "ي", h: "س", m: "د" }
    : { d: "d", h: "h", m: "m" };
  if (d > 0) return `${d}${u.d} ${h % 24}${u.h}`;
  if (h > 0) return `${h}${u.h} ${m % 60}${u.m}`;
  return `${Math.max(m, 0)}${u.m}`;
}

export function fmtAgo(ts: number, lang: "ar" | "en" = "en"): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return lang === "ar" ? "الآن" : "now";
  return fmtDuration(diff, lang);
}

/** Fixed-format clock — always UTC so screenshots are comparable. */
export function fmtTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 16) + " UTC";
}

export function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Direction class helper — jade up, crimson down, muted flat. */
export function toneOf(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return "flat" as const;
  return n > 0 ? ("up" as const) : ("down" as const);
}
