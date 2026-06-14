/**
 * Multi-exchange OHLCV candle fetcher (server-side).
 *
 * Tries venues in order (Binance → OKX → Bybit) and returns the first that
 * responds — real klines, not synthetic. If every venue is unreachable it
 * falls back to a deterministic synthetic series so the engine never crashes
 * (the response is tagged `source: "synthetic"` so the UI can be honest).
 */
import { coins as mockCoins } from "@/lib/mock-data";

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Interval = "15m" | "1h" | "4h" | "1d";
export interface CandleResult {
  source: string;
  candles: Candle[];
}

const num = (x: unknown) => parseFloat(x as string);
const TIMEOUT_MS = 3000;

async function timedFetch(url: string, headers?: Record<string, string>): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", headers: { accept: "application/json", ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const BINANCE_IV: Record<Interval, string> = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
const OKX_BAR: Record<Interval, string> = { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" };
const BYBIT_IV: Record<Interval, string> = { "15m": "15", "1h": "60", "4h": "240", "1d": "D" };

async function fromBinance(base: string, iv: Interval, limit: number): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${base}USDT&interval=${BINANCE_IV[iv]}&limit=${limit}`;
  const raw = (await timedFetch(url)) as unknown[][];
  return raw.map((k) => ({ t: k[0] as number, o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]) }));
}

async function fromOKX(base: string, iv: Interval, limit: number): Promise<Candle[]> {
  const url = `https://www.okx.com/api/v5/market/candles?instId=${base}-USDT&bar=${OKX_BAR[iv]}&limit=${limit}`;
  const j = (await timedFetch(url)) as { data?: string[][] };
  const rows = (j.data ?? []).slice().reverse(); // OKX returns newest-first
  return rows.map((k) => ({ t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]) }));
}

async function fromBybit(base: string, iv: Interval, limit: number): Promise<Candle[]> {
  const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${base}USDT&interval=${BYBIT_IV[iv]}&limit=${limit}`;
  const j = (await timedFetch(url)) as { result?: { list?: string[][] } };
  const rows = (j.result?.list ?? []).slice().reverse(); // newest-first
  return rows.map((k) => ({ t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]) }));
}

/** Deterministic synthetic candles from the seeded spark — last-resort fallback. */
function synthetic(base: string, limit: number): Candle[] {
  const coin = mockCoins.find((c) => c.symbol === base) ?? mockCoins[0];
  const closes = coin.spark;
  const scale = coin.price / (closes[closes.length - 1] || 1);
  const out: Candle[] = [];
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i] * scale;
    const o = (i > 0 ? closes[i - 1] : closes[i]) * scale;
    const h = Math.max(o, c) * 1.004;
    const l = Math.min(o, c) * 0.996;
    out.push({ t: Date.now() - (closes.length - i) * 3.6e6, o, h, l, c, v: 1000 + i * 13 });
  }
  return out.slice(-limit);
}

export async function fetchCandles(symbol: string, interval: Interval, limit = 200): Promise<CandleResult> {
  const base = symbol.toUpperCase();
  const venues: [string, () => Promise<Candle[]>][] = [
    ["binance", () => fromBinance(base, interval, limit)],
    ["okx", () => fromOKX(base, interval, limit)],
    ["bybit", () => fromBybit(base, interval, limit)],
  ];
  for (const [name, fn] of venues) {
    try {
      const candles = await fn();
      if (candles.length > 20) return { source: name, candles };
    } catch {
      // try next venue
    }
  }
  return { source: "synthetic", candles: synthetic(base, limit) };
}
