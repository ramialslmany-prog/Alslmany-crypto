/**
 * Binance adapter — spot + USD-M perpetuals.
 *
 * Rate-limit budgets below are set to roughly HALF of Binance's published IP
 * limits. An IP ban takes the whole bot offline for minutes to hours, which is
 * a far worse outcome than a slightly slower scan.
 *   spot    : 6000 weight/min published → we budget 3000/min
 *   futures : 2400 weight/min published → we budget 1200/min
 */
import type { Availability } from "@/shared/availability";
import { available, mapAvailability, unavailable } from "@/shared/availability";
import { configureRateLimit, getJson, qs } from "@/data/http";
import { binanceKlineRows } from "@/data/kline-row";
import { BinanceStream } from "@/data/exchanges/binance-stream";
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
import type { Timeframe } from "@/shared/time";

/** Binance interval strings match our timeframe ids exactly. */
const INTERVAL: Record<Timeframe, string> = {
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
  "1w": "1w",
};

const CAPS: MarketCapabilities = {
  spot: true,
  perp: true,
  funding: true,
  openInterest: true,
  longShortRatio: true,
  liquidations: true,
  historicalArchive: true,
  websocket: true,
  klineTakerBreakdown: true,
};

/** Published max rows per klines page. */
const KLINE_PAGE_MAX = 1000;

export class BinanceSource implements MarketDataSource {
  readonly id = "binance";
  readonly label = "بايننس";
  readonly capabilities = CAPS;

  private readonly spotBase: string;
  private readonly futBase: string;

  constructor(private readonly cfg: AppConfig) {
    this.spotBase = cfg.BINANCE_SPOT_BASE.replace(/\/$/, "");
    this.futBase = cfg.BINANCE_FUTURES_BASE.replace(/\/$/, "");
    configureRateLimit(hostOf(this.spotBase), 600, 50); // ≈3000 weight/min
    configureRateLimit(hostOf(this.futBase), 400, 20); // ≈1200 weight/min
  }

  private get<T>(url: string, source: string, weight: number): Promise<Availability<T>> {
    return getJson<T>(url, {
      source,
      weight,
      timeoutMs: this.cfg.HTTP_TIMEOUT_MS,
      retries: this.cfg.HTTP_RETRIES,
      userAgent: this.cfg.HTTP_USER_AGENT,
    });
  }

  private base(market: MarketType): string {
    return market === "perp" ? this.futBase : this.spotBase;
  }

  private prefix(market: MarketType): string {
    return market === "perp" ? "/fapi/v1" : "/api/v3";
  }

  async serverTime(): Promise<Availability<number>> {
    const r = await this.get<{ serverTime: number }>(
      `${this.spotBase}/api/v3/time`,
      "binance:time",
      1,
    );
    return mapAvailability(r, (v) => v.serverTime);
  }

  async symbols(market: MarketType = "spot"): Promise<Availability<SymbolInfo[]>> {
    const url = `${this.base(market)}${this.prefix(market)}/exchangeInfo`;
    const r = await this.get<BinanceExchangeInfo>(url, `binance:exchangeInfo:${market}`, 20);
    if (!r.available) return r;

    const quote = this.cfg.QUOTE_ASSET.toUpperCase();
    const out: SymbolInfo[] = [];

    for (const s of r.value.symbols ?? []) {
      if (s.quoteAsset?.toUpperCase() !== quote) continue;
      // Perp venue also lists dated futures and non-perpetual contracts.
      if (market === "perp" && s.contractType && s.contractType !== "PERPETUAL") continue;

      const filters = indexFilters(s.filters ?? []);
      const tickSize = Number(filters.PRICE_FILTER?.tickSize ?? "0");
      const stepSize = Number(filters.LOT_SIZE?.stepSize ?? "0");
      const minNotional = Number(
        filters.NOTIONAL?.minNotional ?? filters.MIN_NOTIONAL?.notional ?? filters.MIN_NOTIONAL?.minNotional ?? "0",
      );

      out.push({
        symbol: s.symbol, // Binance's native spelling is already canonical
        nativeSymbol: s.symbol,
        base: s.baseAsset,
        quote: s.quoteAsset,
        market,
        status: mapStatus(s.status ?? s.contractStatus),
        pricePrecision: decimalsOf(tickSize, s.quotePrecision ?? s.pricePrecision ?? 8),
        quantityPrecision: decimalsOf(stepSize, s.baseAssetPrecision ?? s.quantityPrecision ?? 8),
        minNotional: Number.isFinite(minNotional) ? minNotional : 0,
        listedAt: s.onboardDate ? Number(s.onboardDate) : undefined,
      });
    }
    return available(out, r.source, r.asOf);
  }

  async ticker24h(symbols?: string[]): Promise<Availability<Ticker24h[]>> {
    // Weight scales with breadth: 2 for one symbol, 80 for the full board.
    const weight = !symbols ? 80 : symbols.length === 1 ? 2 : symbols.length <= 100 ? 40 : 80;
    const query =
      symbols && symbols.length === 1
        ? qs({ symbol: symbols[0] })
        : symbols
          ? `?symbols=${encodeURIComponent(JSON.stringify(symbols))}`
          : "";
    const url = `${this.spotBase}/api/v3/ticker/24hr${query}`;
    const r = await this.get<BinanceTicker | BinanceTicker[]>(url, "binance:ticker24h", weight);
    if (!r.available) return r;
    const rows = Array.isArray(r.value) ? r.value : [r.value];
    const out = rows.map(
      (t): Ticker24h => ({
        symbol: t.symbol,
        lastPrice: Number(t.lastPrice),
        quoteVolume: Number(t.quoteVolume),
        priceChangePct: Number(t.priceChangePercent),
        highPrice: Number(t.highPrice),
        lowPrice: Number(t.lowPrice),
        bidPrice: Number(t.bidPrice),
        askPrice: Number(t.askPrice),
      }),
    );
    return available(out, r.source, r.asOf);
  }

  /**
   * Klines, transparently paged. Binance caps a page at 1000 rows, so a
   * request for more walks forward by openTime until the range is covered or
   * the venue stops returning rows.
   *
   * The forming candle is NOT stripped here — see `MarketDataSource.klines`.
   */
  async klines(req: KlineRequest): Promise<Availability<Candle[]>> {
    const market = req.market ?? "spot";
    const wanted = req.limit ?? 500;
    const interval = INTERVAL[req.timeframe];
    const url = `${this.base(market)}${this.prefix(market)}/klines`;

    // Single page: let the venue apply its own "most recent N" semantics.
    if (wanted <= KLINE_PAGE_MAX && req.startTime === undefined) {
      const r = await this.get<unknown[][]>(
        `${url}${qs({ symbol: req.symbol, interval, limit: wanted, endTime: req.endTime })}`,
        `binance:klines:${req.timeframe}`,
        klineWeight(market, wanted),
      );
      return mapAvailability(r, (rows) => binanceKlineRows(rows, req.timeframe));
    }

    const collected: Candle[] = [];
    let cursor = req.startTime;
    let guard = 0;

    while (collected.length < wanted && guard++ < 200) {
      const pageSize = Math.min(KLINE_PAGE_MAX, wanted - collected.length);
      const r = await this.get<unknown[][]>(
        `${url}${qs({
          symbol: req.symbol,
          interval,
          limit: pageSize,
          startTime: cursor,
          endTime: req.endTime,
        })}`,
        `binance:klines:${req.timeframe}`,
        klineWeight(market, pageSize),
      );
      if (!r.available) {
        // Partial data is still useful; only fail outright if we have nothing.
        if (collected.length === 0) return r;
        break;
      }
      const page = binanceKlineRows(r.value, req.timeframe);
      if (page.length === 0) break;

      collected.push(...page);
      const lastOpen = page[page.length - 1].openTime;
      if (cursor !== undefined && lastOpen < cursor) break; // no forward progress
      cursor = lastOpen + 1;
      if (page.length < pageSize) break; // venue exhausted
      if (req.endTime !== undefined && cursor > req.endTime) break;
    }

    if (collected.length === 0) {
      return unavailable(`binance:klines:${req.timeframe}`, "insufficient_history", req.symbol);
    }
    return available(collected, `binance:klines:${req.timeframe}`, Date.now());
  }

  /**
   * Open time of a symbol's very first candle — the listing date.
   * Used by the eligibility filter's "listed < 90 days" rejection.
   */
  async firstCandleTime(symbol: string, market: MarketType = "spot"): Promise<Availability<number>> {
    const r = await this.get<unknown[][]>(
      `${this.base(market)}${this.prefix(market)}/klines${qs({
        symbol,
        interval: "1d",
        startTime: 0,
        limit: 1,
      })}`,
      "binance:listing",
      2,
    );
    if (!r.available) return r;
    const rows = binanceKlineRows(r.value, "1d");
    if (!rows.length) {
      return unavailable("binance:listing", "insufficient_history", symbol);
    }
    return available(rows[0].openTime, r.source, r.asOf);
  }

  async orderBook(
    symbol: string,
    depth = 100,
    market: MarketType = "spot",
  ): Promise<Availability<OrderBook>> {
    const limit = nearestDepthLimit(depth);
    const r = await this.get<BinanceDepth>(
      `${this.base(market)}${this.prefix(market)}/depth${qs({ symbol, limit })}`,
      "binance:depth",
      depthWeight(limit),
    );
    if (!r.available) return r;
    return available(
      {
        symbol,
        bids: r.value.bids.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
        asks: r.value.asks.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
        timestamp: r.asOf,
        lastUpdateId: r.value.lastUpdateId ?? 0,
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
    const r = await this.get<BinanceAggTrade[]>(
      `${this.base(market)}${this.prefix(market)}/aggTrades${qs({ symbol, limit: Math.min(limit, 1000) })}`,
      "binance:aggTrades",
      market === "perp" ? 20 : 4,
    );
    if (!r.available) return r;
    const out = r.value
      .map(
        (t): Trade => ({
          id: t.a,
          price: Number(t.p),
          quantity: Number(t.q),
          quoteQuantity: Number(t.p) * Number(t.q),
          timestamp: t.T,
          buyerIsMaker: t.m,
        }),
      )
      .sort((a, b) => a.timestamp - b.timestamp);
    return available(out, r.source, r.asOf);
  }

  async fundingRate(symbol: string): Promise<Availability<FundingRate>> {
    const r = await this.get<BinancePremiumIndex>(
      `${this.futBase}/fapi/v1/premiumIndex${qs({ symbol })}`,
      "binance:funding",
      1,
    );
    if (!r.available) return r;
    return available(
      {
        symbol,
        rate: Number(r.value.lastFundingRate),
        fundingTime: Number(r.value.nextFundingTime),
        intervalHours: 8,
      },
      r.source,
      Number(r.value.time) || r.asOf,
    );
  }

  async fundingHistory(symbol: string, limit = 200): Promise<Availability<FundingRate[]>> {
    const r = await this.get<BinanceFundingRow[]>(
      `${this.futBase}/fapi/v1/fundingRate${qs({ symbol, limit: Math.min(limit, 1000) })}`,
      "binance:fundingHistory",
      1,
    );
    if (!r.available) return r;
    const out = r.value
      .map((f): FundingRate => ({
        symbol: f.symbol,
        rate: Number(f.fundingRate),
        fundingTime: Number(f.fundingTime),
        intervalHours: 8,
      }))
      .sort((a, b) => a.fundingTime - b.fundingTime);
    return available(out, r.source, r.asOf);
  }

  async openInterest(symbol: string): Promise<Availability<OpenInterest>> {
    const r = await this.get<{ openInterest: string; symbol: string; time: number }>(
      `${this.futBase}/fapi/v1/openInterest${qs({ symbol })}`,
      "binance:openInterest",
      1,
    );
    if (!r.available) return r;
    return available(
      {
        symbol,
        openInterest: Number(r.value.openInterest),
        openInterestValue: NaN, // notional needs a mark price; the history endpoint provides it
        timestamp: Number(r.value.time) || r.asOf,
      },
      r.source,
      Number(r.value.time) || r.asOf,
    );
  }

  async openInterestHistory(
    symbol: string,
    period: "5m" | "15m" | "1h" | "4h" | "1d",
    limit = 200,
  ): Promise<Availability<OpenInterest[]>> {
    const r = await this.get<BinanceOiHistRow[]>(
      `${this.futBase}/futures/data/openInterestHist${qs({
        symbol,
        period,
        limit: Math.min(limit, 500),
      })}`,
      "binance:oiHistory",
      1,
    );
    if (!r.available) return r;
    const out = r.value
      .map((o): OpenInterest => ({
        symbol,
        openInterest: Number(o.sumOpenInterest),
        openInterestValue: Number(o.sumOpenInterestValue),
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
    const r = await this.get<BinanceLsRow[]>(
      `${this.futBase}/futures/data/globalLongShortAccountRatio${qs({
        symbol,
        period,
        limit: Math.min(limit, 500),
      })}`,
      "binance:longShort",
      1,
    );
    if (!r.available) return r;
    const out = r.value
      .map((x): LongShortRatio => ({
        symbol,
        longAccountPct: Number(x.longAccount) * 100,
        shortAccountPct: Number(x.shortAccount) * 100,
        ratio: Number(x.longShortRatio),
        timestamp: Number(x.timestamp),
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
    return available(out, r.source, r.asOf);
  }

  createStream(sub: StreamSubscription): MarketStream | null {
    return new BinanceStream(this.cfg, sub);
  }
}

// ── venue response shapes (only the fields we consume) ─────────────────────

interface BinanceFilter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
  minNotional?: string;
  notional?: string;
}

interface BinanceSymbolRow {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status?: string;
  contractStatus?: string;
  contractType?: string;
  onboardDate?: number;
  quotePrecision?: number;
  pricePrecision?: number;
  baseAssetPrecision?: number;
  quantityPrecision?: number;
  filters?: BinanceFilter[];
}

interface BinanceExchangeInfo {
  symbols?: BinanceSymbolRow[];
}

interface BinanceTicker {
  symbol: string;
  lastPrice: string;
  quoteVolume: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  bidPrice: string;
  askPrice: string;
}

interface BinanceDepth {
  lastUpdateId?: number;
  bids: [string, string][];
  asks: [string, string][];
}

interface BinanceAggTrade {
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

interface BinancePremiumIndex {
  lastFundingRate: string;
  nextFundingTime: number;
  time: number;
}

interface BinanceFundingRow {
  symbol: string;
  fundingRate: string;
  fundingTime: number;
}

interface BinanceOiHistRow {
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  timestamp: number;
}

interface BinanceLsRow {
  longAccount: string;
  shortAccount: string;
  longShortRatio: string;
  timestamp: number;
}

// ── helpers ───────────────────────────────────────────────────────────────

function indexFilters(filters: BinanceFilter[]): Record<string, BinanceFilter> {
  const out: Record<string, BinanceFilter> = {};
  for (const f of filters) out[f.filterType] = f;
  return out;
}

function mapStatus(s: string | undefined): SymbolInfo["status"] {
  if (s === "TRADING") return "trading";
  if (s === "BREAK" || s === "HALT" || s === "PENDING_TRADING") return "halted";
  return "delisted";
}

/** Decimal places implied by a tick/step size such as "0.00100000" → 3. */
function decimalsOf(size: number, fallback: number): number {
  if (!Number.isFinite(size) || size <= 0) return fallback;
  const s = size.toFixed(12).replace(/0+$/, "");
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  return s.length - dot - 1;
}

/** Binance only accepts these depth limits; anything else is rejected. */
function nearestDepthLimit(n: number): number {
  const allowed = [5, 10, 20, 50, 100, 500, 1000, 5000];
  return allowed.find((a) => a >= n) ?? 5000;
}

function depthWeight(limit: number): number {
  if (limit <= 100) return 5;
  if (limit <= 500) return 25;
  if (limit <= 1000) return 50;
  return 250;
}

function klineWeight(market: MarketType, limit: number): number {
  if (market === "spot") return 2;
  if (limit <= 100) return 1;
  if (limit <= 500) return 2;
  if (limit <= 1000) return 5;
  return 10;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
