import {
  adx, atr, atrPercent, bollinger, correlation, ema, last, macd,
  realizedVolatility, rsi, sma, stochRsi,
} from "../src/lib/analysis/indicators";
import type { Candle } from "../src/lib/market/types";
import { describe, equal, isNull, near, ok } from "./_harness";

const bar = (o: number, h: number, l: number, c: number, i: number): Candle => ({
  t: i * 3600_000, o, h, l, c, v: 1,
});

export function run() {
  describe("moving averages", () => {
    near(last(sma([1, 2, 3, 4, 5], 5)), 3, 1e-9, "SMA of 1..5 over 5 = 3");

    // EMA is seeded with the SMA of the first `period` values, then k = 2/(n+1).
    let expected = 3;
    for (const v of [6, 7, 8, 9, 10]) expected = v * (2 / 6) + expected * (1 - 2 / 6);
    near(last(ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)), expected, 1e-9, "EMA matches manual recurrence");

    equal(sma(new Array(10).fill(1), 20).every((v) => v === null), true, "SMA is all null when the series is shorter than its period");
  });

  describe("RSI — checked against Wilder's 1978 table", () => {
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08,
      45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
    ];
    const r = rsi(closes, 14);
    near(r[14], 70.46, 0.02, "bar 15 = 70.46");
    near(r[15], 66.25, 0.02, "bar 16 = 66.25");
    near(r[16], 66.48, 0.05, "bar 17 = 66.48");
    near(r[19], 57.92, 0.1, "bar 20 = 57.92");

    near(last(rsi(Array.from({ length: 40 }, (_, i) => 100 + i), 14)), 100, 1e-6, "a series that only rises pins at 100");
    near(last(rsi(Array.from({ length: 40 }, (_, i) => 200 - i), 14)), 0, 1e-6, "a series that only falls pins at 0");
  });

  describe("alignment — a line must never be shorter than its input", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    equal(sma(closes, 20).length, 60, "SMA");
    equal(ema(closes, 20).length, 60, "EMA");
    equal(rsi(closes, 14).length, 60, "RSI");
    equal(stochRsi(closes).length, 60, "StochRSI");
    const m = macd(closes);
    equal(m.macd.length === 60 && m.signal.length === 60 && m.histogram.length === 60, true, "MACD, signal and histogram");
  });

  describe("MACD", () => {
    const rising = Array.from({ length: 80 }, (_, i) => 100 + i);
    ok((last(macd(rising).macd) ?? 0) > 0, "MACD is positive through a sustained uptrend");
    const falling = Array.from({ length: 80 }, (_, i) => 200 - i);
    ok((last(macd(falling).macd) ?? 0) < 0, "MACD is negative through a sustained downtrend");
  });

  describe("volatility", () => {
    const constantRange: Candle[] = Array.from({ length: 40 }, (_, i) => bar(100, 102, 98, 100, i));
    near(last(atr(constantRange, 14)), 4, 1e-9, "ATR of a constant 4-point range = 4");
    near(last(atrPercent(constantRange, 14)), 4, 1e-9, "ATR% against a price of 100 = 4%");

    const bb = bollinger(new Array(40).fill(50), 20, 2);
    near(last(bb.upper), 50, 1e-9, "Bollinger bands collapse onto a flat series");
    near(last(bb.width), 0, 1e-9, "…and its width is zero");

    near(realizedVolatility(new Array(40).fill(100), 30), 0, 1e-9, "realised volatility of a flat series is zero");
  });

  describe("ADX — trend strength, direction-agnostic", () => {
    const trend: Candle[] = Array.from({ length: 120 }, (_, i) => bar(100 + i, 101 + i, 99 + i, 100.5 + i, i));
    const chop: Candle[] = Array.from({ length: 120 }, (_, i) => {
      const b = 100 + (i % 2 ? 1 : -1);
      return bar(b, b + 1, b - 1, b, i);
    });
    ok((last(adx(trend).adx) ?? 0) > 40, "a clean trend reads strong", `${last(adx(trend).adx)?.toFixed(1)}`);
    ok((last(adx(chop).adx) ?? 100) < 25, "two-bar chop reads weak", `${last(adx(chop).adx)?.toFixed(1)}`);
    const d = adx(trend);
    ok((last(d.plusDi) ?? 0) > (last(d.minusDi) ?? 0), "+DI leads in an uptrend");
  });

  describe("StochRSI", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const values = stochRsi(closes).filter((v): v is number => v !== null);
    ok(values.every((v) => v >= -1e-9 && v <= 100 + 1e-9), "stays inside [0, 100]");
  });

  describe("correlation", () => {
    const a = Array.from({ length: 60 }, (_, i) => 100 * Math.exp(Math.sin(i / 4) * 0.05));
    near(correlation(a, a.map((v) => v * 2)), 1, 1e-6, "a series against a scaled copy of itself = +1");

    const inverted = [100];
    for (let i = 1; i < 60; i++) inverted.push(inverted[i - 1] / (a[i] / a[i - 1]));
    near(correlation(a, inverted), -1, 1e-6, "a series against its mirror = −1");

    // A peg, a stalled feed or a straight synthetic line has no return
    // variance. Correlation is undefined there, and reporting a confident
    // number instead would feed a real position-sizing decision.
    const straight = Array.from({ length: 60 }, (_, i) => 100 * Math.exp(i * 0.01));
    const straightInv = [100];
    for (let i = 1; i < 60; i++) straightInv.push(straightInv[i - 1] / (straight[i] / straight[i - 1]));
    isNull(correlation(straight, straightInv), "a series with no return variance reports unknown");

    isNull(correlation([1, 2, 3], [1, 2, 3]), "too few points reports unknown");
  });
}
