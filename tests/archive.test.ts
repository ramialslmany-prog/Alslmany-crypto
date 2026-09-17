/**
 * Archive parsing. These are the traps that make an archive silently wrong
 * rather than loudly broken — each is pinned with a case built from a real
 * Binance Vision CSV shape.
 */
import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { BinanceVisionArchive, archiveUrl, parseMetrics } from "@/data/archive/binance-vision";
import { getConfig } from "@/shared/config";

const cfg = getConfig({ DATA_DIR: "/tmp/alslmany-test" } as unknown as NodeJS.ProcessEnv);
const archive = new BinanceVisionArchive(cfg);

const HEADERLESS =
  `1710421200000,71234.10000000,71890.00000000,70980.50000000,71755.20000000,1234.56780000,1710424799999,88123456.78000000,45231,700.12340000,50012345.60000000,0\n` +
  `1710424800000,71755.20000000,72100.00000000,71600.00000000,71980.00000000,900.00000000,1710428399999,64000000.00000000,30000,500.00000000,36000000.00000000,0\n`;

describe("parseKlineCsv", () => {
  it("parses a headerless file (the historical format)", () => {
    const out = archive.parseKlineCsv(HEADERLESS, "1h");
    expect(out).toHaveLength(2);
    expect(out[0].openTime).toBe(1710421200000);
    expect(out[0].close).toBeCloseTo(71755.2, 4);
    expect(out[1].openTime).toBe(1710424800000);
  });

  it("skips the header row that newer files carry", () => {
    const withHeader =
      "open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n" +
      HEADERLESS;
    const out = archive.parseKlineCsv(withHeader, "1h");
    expect(out).toHaveLength(2);
    expect(out[0].openTime).toBe(1710421200000);
  });

  it("normalizes MICROSECOND open times published from 2025 onward", () => {
    // Same bar, timestamps in µs. Parsed naively this lands in the year 56000.
    const micro = HEADERLESS.replace(/1710421200000/g, "1710421200000000").replace(
      /1710424800000/g,
      "1710424800000000",
    );
    const out = archive.parseKlineCsv(micro, "1h");
    expect(out).toHaveLength(2);
    expect(out[0].openTime).toBe(1710421200000);
    expect(new Date(out[0].openTime).getUTCFullYear()).toBe(2024);
  });

  it("produces the SAME candles from ms and µs files", () => {
    const micro = HEADERLESS.replace(/1710421200000/g, "1710421200000000").replace(
      /1710424800000/g,
      "1710424800000000",
    );
    expect(archive.parseKlineCsv(micro, "1h")).toEqual(archive.parseKlineCsv(HEADERLESS, "1h"));
  });

  it("tolerates CRLF line endings and a trailing blank line", () => {
    const crlf = HEADERLESS.replace(/\n/g, "\r\n") + "\r\n";
    expect(archive.parseKlineCsv(crlf, "1h")).toHaveLength(2);
  });

  it("returns nothing for an empty file rather than a bogus bar", () => {
    expect(archive.parseKlineCsv("", "1h")).toHaveLength(0);
    expect(archive.parseKlineCsv("\n\n", "1h")).toHaveLength(0);
  });
});

describe("parseAggTradeCsv", () => {
  const CSV =
    `2891234,71234.10000000,0.50000000,5000,5001,1710421200123,true,true\n` +
    `2891235,71235.00000000,1.25000000,5002,5002,1710421201456,false,true\n`;

  it("parses trades and reads the aggressor flag", () => {
    const out = archive.parseAggTradeCsv(CSV);
    expect(out).toHaveLength(2);
    expect(out[0].buyerIsMaker).toBe(true); // a sell hit the bid
    expect(out[1].buyerIsMaker).toBe(false); // a buy lifted the offer
    expect(out[1].quoteQuantity).toBeCloseTo(71235 * 1.25, 4);
  });

  it("normalizes microsecond trade timestamps too", () => {
    const micro = CSV.replace("1710421200123", "1710421200123000");
    expect(archive.parseAggTradeCsv(micro)[0].timestamp).toBe(1710421200123);
  });
});

describe("archiveUrl", () => {
  it("builds the monthly spot kline path", () => {
    expect(
      archiveUrl({ symbol: "BTCUSDT", dataType: "klines", timeframe: "1h", period: "monthly", periodKey: "2024-03", market: "spot" }),
    ).toBe("https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2024-03.zip");
  });

  it("builds the daily futures path", () => {
    expect(
      archiveUrl({ symbol: "ETHUSDT", dataType: "klines", timeframe: "5m", period: "daily", periodKey: "2024-03-14", market: "um" }),
    ).toBe("https://data.binance.vision/data/futures/um/daily/klines/ETHUSDT/5m/ETHUSDT-5m-2024-03-14.zip");
  });

  it("builds the aggTrades path (no timeframe segment)", () => {
    expect(
      archiveUrl({ symbol: "BTCUSDT", dataType: "aggTrades", period: "monthly", periodKey: "2024-03", market: "spot" }),
    ).toBe("https://data.binance.vision/data/spot/monthly/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2024-03.zip");
  });
});

describe("planKlineTargets", () => {
  it("never asks for the current month, which the venue has not published", () => {
    const now = new Date();
    const currentMonth = now.toISOString().slice(0, 7);
    const from = Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1);
    const targets = archive.planKlineTargets("BTCUSDT", "1h", from, Date.now());
    const monthly = targets.filter((t) => t.period === "monthly");
    expect(monthly.every((t) => t.periodKey < currentMonth)).toBe(true);
    expect(monthly.length).toBeGreaterThan(6);
  });

  it("covers the current partial month with daily files", () => {
    const targets = archive.planKlineTargets("BTCUSDT", "1h", Date.now() - 40 * 86_400_000, Date.now());
    expect(targets.some((t) => t.period === "daily")).toBe(true);
  });

  it("never plans a file for today (still in progress)", () => {
    const today = new Date().toISOString().slice(0, 10);
    const targets = archive.planKlineTargets("BTCUSDT", "1h", Date.now() - 10 * 86_400_000, Date.now());
    expect(targets.some((t) => t.periodKey === today)).toBe(false);
  });
});

describe("zip round-trip", () => {
  it("unzips and parses a real zip container", async () => {
    // Exercises the actual fflate path the downloader uses.
    const zipped = zipSync({ "BTCUSDT-1h-2024-03.csv": strToU8(HEADERLESS) });
    const { unzipSync } = await import("fflate");
    const files = unzipSync(zipped);
    const name = Object.keys(files).find((k) => k.endsWith(".csv"))!;
    const csv = new TextDecoder().decode(files[name]);
    expect(archive.parseKlineCsv(csv, "1h")).toHaveLength(2);
  });
});


// ── derivatives metrics ──────────────────────────────────────────────────────

describe("the derivatives metrics archive", () => {
  const csv = [
    "create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio",
    "2024-06-01 00:00:00,BTCUSDT,78000.5,5200000000,1.85,1.42,2.10,0.98",
    "2024-06-01 00:05:00,BTCUSDT,78100.0,5210000000,1.80,1.40,2.05,1.02",
  ].join("\n");

  it("reads the formatted UTC timestamp, not an epoch", () => {
    // This is the one file in the archive whose time column is a formatted
    // string. Reading it as a number yields NaN and silently drops every row.
    const rows = parseMetrics(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].timestamp).toBe(Date.UTC(2024, 5, 1, 0, 0, 0));
    expect(rows[1].timestamp).toBe(Date.UTC(2024, 5, 1, 0, 5, 0));
  });

  it("reads open interest and both ratios", () => {
    const [first] = parseMetrics(csv);
    expect(first.openInterest).toBeCloseTo(78_000.5, 6);
    expect(first.openInterestValue).toBeCloseTo(5_200_000_000, 6);
    expect(first.accountRatio).toBeCloseTo(2.1, 6);
    expect(first.takerVolumeRatio).toBeCloseTo(0.98, 6);
  });

  it("treats a BLANK ratio as unknown, never as zero", () => {
    // Binance leaves these empty for illiquid symbols. A zero ratio would be
    // a claim that every account is short.
    const blank = "2024-06-01 00:00:00,XUSDT,10,100,,,,";
    const [row] = parseMetrics(blank);
    expect(row.accountRatio).toBeNull();
    expect(row.topTraderAccountRatio).toBeNull();
    expect(row.takerVolumeRatio).toBeNull();
  });

  it("skips the header and any malformed row rather than failing the file", () => {
    const messy = `${csv}\nnot,a,real,row\n`;
    expect(parseMetrics(messy)).toHaveLength(2);
  });

  it("builds the metrics URL under the FUTURES root, not spot", () => {
    // Metrics exist for USD-M futures only; a spot path is a guaranteed 404.
    expect(archiveUrl({
      symbol: "BTCUSDT", dataType: "metrics", period: "daily",
      periodKey: "2024-06-01", market: "um",
    })).toBe(
      "https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-2024-06-01.zip",
    );
  });

  it("returns rows oldest first, whatever order they arrived in", () => {
    const reversed = [
      "2024-06-01 00:05:00,BTCUSDT,78100.0,5210000000,1.80,1.40,2.05,1.02",
      "2024-06-01 00:00:00,BTCUSDT,78000.5,5200000000,1.85,1.42,2.10,0.98",
    ].join("\n");
    const rows = parseMetrics(reversed);
    expect(rows[0].timestamp).toBeLessThan(rows[1].timestamp);
  });
});
