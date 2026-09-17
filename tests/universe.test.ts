/**
 * Universe selection.
 *
 * The rule being pinned is that volume alone does not make a pair analysable.
 * The very first real run of the backfill downloaded USDCUSDT as rank 1 — a
 * pair with billions of daily turnover and no trend to read.
 */
import { describe, expect, it } from "vitest";
import { baseOf, isUntradablePair, selectUniverse } from "@/core/universe";

describe("what cannot be analysed", () => {
  it("excludes stablecoin pairs however large their volume", () => {
    for (const s of ["USDCUSDT", "FDUSDUSDT", "TUSDUSDT", "DAIUSDT", "BUSDUSDT"]) {
      expect(isUntradablePair(s, "USDT")).toBe(true);
    }
  });

  it("excludes leveraged tokens, whose chart is not the underlying's", () => {
    for (const s of ["BTCUPUSDT", "ETHDOWNUSDT", "BTC3LUSDT", "ETH3SUSDT"]) {
      expect(isUntradablePair(s, "USDT")).toBe(true);
    }
  });

  it("keeps ordinary coins whose ticker merely ENDS in a suffix", () => {
    // JUP is a real coin that ends in "UP". The first version of this filter
    // excluded it, and that failure is the invisible kind: nobody notices the
    // asset that was never analysed. A leveraged token needs a real base in
    // front of the suffix.
    for (const s of ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOTUSDT", "JUPUSDT", "SUPUSDT"]) {
      expect(isUntradablePair(s, "USDT")).toBe(false);
    }
  });

  it("reads the base by stripping the quote, not by guessing", () => {
    expect(baseOf("BTCUSDT", "USDT")).toBe("BTC");
    expect(baseOf("USDCUSDT", "USDT")).toBe("USDC");
  });
});

describe("selection", () => {
  const rows = [
    { symbol: "USDCUSDT", quoteVolume: 9_000_000_000 },
    { symbol: "FDUSDUSDT", quoteVolume: 8_000_000_000 },
    { symbol: "BTCUSDT", quoteVolume: 3_000_000_000 },
    { symbol: "ETHUSDT", quoteVolume: 2_000_000_000 },
    { symbol: "SOLUSDT", quoteVolume: 1_000_000_000 },
    { symbol: "BTCUPUSDT", quoteVolume: 500_000_000 },
    { symbol: "ETHBTC", quoteVolume: 700_000_000 },
  ];

  it("excludes BEFORE the cut, so top-N means N tradable coins", () => {
    // Cutting first would spend two of three slots on stablecoin pairs.
    const { symbols } = selectUniverse(rows, "USDT", 3);
    expect(symbols).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  });

  it("reports what it removed rather than dropping it silently", () => {
    const { excluded } = selectUniverse(rows, "USDT", 3);
    expect(excluded).toContain("USDCUSDT");
    expect(excluded).toContain("BTCUPUSDT");
  });

  it("ignores pairs quoted in something else entirely", () => {
    const { symbols, excluded } = selectUniverse(rows, "USDT", 10);
    expect(symbols).not.toContain("ETHBTC");
    expect(excluded).not.toContain("ETHBTC");
  });

  it("ranks by volume, not by the order it received them", () => {
    const shuffled = [...rows].reverse();
    expect(selectUniverse(shuffled, "USDT", 2).symbols).toEqual(["BTCUSDT", "ETHUSDT"]);
  });
});
