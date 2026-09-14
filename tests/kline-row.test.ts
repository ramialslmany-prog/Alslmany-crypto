/**
 * The kline normalizer is shared by the live REST adapter and the archive
 * parser. If it drifts, backtests validate a strategy against data the live
 * bot never sees — so its edge cases are pinned here.
 */
import { describe, expect, it } from "vitest";
import { binanceKlineRow, binanceKlineRows, dedupeSorted } from "@/data/kline-row";
import { tfMillis } from "@/shared/time";

// A real Binance 1h row shape: note closeTime arrives as openTime + 1h - 1ms.
const ROW = [
  1710421200000, "71234.10000000", "71890.00000000", "70980.50000000", "71755.20000000",
  "1234.56780000", 1710424799999, "88123456.78000000", 45231,
  "700.12340000", "50012345.60000000", "0",
];

describe("binanceKlineRow", () => {
  it("parses string decimals into numbers", () => {
    const c = binanceKlineRow(ROW, "1h")!;
    expect(c.open).toBeCloseTo(71234.1, 6);
    expect(c.high).toBeCloseTo(71890, 6);
    expect(c.low).toBeCloseTo(70980.5, 6);
    expect(c.close).toBeCloseTo(71755.2, 6);
    expect(c.volume).toBeCloseTo(1234.5678, 6);
    expect(c.quoteVolume).toBeCloseTo(88123456.78, 4);
    expect(c.trades).toBe(45231);
    expect(c.takerBuyBase).toBeCloseTo(700.1234, 6);
  });

  it("normalizes closeTime to the EXCLUSIVE boundary, not Binance's -1ms", () => {
    const c = binanceKlineRow(ROW, "1h")!;
    expect(c.closeTime).toBe(c.openTime + tfMillis("1h"));
    expect(c.closeTime).toBe(1710424800000); // one ms past what Binance sent
  });

  it("rejects corrupt bars instead of passing NaN downstream", () => {
    expect(binanceKlineRow([], "1h")).toBeNull();
    expect(binanceKlineRow(["x", "1", "2", "0.5", "1", "1", 0, "1", 1, "0", "0"], "1h")).toBeNull();
    // high below low
    expect(binanceKlineRow([1, "10", "5", "9", "10", "1", 0, "1", 1, "0", "0"], "1h")).toBeNull();
    // non-positive price
    expect(binanceKlineRow([1, "0", "5", "1", "3", "1", 0, "1", 1, "0", "0"], "1h")).toBeNull();
  });

  it("derives quote volume when the venue omits it", () => {
    const row = [1, "10", "12", "9", "11", "100", 0, "", 0, "0", "0"];
    const c = binanceKlineRow(row, "1h")!;
    expect(c.quoteVolume).toBeCloseTo(100 * 11, 6);
  });
});

describe("dedupeSorted", () => {
  it("sorts ascending and keeps the LAST value for a repeated open time", () => {
    const mk = (openTime: number, close: number) => ({
      openTime, closeTime: openTime + 1, open: close, high: close, low: close,
      close, volume: 1, quoteVolume: 1, trades: 1, takerBuyBase: 0, takerBuyQuote: 0,
    });
    // A revised bar arriving after the provisional one must win.
    const out = dedupeSorted([mk(300, 3), mk(100, 1), mk(200, 2), mk(200, 99)]);
    expect(out.map((c) => c.openTime)).toEqual([100, 200, 300]);
    expect(out[1].close).toBe(99);
  });
});

describe("binanceKlineRows", () => {
  it("drops corrupt rows but keeps the good ones", () => {
    const out = binanceKlineRows([ROW, ["garbage"], ROW], "1h");
    expect(out).toHaveLength(1); // the two good rows are the same bar
  });
});
