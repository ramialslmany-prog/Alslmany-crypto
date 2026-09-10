import {
  classifyTrend, fibonacci, findFairValueGaps, findLevels, findSwings, readStructure,
} from "../src/lib/analysis/structure";
import { classifyMarket, classifyRegime, computeBreadth } from "../src/lib/analysis/regime";
import type { Candle } from "../src/lib/market/types";
import { describe, equal, near, ok } from "./_harness";

const bar = (i: number, o: number, h: number, l: number, c: number, v = 1): Candle => ({
  t: i * 3600_000, o, h, l, c, v,
});

/** Build a zigzag so the swing points are known in advance. */
function zigzag(legs: number[], barsPerLeg = 8): Candle[] {
  const out: Candle[] = [];
  let price = legs[0];
  let i = 0;
  for (let leg = 1; leg < legs.length; leg++) {
    const target = legs[leg];
    for (let s = 1; s <= barsPerLeg; s++) {
      const next = price + ((target - price) * s) / barsPerLeg;
      const o = out.length ? out[out.length - 1].c : price;
      out.push(bar(i++, o, Math.max(o, next) + 0.2, Math.min(o, next) - 0.2, next));
    }
    price = target;
  }
  return out;
}

export function run() {
  describe("swing detection", () => {
    const candles = zigzag([100, 120, 108, 135, 118, 150]);
    const swings = findSwings(candles, 3);
    ok(swings.length >= 4, "finds the turning points of a zigzag", `${swings.length} swings`);
    ok(
      swings.every((s, i) => i === 0 || swings[i - 1].index < s.index),
      "swings come back in chronological order",
    );
    const highs = swings.filter((s) => s.kind === "high").map((s) => s.price);
    ok(highs.some((p) => p > 118 && p < 122), "the ~120 peak is recognised as a swing high");

    equal(findSwings(zigzag([100, 110]).slice(0, 4), 3).length, 0, "a series shorter than the window yields nothing");
  });

  describe("trend classification", () => {
    const up = classifyTrend(findSwings(zigzag([100, 120, 112, 138, 128, 160]), 3));
    equal(up.trend, "up", "higher highs and higher lows reads as an uptrend");

    const down = classifyTrend(findSwings(zigzag([160, 130, 142, 112, 122, 95]), 3));
    equal(down.trend, "down", "lower highs and lower lows reads as a downtrend");

    const flat = classifyTrend(findSwings(zigzag([100, 115, 100, 115, 100, 115]), 3));
    equal(flat.trend, "range", "a repeating range refuses to be called a trend");

    equal(classifyTrend([]).trend, "range", "no swings falls back to range, never to a guess");
  });

  describe("levels", () => {
    // Price turns three separate times at ~115: one level, three touches.
    const candles = zigzag([100, 115, 102, 115, 101, 115, 104]);
    const levels = findLevels(candles, findSwings(candles, 3));
    ok(levels.length > 0, "produces levels from repeated swings");
    const defended = levels.find((l) => Math.abs(l.price - 115) < 2);
    ok(!!defended, "clusters the three ~115 rejections into one level");
    ok((defended?.touches ?? 0) >= 2, "and counts the touches", `${defended?.touches} touches`);
    ok(
      levels.every((l) => l.strength >= 0 && l.strength <= 100),
      "strength stays inside 0–100",
    );
  });

  describe("fair value gaps", () => {
    // Bar 1 highs at 101, bar 3 lows at 110 — a clean unfilled bullish gap.
    const candles: Candle[] = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 109, 100, 108),
      bar(2, 108, 115, 110, 114),
      bar(3, 114, 116, 112, 115),
      bar(4, 115, 118, 113, 117),
    ];
    const gaps = findFairValueGaps(candles);
    ok(gaps.length >= 1, "detects the three-bar imbalance");
    const g = gaps[0];
    equal(g.direction, "bullish", "labels it bullish");
    near(g.bottom, 101, 1e-9, "gap bottom is the first bar's high");
    near(g.top, 110, 1e-9, "gap top is the third bar's low");

    // Same gap, but a later bar trades back down through it.
    const filledLater = [...candles, bar(5, 117, 118, 100, 102)];
    ok(
      findFairValueGaps(filledLater).every((x) => !(Math.abs(x.bottom - 101) < 1e-9 && x.direction === "bullish")),
      "a gap that later trades through is dropped as filled",
    );
  });

  describe("fibonacci", () => {
    const swings = findSwings(zigzag([100, 200, 150, 220]), 3);
    const fib = fibonacci(swings);
    ok(fib !== null, "produces a retracement across the last completed impulse");
    equal(fib?.levels.length, 5, "quotes the five standard ratios");
    ok(fib?.levels.every((l) => Number.isFinite(l.price)) ?? false, "every level is a real number");
    ok(
      fib!.levels.every((l) => l.price >= Math.min(fib!.from, fib!.to) - 1e-6 && l.price <= Math.max(fib!.from, fib!.to) + 1e-6),
      "every level sits inside the leg it retraces",
    );
    const half = fib!.levels.find((l) => l.ratio === 0.5)!;
    near(half.price, (fib!.from + fib!.to) / 2, 1e-6, "the 0.5 level is the midpoint of the leg");

    // Two same-kind pivots in a row must not hide a real completed leg.
    const contrived = [
      { index: 0, price: 100, time: 0, kind: "low" as const },
      { index: 5, price: 150, time: 5, kind: "high" as const },
      { index: 9, price: 148, time: 9, kind: "high" as const },
    ];
    ok(fibonacci(contrived) !== null, "still measures a leg when the last two pivots share a kind");
  });

  describe("regime classification", () => {
    // A long, steady advance.
    const bull: Candle[] = Array.from({ length: 260 }, (_, i) => {
      const p = 100 * Math.pow(1.006, i);
      return bar(i, p * 0.998, p * 1.012, p * 0.99, p);
    });
    const bullRead = classifyRegime(bull);
    equal(bullRead.label, "bull", "a sustained advance is labelled bull");
    ok(bullRead.score > 20, "with a positive score", `${bullRead.score}`);
    ok(bullRead.evidence.length >= 4, "and states its evidence", `${bullRead.evidence.length} items`);

    const bear: Candle[] = Array.from({ length: 260 }, (_, i) => {
      const p = 300 * Math.pow(0.994, i);
      return bar(i, p * 1.002, p * 1.01, p * 0.988, p);
    });
    equal(classifyRegime(bear).label, "bear", "a sustained decline is labelled bear");
    ok(classifyRegime(bear).score < -20, "with a negative score", `${classifyRegime(bear).score}`);

    // Flat oscillation with no direction being pressed.
    const chop: Candle[] = Array.from({ length: 260 }, (_, i) => {
      const p = 100 + Math.sin(i / 2) * 2;
      return bar(i, p, p + 0.6, p - 0.6, p);
    });
    equal(classifyRegime(chop).label, "range", "directionless chop is labelled range, not a weak trend");

    ok(
      bullRead.evidence.every((e) => typeof e.detail === "string" && e.detail.length > 0),
      "every piece of evidence carries the numbers behind it",
    );
  });

  describe("market regime and risk budget", () => {
    const bull: Candle[] = Array.from({ length: 260 }, (_, i) => {
      const p = 100 * Math.pow(1.006, i);
      return bar(i, p * 0.998, p * 1.012, p * 0.99, p);
    });
    const bear: Candle[] = Array.from({ length: 260 }, (_, i) => {
      const p = 300 * Math.pow(0.994, i);
      return bar(i, p * 1.002, p * 1.01, p * 0.988, p);
    });

    const calmBull = classifyMarket({ btcCandles: bull, breadth: 70, fearGreed: 55 });
    equal(calmBull.label, "bull", "a broad advance reads bull");
    ok(calmBull.riskBudget > 0.8, "and permits close to full size", `${calmBull.riskBudget}`);

    const hostile = classifyMarket({ btcCandles: bear, breadth: 20, fearGreed: 35 });
    equal(hostile.label, "bear", "a broad decline reads bear");
    ok(hostile.riskBudget <= 0.4, "and cuts the risk budget hard", `${hostile.riskBudget}`);

    ok(hostile.riskBudget < calmBull.riskBudget, "a hostile tape always sizes smaller than a calm one");
    ok(
      classifyMarket({ btcCandles: bull, breadth: 70, fearGreed: 90 }).score <
        calmBull.score,
      "euphoric sentiment is read against the crowd, not with it",
    );

    const breadth = computeBreadth([bull, bull, bear, bear, bull, bull]);
    near(breadth, 66.67, 0.5, "breadth counts what is above its own 50 EMA");
    ok(computeBreadth([bull]) === null, "too few series reports unknown breadth");
  });

  describe("full structural read", () => {
    const candles = zigzag([100, 130, 115, 160, 140, 190], 10);
    const s = readStructure(candles);
    equal(s.trend, "up", "reads the uptrend");
    ok(s.levels.length > 0, "returns levels");
    ok(s.rangePosition !== null && s.rangePosition >= 0 && s.rangePosition <= 100, "range position is a percentage", `${s.rangePosition?.toFixed(0)}%`);
    ok(s.nearestSupport === null || s.nearestSupport.price < candles[candles.length - 1].c, "support sits below price");
    ok(s.nearestResistance === null || s.nearestResistance.price >= candles[candles.length - 1].c, "resistance sits at or above price");
  });
}
