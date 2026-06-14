/**
 * Multi-exchange public-ticker adapters (server-side only).
 *
 * Each adapter normalizes one exchange's public REST ticker into a common
 * shape. No API keys required. We use REST here (fanned out in parallel);
 * a production system would promote the hot path to persistent WebSocket
 * feeds in a standalone streaming service — these adapters are written so
 * that service can reuse the same normalization + symbol mapping.
 */

export type QuoteCcy = "USDT" | "USD";

export interface SourceQuote {
  exchange: string;
  quote: QuoteCcy;
  ok: boolean;
  price?: number;
  baseVolume?: number;
  quoteVolume?: number;
  latencyMs: number;
  reason?: string;
  /** filled in by the validator */
  deviationPct?: number;
  outlier?: boolean;
  reliability?: number;
}

interface Adapter {
  name: string;
  quote: QuoteCcy;
  /** bases this venue does not list (skipped without a network call) */
  unsupported?: string[];
  url: (base: string) => string;
  headers?: Record<string, string>;
  parse: (json: unknown) => { price: number; baseVolume: number } | null;
}

const n = (v: unknown): number => {
  const x = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(x) ? x : NaN;
};

/** Kraken uses idiosyncratic asset codes. */
const KRAKEN_BASE: Record<string, string> = { BTC: "XBT", DOGE: "XDG" };

export const ADAPTERS: Adapter[] = [
  {
    name: "Binance",
    quote: "USDT",
    url: (b) => `https://api.binance.com/api/v3/ticker/24hr?symbol=${b}USDT`,
    parse: (j) => {
      const d = j as { lastPrice?: string; volume?: string };
      const price = n(d.lastPrice);
      return Number.isFinite(price) ? { price, baseVolume: n(d.volume) || 0 } : null;
    },
  },
  {
    name: "Bybit",
    quote: "USDT",
    url: (b) => `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${b}USDT`,
    parse: (j) => {
      const d = j as { result?: { list?: { lastPrice?: string; volume24h?: string }[] } };
      const t = d.result?.list?.[0];
      const price = n(t?.lastPrice);
      return Number.isFinite(price) ? { price, baseVolume: n(t?.volume24h) || 0 } : null;
    },
  },
  {
    name: "OKX",
    quote: "USDT",
    url: (b) => `https://www.okx.com/api/v5/market/ticker?instId=${b}-USDT`,
    parse: (j) => {
      const d = j as { data?: { last?: string; vol24h?: string }[] };
      const t = d.data?.[0];
      const price = n(t?.last);
      return Number.isFinite(price) ? { price, baseVolume: n(t?.vol24h) || 0 } : null;
    },
  },
  {
    name: "KuCoin",
    quote: "USDT",
    url: (b) => `https://api.kucoin.com/api/v1/market/stats?symbol=${b}-USDT`,
    parse: (j) => {
      const d = j as { data?: { last?: string; vol?: string } };
      const price = n(d.data?.last);
      return Number.isFinite(price) ? { price, baseVolume: n(d.data?.vol) || 0 } : null;
    },
  },
  {
    name: "Kraken",
    quote: "USD",
    unsupported: ["BNB"],
    url: (b) => `https://api.kraken.com/0/public/Ticker?pair=${KRAKEN_BASE[b] ?? b}USD`,
    parse: (j) => {
      const d = j as { result?: Record<string, { c?: string[]; v?: string[] }> };
      const first = d.result ? Object.values(d.result)[0] : undefined;
      const price = n(first?.c?.[0]);
      return Number.isFinite(price) ? { price, baseVolume: n(first?.v?.[1]) || 0 } : null;
    },
  },
  {
    name: "Coinbase",
    quote: "USD",
    unsupported: ["BNB"],
    url: (b) => `https://api.exchange.coinbase.com/products/${b}-USD/ticker`,
    headers: { "User-Agent": "quantum-price-oracle/1.0" },
    parse: (j) => {
      const d = j as { price?: string; volume?: string };
      const price = n(d.price);
      return Number.isFinite(price) ? { price, baseVolume: n(d.volume) || 0 } : null;
    },
  },
  {
    name: "Bitget",
    quote: "USDT",
    url: (b) => `https://api.bitget.com/api/v2/spot/market/tickers?symbol=${b}USDT`,
    parse: (j) => {
      const d = j as { data?: { lastPr?: string; baseVolume?: string }[] };
      const t = d.data?.[0];
      const price = n(t?.lastPr);
      return Number.isFinite(price) ? { price, baseVolume: n(t?.baseVolume) || 0 } : null;
    },
  },
  {
    name: "Gate.io",
    quote: "USDT",
    url: (b) => `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${b}_USDT`,
    parse: (j) => {
      const d = j as { last?: string; base_volume?: string }[];
      const t = Array.isArray(d) ? d[0] : undefined;
      const price = n(t?.last);
      return Number.isFinite(price) ? { price, baseVolume: n(t?.base_volume) || 0 } : null;
    },
  },
];

const TIMEOUT_MS = 2800;

/** Fetch + normalize one exchange ticker, measuring latency and failing soft. */
export async function fetchTicker(adapter: Adapter, base: string): Promise<SourceQuote> {
  if (adapter.unsupported?.includes(base)) {
    return { exchange: adapter.name, quote: adapter.quote, ok: false, latencyMs: 0, reason: "pair not listed" };
  }
  const start = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(adapter.url(base), {
      signal: ctrl.signal,
      cache: "no-store",
      headers: { accept: "application/json", ...(adapter.headers ?? {}) },
    });
    const latencyMs = Math.round(performance.now() - start);
    if (!res.ok) {
      return { exchange: adapter.name, quote: adapter.quote, ok: false, latencyMs, reason: `HTTP ${res.status}` };
    }
    const parsed = adapter.parse(await res.json());
    if (!parsed || !(parsed.price > 0)) {
      return { exchange: adapter.name, quote: adapter.quote, ok: false, latencyMs, reason: "no price in payload" };
    }
    return {
      exchange: adapter.name,
      quote: adapter.quote,
      ok: true,
      price: parsed.price,
      baseVolume: parsed.baseVolume,
      quoteVolume: parsed.baseVolume * parsed.price,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    const reason = (err as Error).name === "AbortError" ? "timeout" : (err as Error).message;
    return { exchange: adapter.name, quote: adapter.quote, ok: false, latencyMs, reason };
  } finally {
    clearTimeout(timer);
  }
}

/** Fan out to every venue in parallel. */
export async function fetchAllTickers(base: string): Promise<SourceQuote[]> {
  return Promise.all(ADAPTERS.map((a) => fetchTicker(a, base)));
}
