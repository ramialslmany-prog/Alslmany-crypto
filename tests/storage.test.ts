/**
 * Storage invariants. The candle table is the substrate every later stage
 * reads, so its idempotency and ordering guarantees are pinned here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, openDb, type Db } from "@/storage/db";
import { CandleRepo } from "@/storage/repositories/candles";
import { SymbolRepo } from "@/storage/repositories/symbols";
import { HealthRepo } from "@/storage/repositories/health";
import { ArchiveRepo } from "@/storage/repositories/archive";
import { available, unavailable } from "@/shared/availability";
import { tfMillis } from "@/shared/time";
import type { Candle, SymbolInfo } from "@/core/types";

let dir: string;
let db: Db;

const H = tfMillis("1h");
const BASE = Date.UTC(2024, 2, 14, 0, 0, 0);

function candle(i: number, over: Partial<Candle> = {}): Candle {
  const openTime = BASE + i * H;
  return {
    openTime,
    closeTime: openTime + H,
    open: 100 + i,
    high: 110 + i,
    low: 90 + i,
    close: 105 + i,
    volume: 10,
    quoteVolume: 1000,
    trades: 5,
    takerBuyBase: 6,
    takerBuyQuote: 600,
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alslmany-"));
  db = openDb(path.join(dir, "test.db"));
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("migrations", () => {
  it("creates the schema and is safe to run twice", () => {
    const applied = db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    expect(applied.n).toBeGreaterThan(0);
    const again = openDb(path.join(dir, "test.db"));
    expect(again.prepare("SELECT COUNT(*) AS n FROM candles").get()).toEqual({ n: 0 });
  });

  it("enables WAL so the site can read while the worker writes", () => {
    expect(String(db.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
  });
});

describe("CandleRepo", () => {
  it("writing the same bars twice does not duplicate or double volume", () => {
    const repo = new CandleRepo(db);
    const bars = [candle(0), candle(1), candle(2)];
    repo.upsertMany("BTCUSDT", "1h", bars);
    repo.upsertMany("BTCUSDT", "1h", bars);
    expect(repo.coverage("BTCUSDT", "1h")).toMatchObject({ count: 3 });
    const sum = db.prepare("SELECT SUM(volume) AS v FROM candles").get() as { v: number };
    expect(sum.v).toBe(30);
  });

  it("always returns bars ascending by open time regardless of write order", () => {
    const repo = new CandleRepo(db);
    repo.upsertMany("BTCUSDT", "1h", [candle(5), candle(1), candle(3)]);
    const out = repo.latest("BTCUSDT", "1h", 10);
    expect(out.map((c) => c.openTime)).toEqual([BASE + H, BASE + 3 * H, BASE + 5 * H]);
  });

  it("a later REST bar corrects an earlier one", () => {
    const repo = new CandleRepo(db);
    repo.upsertMany("BTCUSDT", "1h", [candle(0, { close: 100 })], "ws");
    repo.upsertMany("BTCUSDT", "1h", [candle(0, { close: 999 })], "rest");
    expect(repo.latest("BTCUSDT", "1h", 1)[0].close).toBe(999);
  });

  it("the archive is authoritative: it overwrites live bars, never the reverse", () => {
    const repo = new CandleRepo(db);
    repo.upsertMany("BTCUSDT", "1h", [candle(0, { close: 111 })], "ws");
    repo.upsertMany("BTCUSDT", "1h", [candle(0, { close: 222 })], "archive");
    expect(repo.latest("BTCUSDT", "1h", 1)[0].close).toBe(222);

    // A websocket bar must NOT clobber settled archive history.
    repo.upsertMany("BTCUSDT", "1h", [candle(0, { close: 333 })], "ws");
    expect(repo.latest("BTCUSDT", "1h", 1)[0].close).toBe(222);
  });

  it("keeps timeframes and symbols isolated", () => {
    const repo = new CandleRepo(db);
    repo.upsertMany("BTCUSDT", "1h", [candle(0)]);
    repo.upsertMany("BTCUSDT", "4h", [candle(0)]);
    repo.upsertMany("ETHUSDT", "1h", [candle(0)]);
    expect(repo.coverage("BTCUSDT", "1h")?.count).toBe(1);
    expect(repo.storedSeries()).toHaveLength(3);
  });

  it("finds the exact span and size of a hole", () => {
    const repo = new CandleRepo(db);
    repo.upsertMany("BTCUSDT", "1h", [candle(0), candle(1), candle(5), candle(6)]);
    const gaps = repo.findGaps("BTCUSDT", "1h");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].missingBars).toBe(3);
    expect(gaps[0].gapStart).toBe(BASE + 2 * H);
    expect(gaps[0].gapEnd).toBe(BASE + 4 * H);
  });

  it("reports no gaps for a contiguous series", () => {
    const repo = new CandleRepo(db);
    repo.upsertMany("BTCUSDT", "1h", [0, 1, 2, 3].map((i) => candle(i)));
    expect(repo.findGaps("BTCUSDT", "1h")).toHaveLength(0);
  });

  it("ranks by average traded value, not by total or by name", () => {
    const repo = new CandleRepo(db);
    repo.upsertMany("BTCUSDT", "1h", [0, 1, 2, 3].map((i) => candle(i, { quoteVolume: 500 })));
    repo.upsertMany("ETHUSDT", "1h", [0, 1, 2, 3].map((i) => candle(i, { quoteVolume: 900 })));
    repo.upsertMany("XRPUSDT", "1h", [0, 1, 2, 3].map((i) => candle(i, { quoteVolume: 100 })));
    const ranked = repo.rankByLiquidity("1h", 0);
    expect(ranked.map((r) => r.symbol)).toEqual(["ETHUSDT", "BTCUSDT", "XRPUSDT"]);
    expect(ranked[0]).toMatchObject({ avgQuoteVolume: 900, bars: 4 });
  });

  it("the ranking does not mix timeframes or reach before the window", () => {
    const repo = new CandleRepo(db);
    repo.upsertMany("BTCUSDT", "1h", [0, 1].map((i) => candle(i, { quoteVolume: 500 })));
    repo.upsertMany("ETHUSDT", "4h", [0, 1].map((i) => candle(i, { quoteVolume: 9000 })));
    expect(repo.rankByLiquidity("1h", 0).map((r) => r.symbol)).toEqual(["BTCUSDT"]);
    // Bar 0 closes at BASE + H, so a window opening after that keeps only bar 1.
    expect(repo.rankByLiquidity("1h", BASE + H + 1)[0].bars).toBe(1);
  });

  it("minBars drops a symbol whose history is too short to rank", () => {
    const repo = new CandleRepo(db);
    repo.upsertMany("BTCUSDT", "1h", [0, 1, 2, 3].map((i) => candle(i)));
    repo.upsertMany("NEWUSDT", "1h", [candle(3, { quoteVolume: 1e9 })]);
    expect(repo.rankByLiquidity("1h", 0).map((r) => r.symbol)).toEqual(["NEWUSDT", "BTCUSDT"]);
    expect(repo.rankByLiquidity("1h", 0, 2).map((r) => r.symbol)).toEqual(["BTCUSDT"]);
  });

  it("latestAsOf never returns a bar from after the cutoff", () => {
    const repo = new CandleRepo(db);
    repo.upsertMany("BTCUSDT", "1h", [0, 1, 2, 3, 4].map((i) => candle(i)));
    const out = repo.latestAsOf("BTCUSDT", "1h", BASE + 2 * H, 10);
    expect(out.map((c) => c.openTime)).toEqual([BASE, BASE + H, BASE + 2 * H]);
  });
});

describe("SymbolRepo", () => {
  const info = (over: Partial<SymbolInfo> = {}): SymbolInfo => ({
    symbol: "BTCUSDT", nativeSymbol: "BTCUSDT", base: "BTC", quote: "USDT",
    market: "spot", status: "trading", pricePrecision: 2, quantityPrecision: 5,
    minNotional: 10, ...over,
  });

  it("never overwrites a known listing date with null", () => {
    const repo = new SymbolRepo(db);
    repo.upsertMany("binance", [info({ listedAt: 1_500_000_000_000 })]);
    repo.upsertMany("binance", [info({ listedAt: undefined })]);
    expect(repo.get("binance", "spot", "BTCUSDT")?.listedAt).toBe(1_500_000_000_000);
  });

  it("lists symbols still needing a listing-date lookup", () => {
    const repo = new SymbolRepo(db);
    repo.upsertMany("binance", [info(), info({ symbol: "ETHUSDT", base: "ETH", listedAt: 1 })]);
    expect(repo.missingListingDate("binance", "spot")).toEqual(["BTCUSDT"]);
    repo.setListedAt("binance", "spot", "BTCUSDT", 42);
    expect(repo.missingListingDate("binance", "spot")).toEqual([]);
  });

  it("excludes halted and delisted symbols from the tradable set", () => {
    const repo = new SymbolRepo(db);
    repo.upsertMany("binance", [info(), info({ symbol: "XYZUSDT", base: "XYZ", status: "delisted" })]);
    expect(repo.tradable("binance").map((s) => s.symbol)).toEqual(["BTCUSDT"]);
  });
});

describe("HealthRepo", () => {
  it("records successes and failures with an Arabic reason", () => {
    const repo = new HealthRepo(db);
    repo.record("binance:klines", "بايننس", available([], "binance", Date.now()));
    repo.record("binance:klines", "بايننس", unavailable("binance", "rate_limited", "HTTP 429"));
    const h = repo.get("binance:klines")!;
    expect(h.okCount).toBe(1);
    expect(h.failCount).toBe(1);
    expect(h.lastReason).toBe("rate_limited");
    expect(h.lastReasonAr).toBe("تجاوز حدّ الطلبات");
    // A past success stays visible: failure does not erase history.
    expect(h.lastOkAt).not.toBeNull();
  });
});

describe("ArchiveRepo", () => {
  const target = {
    symbol: "BTCUSDT", dataType: "klines" as const, timeframe: "1h" as const,
    period: "monthly" as const, periodKey: "2024-03", market: "spot" as const,
  };

  it("tracks imported vs permanently-missing files so runs are resumable", () => {
    const repo = new ArchiveRepo(db);
    expect(repo.isImported(target)).toBe(false);
    repo.record(target, "http://x", "imported", { rowsImported: 744, checksumOk: true });
    expect(repo.isImported(target)).toBe(true);
    expect(repo.isKnownMissing(target)).toBe(false);

    const gone = { ...target, periodKey: "2017-01" };
    repo.record(gone, "http://x", "missing");
    expect(repo.isKnownMissing(gone)).toBe(true);
  });

  it("flags imports whose checksum could not be verified", () => {
    const repo = new ArchiveRepo(db);
    repo.record(target, "http://x", "imported", { checksumOk: true });
    repo.record({ ...target, periodKey: "2024-04" }, "http://x", "imported", { checksumOk: null });
    const unverified = repo.unverified();
    expect(unverified).toHaveLength(1);
    expect(unverified[0].periodKey).toBe("2024-04");
  });
});
