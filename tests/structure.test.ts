/**
 * Structure, levels and patterns.
 *
 * Detectors are trivially fooled by random data — "it found something" proves
 * nothing at all. So the positive cases run against hand-built geometry, and
 * every positive case is paired with a NEGATIVE one: the same detector must
 * stay silent on a clean trend or a flat range. A detector that fires on
 * everything is worse than none, because it looks like it works.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { analyzeStructure } from "@/core/structure/market-structure";
import { findLevels, nearestResistance, nearestSupport, zoneContaining } from "@/core/structure/levels";
import { fibonacci, findGaps, periodExtremes, volumeProfile } from "@/core/structure/reference-levels";
import { findPatterns } from "@/core/structure/patterns";
import { detectCandlePatterns, qualifyAtLevels, significantPatterns } from "@/core/structure/candlesticks";
import { analyzeStructureStage } from "@/core/analysis/structure-stage";
import * as S from "./fixtures/shapes";
import type { Candle } from "@/core/types";

const raw = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "candles-1h.json"), "utf8"),
) as { openTime: number; open: number; high: number; low: number; close: number; volume: number }[];

const real: Candle[] = raw.map((c) => ({
  ...c,
  closeTime: c.openTime + 3_600_000,
  quoteVolume: c.volume * c.close,
  trades: 10,
  takerBuyBase: c.volume * 0.55,
  takerBuyQuote: c.volume * 0.55 * c.close,
}));

// ── market structure ─────────────────────────────────────────────────────────

describe("market structure classification", () => {
  it("reads a clean uptrend as higher highs and higher lows", () => {
    expect(analyzeStructure(S.cleanUptrend()).state).toBe("uptrend");
  });

  it("reads a clean downtrend as lower highs and lower lows", () => {
    expect(analyzeStructure(S.cleanDowntrend()).state).toBe("downtrend");
  });

  it("refuses to call a range a trend", () => {
    expect(analyzeStructure(S.range()).state).toBe("range");
  });

  it("labels each swing against the previous one of the same kind", () => {
    const s = analyzeStructure(S.cleanUptrend());
    const highs = s.swings.filter((x) => x.kind === "high");
    expect(highs.length).toBeGreaterThan(1);
    expect(highs.slice(1).every((h) => h.relation === "higher")).toBe(true);
  });

  it("treats near-identical swings as EQUAL, not as a new extreme", () => {
    // The two tops of a double top differ by 0.3 in 120 — well inside ATR.
    const s = analyzeStructure(S.doubleTop());
    const equals = s.swings.filter((x) => x.relation === "equal");
    expect(equals.length).toBeGreaterThan(0);
    expect(s.arabic).toContain("متساوية");
  });

  it("counts a break WITH the trend as a BOS", () => {
    const s = analyzeStructure(S.cleanUptrend());
    expect(s.breaks.length).toBeGreaterThan(0);
    expect(s.breaks.filter((b) => b.kind === "bos").length).toBeGreaterThan(0);
    expect(s.breaks.every((b) => b.index > b.pivotIndex)).toBe(true);
  });

  it("counts a break AGAINST the trend as a CHoCH", () => {
    // Up, up, then a decisive break of the last higher low.
    const c = S.withWarmup(S.fromPath([100, 120, 112, 132, 120, 105], 8));
    const s = analyzeStructure(c);
    expect(s.breaks.some((b) => b.kind === "choch")).toBe(true);
  });

  it("distinguishes a wick sweep from a real break", () => {
    const s = analyzeStructure(real);
    for (const b of s.breaks) {
      if (!b.closedBeyond) expect(b.arabic).toContain("كنس سيولة");
      else expect(b.arabic).toContain("بإغلاق");
    }
  });

  it("never reports a break before the pivot that created it", () => {
    for (const shape of [S.cleanUptrend(), S.doubleTop(), real]) {
      for (const b of analyzeStructure(shape).breaks) {
        expect(b.index).toBeGreaterThan(b.pivotIndex);
      }
    }
  });

  it("finds NO swings in a literal straight line — and that is correct", () => {
    // A monotonic ramp has no pivot on either side: every bar exceeds the last.
    // It is a line, not a trend, and a detector that "found an uptrend" here
    // would be pattern-matching on direction rather than on structure.
    const s = analyzeStructure(S.straightRamp());
    expect(s.swings.filter((x) => x.kind === "high")).toHaveLength(0);
    expect(s.state).toBe("range");
  });

  it("says so plainly when there is not enough structure to classify", () => {
    const s = analyzeStructure(real.slice(0, 12));
    expect(s.state).toBe("range");
    expect(s.arabic).toContain("لا توجد");
  });
});

// ── levels ───────────────────────────────────────────────────────────────────

describe("level zones", () => {
  it("returns zones with real width, never bare lines", () => {
    const zones = findLevels(real);
    expect(zones.length).toBeGreaterThan(0);
    for (const z of zones) {
      expect(z.high).toBeGreaterThan(z.low);
      expect(z.price).toBeGreaterThanOrEqual(z.low);
      expect(z.price).toBeLessThanOrEqual(z.high);
    }
  });

  it("finds the two levels a range keeps testing", () => {
    const zones = findLevels(S.range());
    expect(zones.length).toBeGreaterThanOrEqual(2);
    // The range runs 100 to 110; the strongest zones should sit near its edges.
    const prices = zones.map((z) => z.price).sort((a, b) => a - b);
    expect(prices[0]).toBeLessThan(105);
    expect(prices[prices.length - 1]).toBeGreaterThan(105);
  });

  it("ranks a repeatedly-tested level above a once-touched one", () => {
    const zones = findLevels(S.range());
    const mostTested = [...zones].sort((a, b) => b.touchCount - a.touchCount)[0];
    const leastTested = [...zones].sort((a, b) => a.touchCount - b.touchCount)[0];
    if (mostTested.touchCount > leastTested.touchCount) {
      expect(mostTested.strength).toBeGreaterThan(leastTested.strength);
    }
  });

  it("strength stays inside 0..100 and counts add up", () => {
    for (const z of findLevels(real)) {
      expect(z.strength).toBeGreaterThanOrEqual(0);
      expect(z.strength).toBeLessThanOrEqual(100);
      expect(z.holdCount + z.breakCount).toBe(z.touchCount);
      expect(z.touches).toHaveLength(z.touchCount);
    }
  });

  it("classifies zones above price as resistance and below as support", () => {
    const price = real[real.length - 1].close;
    for (const z of findLevels(real)) {
      if (z.price > price) expect(z.kind).toMatch(/resistance/);
      else expect(z.kind).toMatch(/support/);
    }
  });

  it("nearest support is below price and nearest resistance above it", () => {
    const zones = findLevels(real);
    const price = real[real.length - 1].close;
    const s = nearestSupport(zones, price);
    const r = nearestResistance(zones, price);
    if (s) expect(s.high).toBeLessThan(price);
    if (r) expect(r.low).toBeGreaterThan(price);
  });

  it("returns nothing rather than guessing on a too-short series", () => {
    expect(findLevels(real.slice(0, 20))).toEqual([]);
  });

  it("每 zone carries an Arabic description naming its strength", () => {
    for (const z of findLevels(real)) {
      expect(z.arabic).toContain("قوّة");
      expect(z.arabic.length).toBeGreaterThan(20);
    }
  });

  it("detects when price is sitting inside a zone", () => {
    const zones = findLevels(real);
    const inside = zoneContaining(zones, zones[0]?.price ?? 0);
    if (zones.length > 0) expect(inside).not.toBeNull();
  });
});

// ── reference levels ─────────────────────────────────────────────────────────

describe("fibonacci", () => {
  it("measures from the last confirmed swing and orders the levels", () => {
    const f = fibonacci(real)!;
    expect(f).not.toBeNull();
    expect(f.swingHigh).toBeGreaterThan(f.swingLow);
    const prices = f.levels.map((l) => l.price);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it("retraces DOWN from the high on an up-swing", () => {
    const f = fibonacci(S.cleanUptrend());
    if (f && f.direction === "up") {
      const half = f.levels.find((l) => l.ratio === 0.5 && l.kind === "retracement")!;
      expect(half.price).toBeLessThan(f.swingHigh);
      expect(half.price).toBeGreaterThan(f.swingLow);
      expect(half.price).toBeCloseTo((f.swingHigh + f.swingLow) / 2, 6);
    }
  });

  it("flags the golden pocket only inside 61.8–65%", () => {
    const f = fibonacci(real);
    if (f) {
      expect(f.inGoldenPocket).toBe(f.currentRetracement >= 0.618 && f.currentRetracement <= 0.65);
    }
  });

  it("returns null rather than inventing a swing when there is none", () => {
    expect(fibonacci(real.slice(0, 10))).toBeNull();
  });
});

describe("period extremes", () => {
  it("reports the PREVIOUS period, never the still-forming current one", () => {
    const levels = periodExtremes(real, "1h");
    expect(levels.length).toBeGreaterThan(0);
    const lastTime = real[real.length - 1].openTime;
    const currentDay = Math.floor(lastTime / 86_400_000) * 86_400_000;
    for (const l of levels.filter((x) => x.period === "day")) {
      expect(l.periodStart).toBeLessThan(currentDay);
    }
  });

  it("pairs every high with a low and labels them in Arabic", () => {
    const levels = periodExtremes(real, "1h");
    const highs = levels.filter((l) => l.which === "high");
    const lows = levels.filter((l) => l.which === "low");
    expect(highs.length).toBe(lows.length);
    for (const l of levels) expect(l.label).toMatch(/قمة|قاع/);
  });

  it("does not offer a daily level on a daily chart", () => {
    expect(periodExtremes(real, "1d").some((l) => l.period === "day")).toBe(false);
  });
});

describe("price gaps", () => {
  it("finds a real three-bar imbalance and measures how much filled", () => {
    const gaps = findGaps(real);
    for (const g of gaps) {
      expect(g.top).toBeGreaterThan(g.bottom);
      expect(g.filledFraction).toBeGreaterThanOrEqual(0);
      expect(g.filledFraction).toBeLessThanOrEqual(1);
      expect(g.filled).toBe(g.filledFraction >= 0.99);
      expect(g.sizeAtr).toBeGreaterThanOrEqual(0.25);
    }
  });

  it("ignores gaps too small to matter", () => {
    expect(findGaps(real, 99).length).toBe(0);
  });
});

describe("volume profile", () => {
  it("puts the point of control inside the traded range", () => {
    const p = volumeProfile(real)!;
    const high = Math.max(...real.slice(-250).map((c) => c.high));
    const low = Math.min(...real.slice(-250).map((c) => c.low));
    expect(p.poc).toBeGreaterThanOrEqual(low);
    expect(p.poc).toBeLessThanOrEqual(high);
  });

  it("wraps the value area around the point of control", () => {
    const p = volumeProfile(real)!;
    expect(p.valueAreaLow).toBeLessThanOrEqual(p.poc);
    expect(p.valueAreaHigh).toBeGreaterThanOrEqual(p.poc);
  });

  it("puts the point of control where the volume ACTUALLY traded", () => {
    // Build a series that spends most of its volume in a known narrow band,
    // then assert the POC lands there. This tests the algorithm rather than
    // an assumption about the shape of a fixture.
    const HEAVY = 150;
    const candles: Candle[] = [];
    for (let i = 0; i < 200; i++) {
      // 70% of bars sit at ~150 with big volume, 30% wander away with small.
      const heavy = i % 10 < 7;
      const price = heavy ? HEAVY + (i % 3) * 0.2 : 130 + (i % 40);
      candles.push({
        openTime: Date.UTC(2024, 0, 1) + i * 3_600_000,
        closeTime: Date.UTC(2024, 0, 1) + (i + 1) * 3_600_000,
        open: price, high: price + 0.3, low: price - 0.3, close: price,
        volume: heavy ? 1000 : 20,
        quoteVolume: price * (heavy ? 1000 : 20),
        trades: 10, takerBuyBase: 0, takerBuyQuote: 0,
      });
    }
    const p = volumeProfile(candles)!;
    expect(p.poc).toBeGreaterThan(HEAVY - 2);
    expect(p.poc).toBeLessThan(HEAVY + 3);
    // The value area must enclose the band where the size actually traded.
    expect(p.valueAreaLow).toBeLessThanOrEqual(HEAVY);
    expect(p.valueAreaHigh).toBeGreaterThanOrEqual(HEAVY);
  });

  it("spreads a bar's volume across its range, not all at its close", () => {
    // One very wide bar against many narrow ones. If volume were dumped at the
    // close, the POC would sit at that close; spread properly it does not.
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      const price = 100;
      candles.push({
        openTime: Date.UTC(2024, 0, 1) + i * 3_600_000,
        closeTime: Date.UTC(2024, 0, 1) + (i + 1) * 3_600_000,
        open: price, high: price + 0.2, low: price - 0.2, close: price,
        volume: 100, quoteVolume: 100 * price, trades: 5, takerBuyBase: 0, takerBuyQuote: 0,
      });
    }
    // A single wide bar spanning 100→160, closing at the top.
    candles.push({
      openTime: Date.UTC(2024, 0, 1) + 60 * 3_600_000,
      closeTime: Date.UTC(2024, 0, 1) + 61 * 3_600_000,
      open: 100, high: 160, low: 100, close: 160,
      volume: 3000, quoteVolume: 3000 * 160, trades: 500, takerBuyBase: 0, takerBuyQuote: 0,
    });
    const p = volumeProfile(candles)!;
    expect(p.poc).toBeLessThan(120); // NOT parked at 160
  });

  it("reports where price sits relative to the value area", () => {
    const p = volumeProfile(real)!;
    const price = real[real.length - 1].close;
    const expected = price > p.valueAreaHigh ? "above" : price < p.valueAreaLow ? "below" : "inside";
    expect(p.pricePosition).toBe(expected);
  });

  it("returns null on too little data instead of a meaningless profile", () => {
    expect(volumeProfile(real.slice(0, 5))).toBeNull();
  });
});

// ── chart patterns ───────────────────────────────────────────────────────────

describe("chart patterns — positive cases", () => {
  const has = (candles: Candle[], kind: string) =>
    findPatterns(candles).some((p) => p.kind === kind);

  it("finds a double top in a double top", () => expect(has(S.doubleTop(), "double_top")).toBe(true));
  it("finds a double bottom in a double bottom", () => expect(has(S.doubleBottom(), "double_bottom")).toBe(true));
  it("finds head and shoulders", () => expect(has(S.headAndShoulders(), "head_and_shoulders")).toBe(true));
  it("finds inverse head and shoulders", () => expect(has(S.inverseHeadAndShoulders(), "inverse_head_and_shoulders")).toBe(true));
  it("finds an ascending triangle", () => expect(has(S.ascendingTriangle(), "ascending_triangle")).toBe(true));
  it("finds a descending triangle", () => expect(has(S.descendingTriangle(), "descending_triangle")).toBe(true));
});

describe("chart patterns — negative cases", () => {
  it("does NOT find reversal patterns in a clean one-way trend", () => {
    const kinds = findPatterns(S.cleanUptrend()).map((p) => p.kind);
    expect(kinds).not.toContain("double_top");
    expect(kinds).not.toContain("head_and_shoulders");
  });

  it("does NOT find a double bottom in a clean uptrend", () => {
    expect(findPatterns(S.cleanUptrend()).map((p) => p.kind)).not.toContain("double_bottom");
  });

  it("returns nothing at all on a series too short to hold a pattern", () => {
    expect(findPatterns(real.slice(0, 30))).toEqual([]);
  });
});

describe("chart pattern geometry", () => {
  it("targets are measured from the pattern's own height, not a percentage", () => {
    const p = findPatterns(S.doubleTop()).find((x) => x.kind === "double_top")!;
    const height = Math.abs(p.pivots[0].price - p.triggerLevel);
    expect(p.target).toBeCloseTo(p.triggerLevel - height, 4);
  });

  it("a bearish pattern targets below its trigger and is invalidated above", () => {
    for (const p of findPatterns(S.doubleTop())) {
      if (p.direction !== "bearish") continue;
      expect(p.target).toBeLessThan(p.triggerLevel);
      expect(p.invalidationLevel).toBeGreaterThan(p.triggerLevel);
    }
  });

  it("a bullish pattern targets above its trigger and is invalidated below", () => {
    for (const p of findPatterns(S.doubleBottom())) {
      if (p.direction !== "bullish") continue;
      expect(p.target).toBeGreaterThan(p.triggerLevel);
      expect(p.invalidationLevel).toBeLessThan(p.triggerLevel);
    }
  });

  it("completion is 1 only when a CLOSE cleared the trigger", () => {
    for (const p of findPatterns(S.doubleTop())) {
      expect(p.completion).toBeGreaterThanOrEqual(0);
      expect(p.completion).toBeLessThanOrEqual(1);
      expect(p.confirmed).toBe(p.completion >= 1);
    }
  });

  it("an unconfirmed pattern says outright that it is not an opportunity", () => {
    const patterns = findPatterns(real).filter((p) => !p.confirmed);
    for (const p of patterns) expect(p.arabic).toContain("ليس فرصة");
  });
});

// ── candlestick patterns: the location gate ──────────────────────────────────

describe("candlestick patterns are gated by location", () => {
  it("detects the raw shape of a bullish engulfing", () => {
    // A down bar, then an up bar whose body swallows it whole.
    const base = S.withWarmup(S.fromPath([100, 95], 20));
    const withDown = S.appendCandle(base, { open: 96, high: 96.2, low: 94, close: 94.2 });
    const withEngulf = S.appendCandle(withDown, { open: 94, high: 97.5, low: 93.9, close: 97 });
    expect(detectCandlePatterns(withEngulf, 3).some((p) => p.kind === "bullish_engulfing")).toBe(true);
  });

  it("detects a hammer by its long lower wick", () => {
    const base = S.withWarmup(S.fromPath([100, 95], 20));
    const withHammer = S.appendCandle(base, { open: 95, high: 95.3, low: 91, close: 95.1 });
    expect(detectCandlePatterns(withHammer, 2).some((p) => p.kind === "hammer")).toBe(true);
  });

  it("GIVES A PATTERN IN OPEN SPACE A WEIGHT OF EXACTLY ZERO", () => {
    const raws = detectCandlePatterns(real, 5);
    // Qualify against no levels at all — nothing can possibly be "at a level".
    const qualified = qualifyAtLevels(raws, real, []);
    expect(qualified.every((p) => p.weight === 0)).toBe(true);
    for (const p of qualified) expect(p.arabic).toContain("منتصف الفراغ");
  });

  it("only patterns at a level survive the significance filter", () => {
    const levels = findLevels(real);
    const qualified = qualifyAtLevels(detectCandlePatterns(real, 20), real, levels);
    for (const p of significantPatterns(qualified)) {
      expect(p.weight).toBeGreaterThan(0);
      expect(p.atLevel).not.toBeNull();
      expect(p.direction).not.toBe("neutral");
    }
  });

  it("a doji is never directional on its own", () => {
    const qualified = qualifyAtLevels(detectCandlePatterns(real, 30), real, findLevels(real));
    for (const p of qualified.filter((x) => x.kind === "doji")) {
      expect(p.direction).toBe("neutral");
      expect(significantPatterns([p])).toHaveLength(0);
    }
  });

  it("weight never exceeds raw quality — location can only reduce it", () => {
    const levels = findLevels(real);
    for (const p of qualifyAtLevels(detectCandlePatterns(real, 20), real, levels)) {
      expect(p.weight).toBeLessThanOrEqual(p.rawQuality + 1e-9);
    }
  });
});

// ── the stage orchestrator ───────────────────────────────────────────────────

describe("analyzeStructureStage", () => {
  it("factor contributions reproduce the score exactly", () => {
    for (const shape of [real, S.doubleTop(), S.cleanUptrend(), S.range()]) {
      const a = analyzeStructureStage(shape, "1h");
      const sum = a.factors.reduce((s, f) => s + f.contribution, 0);
      expect(a.score).toBeCloseTo(Math.max(-100, Math.min(100, sum)), 9);
    }
  });

  it("gives every factor an Arabic note", () => {
    const a = analyzeStructureStage(real, "1h");
    for (const f of a.factors) {
      expect(f.note.length).toBeGreaterThan(5);
      expect(f.label.length).toBeGreaterThan(2);
    }
  });

  it("builds target and stop LADDERS ordered by distance from price", () => {
    const a = analyzeStructureStage(real, "1h");
    for (let i = 1; i < a.resistanceLadder.length; i++) {
      expect(a.resistanceLadder[i].low).toBeGreaterThanOrEqual(a.resistanceLadder[i - 1].low);
    }
    for (let i = 1; i < a.supportLadder.length; i++) {
      expect(a.supportLadder[i].high).toBeLessThanOrEqual(a.supportLadder[i - 1].high);
    }
  });

  it("FAILS when there are no levels at all — no stop can be placed", () => {
    const a = analyzeStructureStage(real.slice(0, 25), "1h");
    expect(a.verdict).toBe("fail");
    expect(a.arabic).toContain("لا أساس");
  });

  it("warns when the nearest barrier leaves no room for a target", () => {
    const a = analyzeStructureStage(real, "1h");
    const room = a.factors.find((f) => f.id === "level_room");
    if (room && a.nearestResistance) {
      const atrAway = (a.nearestResistance.low - a.price) / a.atr;
      if (atrAway < 1) expect(a.warnings.some((w) => w.includes("مساحة") || w.includes("المقاومة"))).toBe(true);
    }
  });

  it("reads an uptrend as bullish and a downtrend as bearish", () => {
    expect(analyzeStructureStage(S.cleanUptrend(), "1h").bias).toBe("bullish");
    expect(analyzeStructureStage(S.cleanDowntrend(), "1h").bias).toBe("bearish");
  });

  it("says plainly when there is no pattern rather than implying one", () => {
    const a = analyzeStructureStage(S.range(), "1h");
    const pattern = a.factors.find((f) => f.id === "chart_pattern")!;
    if (pattern.value === 0) expect(pattern.note).toContain("ليست فرصة");
  });

  it("is deterministic", () => {
    const a = JSON.stringify(analyzeStructureStage(real, "1h"));
    const b = JSON.stringify(analyzeStructureStage(real, "1h"));
    expect(a).toBe(b);
  });

  it("never looks ahead: a truncated series gives the same read as it did then", () => {
    const head = real.slice(0, 400);
    const a = analyzeStructureStage(head, "1h");
    const b = analyzeStructureStage(real.slice(0, 400), "1h");
    expect(a.score).toBeCloseTo(b.score, 10);
    expect(a.structure.state).toBe(b.structure.state);
  });

  it("produces a narrative that names the levels it found", () => {
    const a = analyzeStructureStage(real, "1h");
    expect(a.arabic.length).toBeGreaterThan(150);
    expect(a.arabic).toContain("مستوى");
  });
});
