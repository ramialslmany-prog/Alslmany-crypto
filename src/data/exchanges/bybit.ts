/**
 * Bybit v5 adapter — the first fallback venue.
 *
 * Two venue quirks are handled here and must not leak upward:
 *  1. Bybit returns klines NEWEST-FIRST. We reverse them; a series in the
 *     wrong order would make every indicator read the future.
 *  2. Bybit klines carry no trade count and no taker-buy split, so
 *     `klineTakerBreakdown` is false and the flow stage reports CVD as
 *     unavailable instead of inventing a zero delta.
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

const INTERVAL: Record<Timeframe, string> = {
  "5m": "5",
  "15m": "15",
  "1h": "60",
  "4h": "240",
  "1d": "D",
  "1w": "W",
};

const OI_PERIOD: Record<string, string> = {
  "5m": "5min",
  "15m": "15min",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
};

const CAPS: MarketCapabilities = {
  spot: true,
  perp: true,
  funding: true,
  openInterest: true,
  longShortRatio: true,
  liquidations: true,
  historicalArchive: false,
  websocket: true,
  klineTakerBreakdown: false,
};

const PAGE_MAX = 1000;

export class BybitSource implements MarketDataSource {
  readonly id = "bybit";
  readonly label = "بايبت";
  readonly capabilities = CAPS;

  private readonly base: string;

  constructor(private readonly cfg: AppConfig) {
    this.base = cfg.BYBIT_BASE.replace(/\/$/, "");
    configureRateLimit(hostOf(this.base), 300, 10);
  }

  private get<T>(url: string, source: string, weight = 1): Promise<Availability<T>> {
    return getJson<BybitEnvelope<T>>(url, {
      source,
      weight,
      timeoutMs: this.cfg.HTTP_TIMEOUT_MS,
      retries: this.cfg.HTTP_RETRIES,
      userAgent: this.cfg.HTTP_USER_AGENT,
    }).then((r) => {
      if (!r.available) return r;
      // Bybit tunnels application errors through HTTP 200 with retCode != 0.
      if (r.value.retCode !== 0) {
        return unavailable(source, "bad_response", `retCode ${r.value.retCode}: ${r.value.retMsg}`);
      }
      return available(r.value.result, source, Number(r.value.time) || r.asOf);
    });
  }

  private category(market: MarketType): "spot" | "linear" {
    return market === "perp" ? "linear" : "spot";
  }

  async serverTime(): Promise<Availability<number>> {
    const r = await this.get<{ timeSecond: string }>(
      `${this.base}/v5/market/time`,
      "bybit:time",
    );
    return mapAvailability(r, (v) => Number(v.timeSecond) * 1000);
  }

  async symbols(market: MarketType = "spot"): Promise<Availability<SymbolInfo[]>> {
    const r = await this.get<{ list: BybitInstrument[] }>(
      `${this.base}/v5/market/instruments-info${qs({ category: this.category(market), limit: 1000 })}`,
      `bybit:instruments:${market}`,
    );
    if (!r.available) return r;
    const quote = this.cfg.QUOTE_ASSET.toUpperCase();
    const out: SymbolInfo[] = [];
    for (const i of r.value.list ?? []) {
      if ((i.quoteCoin ?? "").toUpperCase() !== quote) continue;
      if (market === "perp" && i.contractType && !i.contractType.includes("Perpetual")) continue;
      out.push({
        symbol: `${i.baseCoin}${i.quoteCoin}`.toUpperCase(),
        nativeSymbol: i.symbol,
        base: i.baseCoin,
        quote: i.quoteCoin,
        market,
        status: i.status === "Trading" ? "trading" : i.status === "PreLaunch" ? "halted" : "delisted",
        pricePrecision: decimalsOf(Number(i.priceFilter?.tickSize ?? 0), 8),
        quantityPrecision: decimalsOf(Number(i.lotSizeFilter?.basePrecision ?? i.lotSizeFilter?.qtyStep ?? 0), 8),
        minNotional: Number(i.lotSizeFilter?.minOrderAmt ?? i.lotSizeFilter?.minNotionalValue ?? 0) || 0,
        listedAt: i.launchTime ? Number(i.launchTime) : undefined,
      });
    }
    return available(out, r.source, r.asOf);
  }

  async ticker24h(symbols?: string[]): Promise<Availability<Ticker24h[]>> {
    const single = symbols?.length === 1 ? native(symbols[0]) : undefined;
    const r = await this.get<{ list: BybitTicker[] }>(
      `${this.base}/v5/market/tickers${qs({ category: "spot", symbol: single })}`,
      "bybit:tickers",
    );
    if (!r.available) return r;
    const wanted = symbols ? new Set(symbols.map((s) => s.toUpperCase())) : null;
    const out = (r.value.list ?? [])
      .filter((t) => !wanted || wanted.has(t.symbol.toUpperCase()))
      .map(
        (t): Ticker24h => ({
          symbol: t.symbol.toUpperCase(),
          lastPrice: Number(t.lastPrice),
          quoteVolume: Number(t.turnover24h),
          priceChangePct: Number(t.price24hPcnt) * 100,
          highPrice: Number(t.highPrice24h),
          lowPrice: Number(t.lowPrice24h),
          bidPrice: Number(t.bid1Price),
          askPrice: Number(t.ask1Price),
        }),
      );
    return available(out, r.source, r.asOf);
  }

  async klines(req: KlineRequest): Promise<Availability<Candle[]>> {
    const market = req.market ?? "spot";
    const wanted = req.limit ?? 500;
    const step = tfMillis(req.timeframe);
    const collected: Candle[] = [];
    // Bybit pages BACKWARD from `end`, so we walk the cursor down, not up.
    let end = req.endTime;
    let guard = 0;

    while (collected.length < wanted && guard++ < 200) {
      const pageSize = Math.min(PAGE_MAX, wanted - collected.length);
      const r = await this.get<{ list: string[][] }>(
        `${this.base}/v5/market/kline${qs({
          category: this.category(market),
          symbol: native(req.symbol),
          interval: INTERVAL[req.timeframe],
          limit: pageSize,
          start: req.startTime,
          end,
        })}`,
        `bybit:kline:${req.timeframe}`,
      );
      if (!r.available) {
        if (collected.length === 0) return r;
        break;
      }
      const rows = r.value.list ?? [];
      if (rows.length === 0) break;

      for (const row of rows) {
        const openTime = Number(row[0]);
        const open = Number(row[1]);
        const high = Number(row[2]);
        const low = Number(row[3]);
        const close = Number(row[4]);
        const volume = Number(row[5]);
        const turnover = Number(row[6]);
        if (![openTime, open, high, low, close].every(Number.isFinite)) continue;
        if (high < low || close <= 0) continue;
        collected.push({
          openTime,
          closeTime: openTime + step,
          open,
          high,
          low,
          close,
          volume,
          quoteVolume: Number.isFinite(turnover) ? turnover : volume * close,
          // Not provided by Bybit. `klineTakerBreakdown: false` tells the flow
          // stage to treat these as unknown rather than as real zeros.
          trades: 0,
          takerBuyBase: 0,
          takerBuyQuote: 0,
        });
      }

      const oldest = Math.min(...rows.map((r0) => Number(r0[0])));
      if (!Number.isFinite(oldest)) break;
      if (req.startTime !== undefined && oldest <= req.startTime) break;
      if (rows.length < pageSize) break;
      end = oldest - 1;
    }

    if (collected.length === 0) {
      return unavailable(`bybit:kline:${req.timeframe}`, "insufficient_history", req.symbol);
    }
    return available(dedupeSorted(collected), `bybit:kline:${req.timeframe}`, Date.now());
  }

  async orderBook(
    symbol: string,
    depth = 50,
    market: MarketType = "spot",
  ): Promise<Availability<OrderBook>> {
    const r = await this.get<{ b: [string, string][]; a: [string, string][]; u: number; ts: number }>(
      `${this.base}/v5/market/orderbook${qs({
        category: this.category(market),
        symbol: native(symbol),
        limit: Math.min(depth, market === "perp" ? 500 : 200),
      })}`,
      "bybit:orderbook",
    );
    if (!r.available) return r;
    return available(
      {
        symbol: symbol.toUpperCase(),
        bids: (r.value.b ?? []).map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
        asks: (r.value.a ?? []).map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
        timestamp: Number(r.value.ts) || r.asOf,
        lastUpdateId: Number(r.value.u) || 0,
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
    const r = await this.get<{ list: BybitTrade[] }>(
      `${this.base}/v5/market/recent-trade${qs({
        category: this.category(market),
        symbol: native(symbol),
        limit: Math.min(limit, 1000),
      })}`,
      "bybit:recentTrades",
    );
    if (!r.available) return r;
    const out = (r.value.list ?? [])
      .map((t, idx): Trade => {
        const price = Number(t.price);
        const qty = Number(t.size);
        return {
          id: Number(t.execId) || idx,
          price,
          quantity: qty,
          quoteQuantity: price * qty,
          timestamp: Number(t.time),
          // Bybit reports the AGGRESSOR side; buyerIsMaker is its inverse.
          buyerIsMaker: t.side === "Sell",
        };
      })
      .sort((a, b) => a.timestamp - b.timestamp);
    return available(out, r.source, r.asOf);
  }

  async fundingRate(symbol: string): Promise<Availability<FundingRate>> {
    const r = await this.get<{ list: BybitTicker[] }>(
      `${this.base}/v5/market/tickers${qs({ category: "linear", symbol: native(symbol) })}`,
      "bybit:funding",
    );
    if (!r.available) return r;
    const t = r.value.list?.[0];
    if (!t) return unavailable("bybit:funding", "unsupported_symbol", symbol);
    return available(
      {
        symbol: symbol.toUpperCase(),
        rate: Number(t.fundingRate),
        fundingTime: Number(t.nextFundingTime),
        intervalHours: 8,
      },
      r.source,
      r.asOf,
    );
  }

  async fundingHistory(symbol: string, limit = 200): Promise<Availability<FundingRate[]>> {
    const r = await this.get<{ list: { symbol: string; fundingRate: string; fundingRateTimestamp: string }[] }>(
      `${this.base}/v5/market/funding/history${qs({
        category: "linear",
        symbol: native(symbol),
        limit: Math.min(limit, 200),
      })}`,
      "bybit:fundingHistory",
    );
    if (!r.available) return r;
    const out = (r.value.list ?? [])
      .map((f): FundingRate => ({
        symbol: symbol.toUpperCase(),
        rate: Number(f.fundingRate),
        fundingTime: Number(f.fundingRateTimestamp),
        intervalHours: 8,
      }))
      .sort((a, b) => a.fundingTime - b.fundingTime);
    return available(out, r.source, r.asOf);
  }

  async openInterest(symbol: string): Promise<Availability<OpenInterest>> {
    const r = await this.openInterestHistory(symbol, "5m", 1);
    if (!r.available) return r;
    const last = r.value[r.value.length - 1];
    if (!last) return unavailable("bybit:openInterest", "bad_response", symbol);
    return available(last, r.source, r.asOf);
  }

  async openInterestHistory(
    symbol: string,
    period: "5m" | "15m" | "1h" | "4h" | "1d",
    limit = 200,
  ): Promise<Availability<OpenInterest[]>> {
    const r = await this.get<{ list: { openInterest: string; timestamp: string }[] }>(
      `${this.base}/v5/market/open-interest${qs({
        category: "linear",
        symbol: native(symbol),
        intervalTime: OI_PERIOD[period],
        limit: Math.min(limit, 200),
      })}`,
      "bybit:oiHistory",
    );
    if (!r.available) return r;
    const out = (r.value.list ?? [])
      .map((o): OpenInterest => ({
        symbol: symbol.toUpperCase(),
        openInterest: Number(o.openInterest),
        openInterestValue: NaN, // Bybit reports contracts here, not notional
        timestamp: Number(o.timestamp),
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
    return available(out, r.source, r.asOf);
  }

  async longShortRatio(
    symbol: string,
    period: "5m" | "15m" | "1h" | "4h" | "1d",
    limit = 200,
  ): Promise<Availability<LongShortRatio[]>> {
    const r = await this.get<{ list: { buyRatio: string; sellRatio: string; timestamp: string }[] }>(
      `${this.base}/v5/market/account-ratio${qs({
        category: "linear",
        symbol: native(symbol),
        period: OI_PERIOD[period],
        limit: Math.min(limit, 500),
      })}`,
      "bybit:accountRatio",
    );
    if (!r.available) return r;
    const out = (r.value.list ?? [])
      .map((x): LongShortRatio => {
        const long = Number(x.buyRatio) * 100;
        const short = Number(x.sellRatio) * 100;
        return {
          symbol: symbol.toUpperCase(),
          longAccountPct: long,
          shortAccountPct: short,
          ratio: short > 0 ? long / short : NaN,
          timestamp: Number(x.timestamp),
        };
      })
      .sort((a, b) => a.timestamp - b.timestamp);
    return available(out, r.source, r.asOf);
  }

  createStream(_sub: StreamSubscription): MarketStream | null {
    // Implemented when Bybit is promoted from fallback to primary; the REST
    // poller keeps the bot alive in the meantime. Declared honestly rather
    // than returning a socket that silently delivers nothing.
    return null;
  }
}

interface BybitEnvelope<T> {
  retCode: number;
  retMsg: string;
  result: T;
  time?: number;
}

interface BybitInstrument {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  status: string;
  contractType?: string;
  launchTime?: string;
  priceFilter?: { tickSize?: string };
  lotSizeFilter?: {
    basePrecision?: string;
    qtyStep?: string;
    minOrderAmt?: string;
    minNotionalValue?: string;
  };
}

interface BybitTicker {
  symbol: string;
  lastPrice: string;
  turnover24h: string;
  price24hPcnt: string;
  highPrice24h: string;
  lowPrice24h: string;
  bid1Price: string;
  ask1Price: string;
  fundingRate?: string;
  nextFundingTime?: string;
}

interface BybitTrade {
  execId: string;
  price: string;
  size: string;
  side: "Buy" | "Sell";
  time: string;
}

/** Bybit spells symbols the canonical way already. */
function native(canonical: string): string {
  return canonical.toUpperCase();
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
