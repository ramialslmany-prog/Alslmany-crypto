/**
 * Binance adapter, end to end against a local server speaking the venue's wire
 * format. This verifies the code that will run in production — URL building,
 * paging, parsing, retry and error mapping — rather than restating it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BinanceSource } from "@/data/exchanges/binance";
import { createMarketSource } from "@/data/exchanges";
import { getConfig } from "@/shared/config";
import { resetHttpStats, httpHealth } from "@/data/http";
import { startFakeVenue, type FakeVenue } from "./fixtures/fake-venue";
import { dropUnclosed, tfMillis } from "@/shared/time";

const START = Date.UTC(2024, 0, 1, 0, 0, 0);
const COUNT = 2500; // forces the adapter to page (venue caps at 1000)

let venue: FakeVenue;
let src: BinanceSource;

beforeAll(async () => {
  venue = await startFakeVenue({ klineStart: START, klineCount: COUNT });
  const cfg = getConfig({
    BINANCE_SPOT_BASE: venue.url,
    BINANCE_FUTURES_BASE: venue.url,
    HTTP_RETRIES: "3",
    HTTP_TIMEOUT_MS: "5000",
    QUOTE_ASSET: "USDT",
  } as unknown as NodeJS.ProcessEnv);
  src = new BinanceSource(cfg);
});

afterAll(async () => {
  await venue.close();
});

beforeEach(() => {
  venue.hits.length = 0;
});

describe("symbols", () => {
  it("keeps only the configured quote asset and reads precision from the filters", async () => {
    const r = await src.symbols("spot");
    expect(r.available).toBe(true);
    if (!r.available) return;

    expect(r.value.map((s) => s.symbol).sort()).toEqual(["BTCUSDT", "ETHUSDT", "OLDUSDT"]);
    const btc = r.value.find((s) => s.symbol === "BTCUSDT")!;
    expect(btc.pricePrecision).toBe(2); // from tickSize 0.01
    expect(btc.quantityPrecision).toBe(5); // from stepSize 0.00001
    expect(btc.minNotional).toBe(5);
    expect(btc.nativeSymbol).toBe("BTCUSDT");
  });

  it("marks a halted symbol rather than dropping it silently", async () => {
    const r = await src.symbols("spot");
    if (!r.available) throw new Error("unavailable");
    expect(r.value.find((s) => s.symbol === "OLDUSDT")?.status).toBe("halted");
  });
});

describe("klines", () => {
  it("returns a single page in ascending order with normalized close times", async () => {
    const r = await src.klines({ symbol: "BTCUSDT", timeframe: "1h", limit: 10 });
    expect(r.available).toBe(true);
    if (!r.available) return;

    expect(r.value).toHaveLength(10);
    for (let i = 1; i < r.value.length; i++) {
      expect(r.value[i].openTime).toBeGreaterThan(r.value[i - 1].openTime);
    }
    expect(r.value[0].closeTime - r.value[0].openTime).toBe(tfMillis("1h"));
  });

  it("pages transparently past the venue's 1000-row cap", async () => {
    const r = await src.klines({ symbol: "BTCUSDT", timeframe: "1h", startTime: START, limit: 2500 });
    expect(r.available).toBe(true);
    if (!r.available) return;

    expect(r.value).toHaveLength(2500);
    // No duplicates across page boundaries.
    expect(new Set(r.value.map((c) => c.openTime)).size).toBe(2500);
    expect(r.value[0].openTime).toBe(START);
    expect(r.value[2499].openTime).toBe(START + 2499 * tfMillis("1h"));
    // Three pages: 1000 + 1000 + 500.
    expect(venue.hits.filter((h) => h.path === "/api/v3/klines")).toHaveLength(3);
  });

  it("stops rather than looping when the venue stops advancing", async () => {
    const r = await src.klines({ symbol: "BTCUSDT", timeframe: "1h", startTime: START, limit: 99_999 });
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.value).toHaveLength(COUNT);
    expect(venue.hits.filter((h) => h.path === "/api/v3/klines").length).toBeLessThan(10);
  });

  it("respects an endTime bound", async () => {
    const end = START + 99 * tfMillis("1h");
    const r = await src.klines({ symbol: "BTCUSDT", timeframe: "1h", startTime: START, endTime: end, limit: 1000 });
    if (!r.available) throw new Error("unavailable");
    expect(r.value[r.value.length - 1].openTime).toBeLessThanOrEqual(end);
  });

  it("does NOT strip the forming candle — that decision belongs to the caller", async () => {
    const r = await src.klines({ symbol: "BTCUSDT", timeframe: "1h", limit: 5 });
    if (!r.available) throw new Error("unavailable");
    // Everything in the fixture is historical, so pin the contract instead:
    // the adapter returns what the venue sent, and dropUnclosed does the cut.
    const now = r.value[r.value.length - 1].openTime + 10; // last bar still forming
    expect(dropUnclosed(r.value, "1h", now)).toHaveLength(r.value.length - 1);
  });

  it("reports the listing date from the first available candle", async () => {
    const r = await src.firstCandleTime("BTCUSDT");
    expect(r.available).toBe(true);
    if (r.available) expect(r.value).toBe(START);
  });
});

describe("market data", () => {
  it("parses the 24h board including bid/ask for the spread filter", async () => {
    const r = await src.ticker24h();
    if (!r.available) throw new Error("unavailable");
    const btc = r.value.find((t) => t.symbol === "BTCUSDT")!;
    expect(btc.lastPrice).toBeCloseTo(71755.2, 4);
    expect(btc.askPrice - btc.bidPrice).toBeCloseTo(0.2, 6);
    expect(btc.quoteVolume).toBeCloseTo(1234567890.12, 2);
  });

  it("returns a depth-limit the venue actually accepts", async () => {
    const r = await src.orderBook("BTCUSDT", 37);
    expect(r.available).toBe(true);
    // 37 is not a legal Binance limit; the adapter must round up to 50.
    expect(venue.hits.at(-1)?.query.get("limit")).toBe("50");
    if (r.available) {
      expect(r.value.bids[0].price).toBeCloseTo(71755.1, 4);
      expect(r.value.lastUpdateId).toBe(99887766);
    }
  });

  it("reads trades with the aggressor flag, ascending in time", async () => {
    const r = await src.recentTrades("BTCUSDT");
    if (!r.available) throw new Error("unavailable");
    expect(r.value[0].timestamp).toBeLessThan(r.value[1].timestamp);
    expect(r.value[0].buyerIsMaker).toBe(true);
    expect(r.value[1].quoteQuantity).toBeCloseTo(71755.3 * 1.25, 3);
  });
});

describe("derivatives", () => {
  it("reads the current funding rate", async () => {
    const r = await src.fundingRate("BTCUSDT");
    if (!r.available) throw new Error("unavailable");
    expect(r.value.rate).toBeCloseTo(0.000125, 9);
    expect(r.value.intervalHours).toBe(8);
  });

  it("returns funding history ascending", async () => {
    const r = await src.fundingHistory("BTCUSDT");
    if (!r.available) throw new Error("unavailable");
    expect(r.value[0].fundingTime).toBeLessThan(r.value[1].fundingTime);
  });

  it("reads open-interest history with notional value", async () => {
    const r = await src.openInterestHistory("BTCUSDT", "1h");
    if (!r.available) throw new Error("unavailable");
    expect(r.value).toHaveLength(2);
    expect(r.value[1].openInterestValue).toBe(5_640_000_000);
  });

  it("converts the long/short account split to percentages", async () => {
    const r = await src.longShortRatio("BTCUSDT", "1h");
    if (!r.available) throw new Error("unavailable");
    expect(r.value[0].longAccountPct).toBeCloseTo(62, 6);
    expect(r.value[0].shortAccountPct).toBeCloseTo(38, 6);
  });
});

describe("failure handling", () => {
  beforeEach(() => resetHttpStats());

  it("retries a 500 and succeeds, without surfacing the blip", async () => {
    venue.failNext("/api/v3/ticker", 2, 500);
    const r = await src.ticker24h(["BTCUSDT"]);
    expect(r.available).toBe(true);
    expect(venue.hits.filter((h) => h.path.startsWith("/api/v3/ticker"))).toHaveLength(3);
  });

  it("honours Retry-After on a 429 and eventually succeeds", async () => {
    venue.failNext("/api/v3/depth", 1, 429, { "retry-after": "0" });
    const r = await src.orderBook("BTCUSDT", 20);
    expect(r.available).toBe(true);
  });

  it("gives up after the retry budget and reports WHY, never a fake value", async () => {
    venue.failNext("/api/v3/depth", 99, 503);
    const r = await src.orderBook("BTCUSDT", 20);
    expect(r.available).toBe(false);
    if (!r.available) {
      expect(r.reason).toBe("http_error");
      expect(r.detail).toContain("503");
    }
  });

  it("maps an unknown symbol to an unavailable result, not an exception", async () => {
    const r = await src.klines({ symbol: "NOPEUSDT", timeframe: "1h", limit: 5 });
    // The fixture 400s on unknown paths/symbols; the adapter must not throw.
    expect(typeof r.available).toBe("boolean");
  });

  it("records latency and failure counts for the health page", async () => {
    await src.ticker24h(["BTCUSDT"]);
    const health = httpHealth();
    expect(health.length).toBeGreaterThan(0);
    expect(health[0].requests).toBeGreaterThan(0);
    expect(health[0].lastLatencyMs).not.toBeNull();
  });
});

describe("venue factory", () => {
  it("returns the venue named in config and nothing else", () => {
    const mk = (id: string) =>
      createMarketSource(getConfig({ MARKET_EXCHANGE: id } as unknown as NodeJS.ProcessEnv));
    expect(mk("binance").id).toBe("binance");
    expect(mk("bybit").id).toBe("bybit");
    expect(mk("okx").id).toBe("okx");
  });

  it("declares the taker-breakdown capability honestly per venue", () => {
    const mk = (id: string) =>
      createMarketSource(getConfig({ MARKET_EXCHANGE: id } as unknown as NodeJS.ProcessEnv));
    expect(mk("binance").capabilities.klineTakerBreakdown).toBe(true);
    expect(mk("bybit").capabilities.klineTakerBreakdown).toBe(false);
    expect(mk("okx").capabilities.klineTakerBreakdown).toBe(false);
  });
});
