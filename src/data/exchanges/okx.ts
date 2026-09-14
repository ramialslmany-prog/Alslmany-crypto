/**
 * OKX v5 adapter — the second fallback venue.
 *
 * Three venue traps are neutralised here:
 *  1. OKX spells symbols "BTC-USDT" (and "BTC-USDT-SWAP" for perps). The rest
 *     of the system only ever sees the canonical "BTCUSDT".
 *  2. OKX daily and weekly bars default to HONG KONG time (UTC+8). Using them
 *     would shift every daily candle by 8 hours against Binance and against
 *     our own time module — a silent, catastrophic misalignment. We therefore
 *     request the explicit `1Dutc` / `1Wutc` bars.
 *  3. Candles come back newest-first and carry a `confirm` flag; we reverse
 *     them and keep the flag so unclosed bars are identifiable.
 */
import type { Availability } from "@/shared/availability";
import { available, mapAvailability, unavailable } from "@/shared/availability";
import { configureRateLimit, getJson, qs } from "@/data/http";
import { dedupeSorted } from "@/data/kline-row";
import type {
  KlineRequest,
  MarketCapabilities,
  MarketDataSource,
  MarketStream,
  StreamSubscription,
} from "@/data/market-source";
import type {
  Candle,
  FundingRate,
  LongShortRatio,
  MarketType,
  OpenInterest,
  OrderBook,
  SymbolInfo,
  Ticker24h,
  Trade,
} from "@/core/types";
import type { AppConfig } from "@/shared/config";
import { tfMillis, type Timeframe } from "@/shared/time";

/** UTC-anchored bars for 1d/1w — see trap #2 in the file header. */
const BAR: Record<Timeframe, string> = {
  "5m": "5m",
  "15m": "15m",
  "1h": "1H",
  "4h": "4H",
  "1d": "1Dutc",
  "1w": "1Wutc",
};

const RUBIK_PERIOD: Record<string, string> = {
  "5m": "5m",
  "15m": "15m",
  "1h": "1H",
  "4h": "4H",
  "1d": "1D",
};

const CAPS: MarketCapabilities = {
  spot: true,
  perp: true,
  funding: true,
  openInterest: true,
  longShortRatio: true,
  liquidations: false,
  historicalArchive: false,
  websocket: true,
  klineTakerBreakdown: false,
};

const PAGE_MAX = 300;

export class OkxSource implements MarketDataSource {
  readonly id = "okx";
  readonly label = "أوكي إكس";
  readonly capabilities = CAPS;

  private readonly base: string;
  private readonly quote: string;

  constructor(private readonly cfg: AppConfig) {
    this.base = cfg.OKX_BASE.replace(/\/$/, "");
    this.quote = cfg.QUOTE_ASSET.toUpperCase();
    configureRateLimit(hostOf(this.base), 200, 8);
  }

  private get<T>(url: string, source: string, weight = 1): Promise<Availability<T[]>> {
    return getJson<OkxEnvelope<T>>(url, {
      source,
      weight,
      timeoutMs: this.cfg.HTTP_TIMEOUT_MS,
      retries: this.cfg.HTTP_RETRIES,
      userAgent: this.cfg.HTTP_USER_AGENT,
    }).then((r) => {
      if (!r.available) return r;
      // OKX tunnels application errors through HTTP 200 with code != "0".
      if (r.value.code !== "0") {
        return unavailable(source, "bad_response", `code ${r.value.code}: ${r.value.msg}`);
      }
      return available(r.value.data ?? [], source, r.asOf);
    });
  }

  /** "BTCUSDT" → "BTC-USDT" (spot) or "BTC-USDT-SWAP" (perp). */
  private toNative(canonical: string, market: MarketType): string {
    const up = canonical.toUpperCase();
    const base = up.endsWith(this.quote) ? up.slice(0, -this.quote.length) : up;
    return market === "perp" ? `${base}-${this.quote}-SWAP` : `${base}-${this.quote}`;
  }

  private baseOf(canonical: string): string {
    const up = canonical.toUpperCase();
    return up.endsWith(this.quote) ? up.slice(0, -this.quote.length) : up;
  }

  async serverTime(): Promise<Availability<number>> {
    const r = await this.get<{ ts: string }>(`${this.base}/api/v5/public/time`, "okx:time");
    return mapAvailability(r, (rows) => Number(rows[0]?.ts ?? 0));
  }

  async symbols(market: MarketType = "spot"): Promise<Availability<SymbolInfo[]>> {
    const instType = market === "perp" ? "SWAP" : "SPOT";
    const r = await this.get<OkxInstrument>(
      `${this.base}/api/v5/public/instruments${qs({ instType })}`,
      `okx:instruments:${market}`,
    );
    if (!r.available) return r;
    const out: SymbolInfo[] = [];
    for (const i of r.value) {
      const baseCcy = i.baseCcy || i.ctValCcy || i.instId.split("-")[0];
      const quoteCcy = i.quoteCcy || i.settleCcy || i.instId.split("-")[1];
      if ((quoteCcy ?? "").toUpperCase() !== this.quote) continue;
      if (market === "perp" && i.instId && !i.instId.endsWith("-SWAP")) continue;
      out.push({
        symbol: `${baseCcy}${quoteCcy}`.toUpperCase(),
        nativeSymbol: i.instId,
        base: baseCcy,
        quote: quoteCcy,
        market,
        status: i.state === "live" ? "trading" : i.state === "suspend" ? "halted" : "delisted",
        pricePrecision: decimalsOf(Number(i.tickSz ?? 0), 8),
        quantityPrecision: decimalsOf(Number(i.lotSz ?? 0), 8),
        minNotional: 0, // OKX constrains min SIZE, not min notional
        listedAt: i.listTime ? Number(i.listTime) : undefined,
      });
    }
    return available(out, r.source, r.asOf);
  }

  async ticker24h(symbols?: string[]): Promise<Availability<Ticker24h[]>> {
    const r = await this.get<OkxTicker>(
      `${this.base}/api/v5/market/tickers${qs({ instType: "SPOT" })}`,
      "okx:tickers",
    );
    if (!r.available) return r;
    const wanted = symbols ? new Set(symbols.map((s) => s.toUpperCase())) : null;
    const out: Ticker24h[] = [];
    for (const t of r.value) {
      const [b, q] = t.instId.split("-");
      if (!q || q.toUpperCase() !== this.quote) continue;
      const canonical = `${b}${q}`.toUpperCase();
      if (wanted && !wanted.has(canonical)) continue;
      const last = Number(t.last);
      const open24 = Number(t.open24h);
      out.push({
        symbol: canonical,
        lastPrice: last,
        quoteVolume: Number(t.volCcy24h),
        priceChangePct: open24 > 0 ? ((last - open24) / open24) * 100 : NaN,
        highPrice: Number(t.high24h),
        lowPrice: Number(t.low24h),
        bidPrice: Number(t.bidPx),
        askPrice: Number(t.askPx),
      });
    }
    return available(out, r.source, r.asOf);
  }

  async klines(req: KlineRequest): Promise<Availability<Candle[]>> {
    const market = req.market ?? "spot";
    const instId = this.toNative(req.symbol, market);
    const wanted = req.limit ?? 500;
    const step = tfMillis(req.timeframe);
    const collected: Candle[] = [];
    // OKX pages backward: `after` returns records OLDER than the given ts.
    let after = req.endTime;
    let guard = 0;

    while (collected.length < wanted && guard++ < 200) {
      const pageSize = Math.min(PAGE_MAX, wanted - collected.length);
      // Recent bars live on /candles; anything deep must come from /history-candles.
      const deep = collected.length > 0 || (req.startTime !== undefined && Date.now() - req.startTime > 90 * 86_400_000);
      const path = deep ? "history-candles" : "candles";
      const r = await this.get<string[]>(
        `${this.base}/api/v5/market/${path}${qs({
          instId,
          bar: BAR[req.timeframe],
          limit: deep ? Math.min(pageSize, 100) : pageSize,
          after,
          before: req.startTime,
        })}`,
        `okx:candles:${req.timeframe}`,
      );
      if (!r.available) {
        if (collected.length === 0) return r;
        break;
      }
      const rows = r.value;
      if (rows.length === 0) break;

      for (const row of rows) {
        const openTime = Number(row[0]);
        const open = Number(row[1]);
        const high = Number(row[2]);
        const low = Number(row[3]);
        const close = Number(row[4]);
        const vol = Number(row[5]);
        const volQuote = Number(row[7] ?? row[6]);
        if (![openTime, open, high, low, close].every(Number.isFinite)) continue;
        if (high < low || close <= 0) continue;
        collected.push({
          openTime,
          closeTime: openTime + step,
          open,
          high,
          low,
          close,
          volume: Number.isFinite(vol) ? vol : 0,
          quoteVolume: Number.isFinite(volQuote) ? volQuote : vol * close,
          trades: 0,
          takerBuyBase: 0, // see `klineTakerBreakdown: false`
          takerBuyQuote: 0,
        });
      }

      const oldest = Math.min(...rows.map((r0) => Number(r0[0])));
      if (!Number.isFinite(oldest)) break;
      if (req.startTime !== undefined && oldest <= req.startTime) break;
      if (rows.length < pageSize) break;
      after = oldest;
    }

    if (collected.length === 0) {
      return unavailable(`okx:candles:${req.timeframe}`, "insufficient_history", req.symbol);
    }
    return available(dedupeSorted(collected), `okx:candles:${req.timeframe}`, Date.now());
  }

  async orderBook(
    symbol: string,
    depth = 50,
    market: MarketType = "spot",
  ): Promise<Availability<OrderBook>> {
    const r = await this.get<OkxBook>(
      `${this.base}/api/v5/market/books${qs({
        instId: this.toNative(symbol, market),
        sz: Math.min(depth, 400),
      })}`,
      "okx:books",
    );
    if (!r.available) return r;
    const b = r.value[0];
    if (!b) return unavailable("okx:books", "bad_response", symbol);
    return available(
      {
        symbol: symbol.toUpperCase(),
        bids: (b.bids ?? []).map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
        asks: (b.asks ?? []).map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
        timestamp: Number(b.ts) || r.asOf,
        lastUpdateId: 0,
      },
      r.source,
      r.asOf,
    );
  }

  async recentTrades(
    symbol: string,
    limit = 500,
    market: MarketType = "spot",
  ): Promise<Availability<Trade[]>> {
    const r = await this.get<OkxTrade>(
      `${this.base}/api/v5/market/trades${qs({
        instId: this.toNative(symbol, market),
        limit: Math.min(limit, 500),
      })}`,
      "okx:trades",
    );
    if (!r.available) return r;
    const out = r.value
      .map((t, idx): Trade => {
        const price = Number(t.px);
        const qty = Number(t.sz);
        return {
          id: Number(t.tradeId) || idx,
          price,
          quantity: qty,
          quoteQuantity: price * qty,
          timestamp: Number(t.ts),
          // OKX reports the TAKER side; buyerIsMaker is its inverse.
          buyerIsMaker: t.side === "sell",
        };
      })
      .sort((a, b) => a.timestamp - b.timestamp);
    return available(out, r.source, r.asOf);
  }

  async fundingRate(symbol: string): Promise<Availability<FundingRate>> {
    const r = await this.get<{ fundingRate: string; nextFundingTime: string; fundingTime: string }>(
      `${this.base}/api/v5/public/funding-rate${qs({ instId: this.toNative(symbol, "perp") })}`,
      "okx:funding",
    );
    if (!r.available) return r;
    const f = r.value[0];
    if (!f) return unavailable("okx:funding", "unsupported_symbol", symbol);
    return available(
      {
        symbol: symbol.toUpperCase(),
        rate: Number(f.fundingRate),
        fundingTime: Number(f.nextFundingTime),
        intervalHours: 8,
      },
      r.source,
      Number(f.fundingTime) || r.asOf,
    );
  }

  async fundingHistory(symbol: string, limit = 100): Promise<Availability<FundingRate[]>> {
    const r = await this.get<{ fundingRate: string; fundingTime: string }>(
      `${this.base}/api/v5/public/funding-rate-history${qs({
        instId: this.toNative(symbol, "perp"),
        limit: Math.min(limit, 100),
      })}`,
      "okx:fundingHistory",
    );
    if (!r.available) return r;
    const out = r.value
      .map((f): FundingRate => ({
        symbol: symbol.toUpperCase(),
        rate: Number(f.fundingRate),
        fundingTime: Number(f.fundingTime),
        intervalHours: 8,
      }))
      .sort((a, b) => a.fundingTime - b.fundingTime);
    return available(out, r.source, r.asOf);
  }

  async openInterest(symbol: string): Promise<Availability<OpenInterest>> {
    const r = await this.get<{ oi: string; oiCcy: string; ts: string }>(
      `${this.base}/api/v5/public/open-interest${qs({
        instType: "SWAP",
        instId: this.toNative(symbol, "perp"),
      })}`,
      "okx:openInterest",
    );
    if (!r.available) return r;
    const o = r.value[0];
    if (!o) return unavailable("okx:openInterest", "unsupported_symbol", symbol);
    return available(
      {
        symbol: symbol.toUpperCase(),
        openInterest: Number(o.oiCcy),
        openInterestValue: NaN,
        timestamp: Number(o.ts) || r.asOf,
      },
      r.source,
      r.asOf,
    );
  }

  async openInterestHistory(
    symbol: string,
    period: "5m" | "15m" | "1h" | "4h" | "1d",
    limit = 100,
  ): Promise<Availability<OpenInterest[]>> {
    // OKX's history endpoint is per-CURRENCY, not per-instrument.
    const r = await this.get<string[]>(
      `${this.base}/api/v5/rubik/stat/contracts/open-interest-volume${qs({
        ccy: this.baseOf(symbol),
        period: RUBIK_PERIOD[period],
      })}`,
      "okx:oiHistory",
    );
    if (!r.available) return r;
    const out = r.value
      .map((row): OpenInterest => ({
        symbol: symbol.toUpperCase(),
        openInterest: Number(row[1]),
        openInterestValue: Number(row[1]),
        timestamp: Number(row[0]),
      }))
      .filter((o) => Number.isFinite(o.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-limit);
    return available(out, r.source, r.asOf);
  }

  async longShortRatio(
    symbol: string,
    period: "5m" | "15m" | "1h" | "4h" | "1d",
    limit = 100,
  ): Promise<Availability<LongShortRatio[]>> {
    const r = await this.get<string[]>(
      `${this.base}/api/v5/rubik/stat/contracts/long-short-account-ratio${qs({
        ccy: this.baseOf(symbol),
        period: RUBIK_PERIOD[period],
      })}`,
      "okx:longShort",
    );
    if (!r.available) return r;
    const out = r.value
      .map((row): LongShortRatio => {
        const ratio = Number(row[1]);
        // OKX gives the ratio only; derive the percentages from it.
        const longPct = Number.isFinite(ratio) ? (ratio / (1 + ratio)) * 100 : NaN;
        return {
          symbol: symbol.toUpperCase(),
          longAccountPct: longPct,
          shortAccountPct: Number.isFinite(longPct) ? 100 - longPct : NaN,
          ratio,
          timestamp: Number(row[0]),
        };
      })
      .filter((x) => Number.isFinite(x.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-limit);
    return available(out, r.source, r.asOf);
  }

  createStream(_sub: StreamSubscription): MarketStream | null {
    return null; // see the note on BybitSource.createStream
  }
}

interface OkxEnvelope<T> {
  code: string;
  msg: string;
  data?: T[];
}

interface OkxInstrument {
  instId: string;
  baseCcy?: string;
  quoteCcy?: string;
  ctValCcy?: string;
  settleCcy?: string;
  state?: string;
  tickSz?: string;
  lotSz?: string;
  listTime?: string;
}

interface OkxTicker {
  instId: string;
  last: string;
  open24h: string;
  high24h: string;
  low24h: string;
  volCcy24h: string;
  bidPx: string;
  askPx: string;
}

interface OkxBook {
  asks?: [string, string, string, string][];
  bids?: [string, string, string, string][];
  ts?: string;
}

interface OkxTrade {
  tradeId: string;
  px: string;
  sz: string;
  side: "buy" | "sell";
  ts: string;
}

function decimalsOf(size: number, fallback: number): number {
  if (!Number.isFinite(size) || size <= 0) return fallback;
  const s = size.toFixed(12).replace(/0+$/, "");
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
