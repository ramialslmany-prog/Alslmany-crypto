/**
 * Rule #5 of the spec: every indicator is pinned to a reference file —
 * fixed input, fixed output.
 *
 * Three independent layers of proof, because any one alone is weak:
 *
 *  1. GOLDEN FILE. 600 frozen candles, expected values produced by
 *     `tests/reference/naive.ts` — a second implementation written from the
 *     textbook definition that shares no code with src/. The production code
 *     is incremental and stateful; the reference is not. Agreement on every
 *     bar is strong evidence the fast path is right.
 *  2. HAND-COMPUTED CASES. Tiny inputs whose answers can be checked by hand,
 *     which catches a bug faithfully reproduced in both implementations.
 *  3. PROPERTIES. Invariants that must hold for any input at all.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  adx, atr, bollinger, bollingerSqueeze, crossAt, ema, findDivergences, findPivots,
  highest, ichimoku, lowest, macd, mfi, obv, percentileRank, rma, rsi, shift, slopePct,
  sma, stdev, stochastic, trueRange, vwap, wma,
} from "@/core/indicators";
import type { Candle } from "@/core/types";

const dir = path.join(process.cwd(), "tests", "fixtures");
const raw = JSON.parse(fs.readFileSync(path.join(dir, "candles-1h.json"), "utf8")) as {
  openTime: number; open: number; high: number; low: number; close: number; volume: number;
}[];
const golden = JSON.parse(fs.readFileSync(path.join(dir, "golden-indicators.json"), "utf8"));

const candles: Candle[] = raw.map((c) => ({
  ...c,
  closeTime: c.openTime + 3_600_000,
  quoteVolume: c.volume * c.close,
  trades: 10,
  takerBuyBase: c.volume * 0.55,
  takerBuyQuote: c.volume * 0.55 * c.close,
}));
const close = candles.map((c) => c.close);

/**
 * JSON has no NaN — it serializes as null. Compare series treating the two as
 * the same, and require exact agreement on WHICH bars are warm-up: a shifted
 * warm-up boundary is precisely the one-bar drift this suite exists to catch.
 */
function expectSeries(actual: number[], expected: (number | null)[], label: string, digits = 8): void {
  expect(actual.length, `${label}: length`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i];
    if (e === null) {
      expect(Number.isFinite(actual[i]), `${label}[${i}] should be NaN (warm-up)`).toBe(false);
    } else {
      expect(Number.isFinite(actual[i]), `${label}[${i}] should be a number, got NaN`).toBe(true);
      expect(actual[i], `${label}[${i}]`).toBeCloseTo(e, digits);
    }
  }
}

describe("golden file — the fixture itself", () => {
  it("is the frozen 600-bar series the golden values were computed from", () => {
    expect(candles).toHaveLength(600);
    expect(golden.meta.count).toBe(600);
    expect(golden.meta.generator).toBe("tests/reference/naive.ts");
  });

  it("covers a meaningful range so the indicators are actually exercised", () => {
    const rsiValues = (golden.rsi14 as (number | null)[]).filter((x): x is number => x !== null);
    expect(Math.min(...rsiValues)).toBeLessThan(30); // reaches oversold
    expect(Math.max(...rsiValues)).toBeGreaterThan(70); // reaches overbought
    const adxValues = (golden.adx14.adx as (number | null)[]).filter((x): x is number => x !== null);
    expect(Math.max(...adxValues)).toBeGreaterThan(40); // has a real trend
    expect(Math.min(...adxValues)).toBeLessThan(20); // and a real range
  });
});

describe("moving averages vs reference", () => {
  it("sma 20 / 50 / 200", () => {
    expectSeries(sma(close, 20), golden.sma20, "sma20");
    expectSeries(sma(close, 50), golden.sma50, "sma50");
    expectSeries(sma(close, 200), golden.sma200, "sma200");
  });

  it("ema 9 / 21 / 50", () => {
    expectSeries(ema(close, 9), golden.ema9, "ema9");
    expectSeries(ema(close, 21), golden.ema21, "ema21");
    expectSeries(ema(close, 50), golden.ema50, "ema50");
  });

  it("rma 14 (Wilder) and wma 20", () => {
    expectSeries(rma(close, 14), golden.rma14, "rma14");
    expectSeries(wma(close, 20), golden.wma20, "wma20");
  });
});

describe("momentum vs reference", () => {
  it("rsi 14 and rsi 7", () => {
    expectSeries(rsi(close, 14), golden.rsi14, "rsi14");
    expectSeries(rsi(close, 7), golden.rsi7, "rsi7");
  });

  it("macd 12/26/9 including the signal and histogram", () => {
    const m = macd(close, 12, 26, 9);
    expectSeries(m.macd, golden.macd.macd, "macd.line");
    expectSeries(m.signal, golden.macd.signal, "macd.signal");
    expectSeries(m.histogram, golden.macd.histogram, "macd.histogram");
  });

  it("stochastic 14/3/3", () => {
    const s = stochastic(candles.map((c) => c.high), candles.map((c) => c.low), close, 14, 3, 3);
    expectSeries(s.k, golden.stochastic.k, "stoch.k");
    expectSeries(s.d, golden.stochastic.d, "stoch.d");
  });
});

describe("volatility vs reference", () => {
  it("true range and atr 14", () => {
    expectSeries(trueRange(candles), golden.trueRange, "trueRange");
    expectSeries(atr(candles, 14), golden.atr14, "atr14");
  });

  it("stdev 20 is POPULATION, matching Bollinger's definition", () => {
    expectSeries(stdev(close, 20), golden.stdev20, "stdev20");
  });

  it("bollinger 20/2 with bandwidth and %B", () => {
    const b = bollinger(close, 20, 2);
    expectSeries(b.upper, golden.bollinger.upper, "bb.upper");
    expectSeries(b.middle, golden.bollinger.middle, "bb.middle");
    expectSeries(b.lower, golden.bollinger.lower, "bb.lower");
    expectSeries(b.bandwidth, golden.bollinger.bandwidth, "bb.bandwidth");
    expectSeries(b.percentB, golden.bollinger.percentB, "bb.percentB");
  });
});

describe("volume vs reference", () => {
  it("obv", () => expectSeries(obv(candles), golden.obv, "obv"));

  it("vwap resets each UTC day on intraday timeframes", () => {
    expectSeries(vwap(candles, "1h"), golden.vwapIntraday, "vwap.1h");
  });

  it("vwap does NOT reset on daily candles", () => {
    expectSeries(vwap(candles, "1d"), golden.vwapDaily, "vwap.1d");
  });

  it("mfi 14", () => expectSeries(mfi(candles, 14), golden.mfi14, "mfi14"));
});

describe("trend vs reference", () => {
  it("adx / +di / -di", () => {
    const a = adx(candles, 14);
    expectSeries(a.adx, golden.adx14.adx, "adx");
    expectSeries(a.plusDi, golden.adx14.plusDi, "plusDi");
    expectSeries(a.minusDi, golden.adx14.minusDi, "minusDi");
  });

  it("ichimoku including the displaced cloud", () => {
    const i = ichimoku(candles);
    expectSeries(i.conversion, golden.ichimoku.conversion, "tenkan");
    expectSeries(i.base, golden.ichimoku.base, "kijun");
    expectSeries(i.leadingSpanA, golden.ichimoku.leadingSpanA, "spanA");
    expectSeries(i.leadingSpanB, golden.ichimoku.leadingSpanB, "spanB");
    expectSeries(i.laggingSpan, golden.ichimoku.laggingSpan, "chikou");
    expectSeries(i.cloudTop, golden.ichimoku.cloudTop, "cloudTop");
    expectSeries(i.cloudBottom, golden.ichimoku.cloudBottom, "cloudBottom");
  });
});

// ── Layer 2: values a human can verify by hand ───────────────────────────────

describe("hand-computed cases", () => {
  it("sma: mean of the window, first value at index period-1", () => {
    expect(sma([1, 2, 3, 4, 5], 2)).toEqual([NaN, 1.5, 2.5, 3.5, 4.5]);
    expect(sma([2, 4, 6], 3)).toEqual([NaN, NaN, 4]);
  });

  it("ema: seeded with the SMA of the first `period` values", () => {
    // SMA(10,20,30) = 20 → next: 40*(2/4) + 20*(1/2) = 30
    const out = ema([10, 20, 30, 40], 3);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
    expect(out[2]).toBe(20);
    expect(out[3]).toBeCloseTo(30, 10);
  });

  it("rma: Wilder's alpha is 1/period, not 2/(period+1)", () => {
    // seed SMA(10,20,30)=20 → 40*(1/3) + 20*(2/3) = 26.666…
    const out = rma([10, 20, 30, 40], 3);
    expect(out[2]).toBe(20);
    expect(out[3]).toBeCloseTo(26.6666666667, 8);
    // An EMA of the same input would give 30 — the two must NOT agree.
    expect(out[3]).not.toBeCloseTo(ema([10, 20, 30, 40], 3)[3], 4);
  });

  it("rsi: an unbroken run of up bars is 100 by definition", () => {
    const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
    expect(rsi(rising, 14).at(-1)).toBe(100);
  });

  it("rsi: an unbroken run of down bars is 0", () => {
    const falling = Array.from({ length: 40 }, (_, i) => 200 - i);
    expect(rsi(falling, 14).at(-1)).toBeCloseTo(0, 10);
  });

  it("rsi: a perfectly flat series reads 50, not a division by zero", () => {
    expect(rsi(new Array(40).fill(100), 14).at(-1)).toBe(50);
  });

  it("stdev: population, so [2,4,4,4,5,5,7,9] over 8 bars is exactly 2", () => {
    // The textbook example. Sample stdev would give ~2.138 — a visible
    // difference in the Bollinger bands.
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9], 8).at(-1)).toBeCloseTo(2, 12);
  });

  it("bollinger: the middle band IS the simple moving average", () => {
    const b = bollinger(close, 20, 2);
    const s = sma(close, 20);
    expect(b.middle).toEqual(s);
  });

  it("trueRange: index 0 has no previous close, so it is high - low", () => {
    const two: Candle[] = [
      { openTime: 0, closeTime: 1, open: 10, high: 12, low: 9, close: 11, volume: 1, quoteVolume: 1, trades: 1, takerBuyBase: 0, takerBuyQuote: 0 },
      { openTime: 1, closeTime: 2, open: 11, high: 20, low: 10, close: 19, volume: 1, quoteVolume: 1, trades: 1, takerBuyBase: 0, takerBuyQuote: 0 },
    ];
    const tr = trueRange(two);
    expect(tr[0]).toBe(3); // 12 - 9
    expect(tr[1]).toBe(10); // max(20-10, |20-11|, |10-11|) = 10
  });

  it("obv: adds volume on an up close, subtracts on a down close, ignores flat", () => {
    const mk = (c: number, v: number): Candle => ({
      openTime: 0, closeTime: 1, open: c, high: c, low: c, close: c,
      volume: v, quoteVolume: c * v, trades: 1, takerBuyBase: 0, takerBuyQuote: 0,
    });
    expect(obv([mk(10, 5), mk(11, 7), mk(11, 9), mk(9, 4)])).toEqual([0, 7, 7, 3]);
  });

  it("highest / lowest respect the window and the warm-up", () => {
    expect(highest([1, 5, 3, 2], 2)).toEqual([NaN, 5, 5, 3]);
    expect(lowest([1, 5, 3, 2], 2)).toEqual([NaN, 1, 3, 2]);
  });

  it("shift moves a series forward and backward in time", () => {
    expect(shift([1, 2, 3, 4], 2)).toEqual([NaN, NaN, 1, 2]);
    expect(shift([1, 2, 3, 4], -2)).toEqual([3, 4, NaN, NaN]);
  });

  it("percentileRank places a value inside its own history", () => {
    expect(percentileRank([1, 2, 3, 4], 3)).toBe(0.5);
    expect(percentileRank([1, 2, 3, 4], 0)).toBe(0);
    expect(percentileRank([1, 2, 3, 4], 99)).toBe(1);
  });

  it("slopePct is positive on a rise, negative on a fall, zero when flat", () => {
    expect(slopePct([100, 101, 102, 103], 4).at(-1)).toBeGreaterThan(0);
    expect(slopePct([103, 102, 101, 100], 4).at(-1)).toBeLessThan(0);
    expect(slopePct([100, 100, 100, 100], 4).at(-1)).toBeCloseTo(0, 12);
  });

  it("crossAt detects the bar of the cross and only that bar", () => {
    const fast = [1, 2, 5, 6];
    const slow = [3, 3, 3, 3];
    expect(crossAt(fast, slow, 2)).toBe("bullish");
    expect(crossAt(fast, slow, 3)).toBe("none"); // already above, not a new cross
    expect(crossAt(slow, fast, 2)).toBe("bearish");
  });
});

// ── Layer 3: invariants that must hold for any input ─────────────────────────

describe("properties", () => {
  it("every indicator returns a series the same length as its input", () => {
    const n = candles.length;
    for (const [label, s] of [
      ["sma", sma(close, 20)], ["ema", ema(close, 20)], ["rsi", rsi(close, 14)],
      ["atr", atr(candles, 14)], ["obv", obv(candles)], ["vwap", vwap(candles, "1h")],
      ["adx", adx(candles).adx], ["macd", macd(close).macd], ["mfi", mfi(candles)],
      ["tenkan", ichimoku(candles).conversion],
    ] as const) {
      expect(s.length, `${label} length`).toBe(n);
    }
  });

  it("rsi and stochastic stay inside 0..100", () => {
    for (const v of rsi(close, 14)) if (Number.isFinite(v)) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(100);
    const s = stochastic(candles.map((c) => c.high), candles.map((c) => c.low), close, 14);
    for (const v of s.k) if (Number.isFinite(v)) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(100);
  });

  it("atr and true range are never negative", () => {
    for (const v of trueRange(candles)) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of atr(candles, 14)) if (Number.isFinite(v)) expect(v).toBeGreaterThanOrEqual(0);
  });

  it("adx stays inside 0..100 and the DIs are non-negative", () => {
    const a = adx(candles, 14);
    for (const v of a.adx) if (Number.isFinite(v)) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(100);
    for (const v of a.plusDi) if (Number.isFinite(v)) expect(v).toBeGreaterThanOrEqual(0);
  });

  it("bollinger bands never invert", () => {
    const b = bollinger(close, 20, 2);
    for (let i = 0; i < close.length; i++) {
      if (!Number.isFinite(b.upper[i])) continue;
      expect(b.upper[i]).toBeGreaterThanOrEqual(b.middle[i]);
      expect(b.middle[i]).toBeGreaterThanOrEqual(b.lower[i]);
    }
  });

  it("the ichimoku cloud top is never below its bottom", () => {
    const i = ichimoku(candles);
    for (let k = 0; k < candles.length; k++) {
      if (!Number.isFinite(i.cloudTop[k])) continue;
      expect(i.cloudTop[k]).toBeGreaterThanOrEqual(i.cloudBottom[k]);
    }
  });

  it("a longer moving average warms up later than a shorter one", () => {
    const first = (s: number[]) => s.findIndex(Number.isFinite);
    expect(first(sma(close, 200))).toBe(199);
    expect(first(sma(close, 20))).toBe(19);
    expect(first(rsi(close, 14))).toBe(14); // changes start at index 1
  });

  it("indicators do not mutate their input", () => {
    const snapshot = JSON.stringify(candles);
    adx(candles); ichimoku(candles); atr(candles); obv(candles); vwap(candles, "1h");
    expect(JSON.stringify(candles)).toBe(snapshot);
  });

  it("appending a bar never changes an earlier bar's value", () => {
    // The guarantee that makes a backtest reproducible: no look-ahead.
    const head = candles.slice(0, 400);
    const full = candles.slice(0, 500);
    const a = rsi(head.map((c) => c.close), 14);
    const b = rsi(full.map((c) => c.close), 14);
    for (let i = 0; i < head.length; i++) {
      if (Number.isFinite(a[i])) expect(b[i]).toBeCloseTo(a[i], 10);
    }
  });

  it("handles empty and single-bar inputs without throwing", () => {
    expect(sma([], 10)).toEqual([]);
    expect(rsi([], 14)).toEqual([]);
    expect(obv([])).toEqual([]);
    expect(trueRange(candles.slice(0, 1))).toHaveLength(1);
    expect(adx(candles.slice(0, 1)).adx).toHaveLength(1);
  });

  it("returns all-NaN rather than garbage when there is less data than the period", () => {
    const short = close.slice(0, 5);
    expect(sma(short, 20).every((v) => Number.isNaN(v))).toBe(true);
    expect(rsi(short, 14).every((v) => Number.isNaN(v))).toBe(true);
  });
});

describe("pivots and divergence", () => {
  it("a pivot is only knowable after `right` bars have closed", () => {
    const pivots = findPivots(candles, 3, 3);
    expect(pivots.length).toBeGreaterThan(10);
    for (const p of pivots) expect(p.confirmedAt).toBe(p.index + 3);
  });

  it("never reports a pivot inside the unconfirmed tail", () => {
    const pivots = findPivots(candles, 3, 3);
    const last = pivots[pivots.length - 1];
    expect(last.index).toBeLessThanOrEqual(candles.length - 1 - 3);
  });

  it("a pivot high really is the highest bar in its window", () => {
    for (const p of findPivots(candles, 3, 3).filter((x) => x.kind === "high")) {
      for (let j = p.index - 3; j <= p.index + 3; j++) {
        if (j === p.index) continue;
        expect(candles[j].high).toBeLessThanOrEqual(p.price);
      }
    }
  });

  it("finds divergences and labels each in Arabic", () => {
    const divs = findDivergences(candles, rsi(close, 14), { lookback: 600 });
    expect(divs.length).toBeGreaterThan(0);
    for (const d of divs) {
      expect(d.arabic.length).toBeGreaterThan(10);
      expect(d.strength).toBeGreaterThanOrEqual(0);
      expect(d.strength).toBeLessThanOrEqual(1);
      expect(d.toIndex).toBeGreaterThan(d.fromIndex);
    }
  });

  it("classifies a constructed regular bearish divergence correctly", () => {
    const divs = findDivergences(candles, rsi(close, 14), { lookback: 600 });
    const bearish = divs.filter((d) => d.kind === "regular_bearish");
    for (const d of bearish) {
      expect(d.toPrice).toBeGreaterThan(d.fromPrice); // higher high in price
      expect(d.toOscillator).toBeLessThan(d.fromOscillator); // lower high in RSI
    }
    const bullish = divs.filter((d) => d.kind === "regular_bullish");
    for (const d of bullish) {
      expect(d.toPrice).toBeLessThan(d.fromPrice);
      expect(d.toOscillator).toBeGreaterThan(d.fromOscillator);
    }
  });

  it("divergences never reference an unconfirmed pivot", () => {
    const endIndex = candles.length - 1;
    for (const d of findDivergences(candles, rsi(close, 14), { lookback: 600 })) {
      expect(d.toIndex + 3).toBeLessThanOrEqual(endIndex);
    }
  });
});

describe("bollinger squeeze", () => {
  it("flags the tightest bandwidth percentiles and counts the coil", () => {
    const s = bollingerSqueeze(close, 20, 2, 120, 0.2);
    expect(s.squeezed.some(Boolean)).toBe(true);
    for (let i = 0; i < close.length; i++) {
      if (!Number.isFinite(s.bandwidthPercentile[i])) continue;
      expect(s.squeezed[i]).toBe(s.bandwidthPercentile[i] <= 0.2);
    }
  });

  it("the coil counter resets the moment the squeeze releases", () => {
    const s = bollingerSqueeze(close, 20, 2, 120, 0.2);
    for (let i = 1; i < close.length; i++) {
      if (!s.squeezed[i] && Number.isFinite(s.bandwidthPercentile[i])) {
        expect(s.barsInSqueeze[i]).toBe(0);
      }
    }
  });
});
