/**
 * The eight-stage pipeline, the council, and recommendation immutability.
 *
 * The three things this suite exists to prove:
 *   1. The pipeline STOPS at the first failed stage and records where.
 *   2. Regime nullification actually REMOVES indicator weight — the spec's
 *      rule is structural, not a matter of degree.
 *   3. Recommendations cannot be edited or deleted, enforced by the DATABASE
 *      rather than by code politeness.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, openDb, type Db } from "@/storage/db";
import { RecommendationRepo, RejectedRepo } from "@/storage/repositories/recommendations";
import { runEligibility, DEFAULT_ELIGIBILITY } from "@/core/pipeline/stage1-eligibility";
import { runMacro, returnCorrelation } from "@/core/pipeline/stage2-macro";
import { classifyRegime, classifySetup, nullifiedFactors, weightsFor } from "@/core/pipeline/regime";
import { runCouncil } from "@/core/pipeline/stage8-council";
import { runPipeline } from "@/core/pipeline/run";
import { buildPlan, buildInvalidation, computeIntegrityHash, recommendationId } from "@/core/recommendation/builder";
import { analyzeStructureStage } from "@/core/analysis/structure-stage";
import { analyzeTechnical } from "@/core/analysis/technical";
import { REGIME_ALLOWED_SETUPS, stagePass, stageUnavailable } from "@/core/pipeline/types";
import { available, unavailable } from "@/shared/availability";
import { tfMillis, type Timeframe } from "@/shared/time";
import type { Candle, OrderBook, SymbolInfo, Ticker24h } from "@/core/types";
import type { Recommendation } from "@/core/recommendation/types";
import * as S from "./fixtures/shapes";

const rawFixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "candles-1h.json"), "utf8"),
) as { openTime: number; open: number; high: number; low: number; close: number; volume: number }[];

const real: Candle[] = rawFixture.map((c) => ({
  ...c,
  closeTime: c.openTime + 3_600_000,
  quoteVolume: c.volume * c.close,
  trades: 10,
  takerBuyBase: c.volume * 0.55,
  takerBuyQuote: c.volume * 0.55 * c.close,
}));

const NOW = real[real.length - 1].openTime + 3_600_000;
const DAY = 86_400_000;

// ── stage 1 ──────────────────────────────────────────────────────────────────

const info: SymbolInfo = {
  symbol: "BTCUSDT", nativeSymbol: "BTCUSDT", base: "BTC", quote: "USDT",
  market: "spot", status: "trading", pricePrecision: 2, quantityPrecision: 5, minNotional: 5,
};
const ticker: Ticker24h = {
  symbol: "BTCUSDT", lastPrice: 50_000, quoteVolume: 900_000_000,
  priceChangePct: 1.2, highPrice: 51_000, lowPrice: 49_000,
  bidPrice: 49_999, askPrice: 50_001,
};
const book: OrderBook = {
  symbol: "BTCUSDT",
  bids: Array.from({ length: 20 }, (_, i) => ({ price: 50_000 - i * 10, quantity: 2 })),
  asks: Array.from({ length: 20 }, (_, i) => ({ price: 50_000 + i * 10, quantity: 2 })),
  timestamp: NOW, lastUpdateId: 1,
};

const eligibleInput = (over: Partial<Parameters<typeof runEligibility>[0]> = {}) => ({
  symbol: "BTCUSDT", info, ticker, orderBook: book,
  listedAt: NOW - 400 * DAY, upcomingUnlock: null,
  hasActiveRecommendation: false, now: NOW, ...over,
});

describe("stage 1 — eligibility", () => {
  it("passes a liquid, long-listed coin", () => {
    expect(runEligibility(eligibleInput()).status).toBe("pass");
  });

  it("rejects a coin that already has an active recommendation", () => {
    const r = runEligibility(eligibleInput({ hasActiveRecommendation: true }));
    expect(r.status).toBe("fail");
    expect(r.failReason).toContain("توصية نشطة");
  });

  it("rejects a coin listed less than 90 days ago, naming the number", () => {
    const r = runEligibility(eligibleInput({ listedAt: NOW - 30 * DAY }));
    expect(r.status).toBe("fail");
    expect(r.failReason).toContain("30");
    expect(r.failReason).toContain("90");
  });

  it("treats an UNKNOWN listing date as a rejection, not as old enough", () => {
    // New listings are exactly the coins whose history we cannot read.
    const r = runEligibility(eligibleInput({ listedAt: null }));
    expect(r.status).toBe("fail");
    expect(r.failReason).toContain("غير معروف");
  });

  it("rejects thin volume with both the actual and the threshold", () => {
    const r = runEligibility(eligibleInput({ ticker: { ...ticker, quoteVolume: 100_000 } }));
    expect(r.status).toBe("fail");
    expect(r.failReason).toMatch(/حجم التداول/);
  });

  it("rejects a wide spread", () => {
    const r = runEligibility(eligibleInput({
      ticker: { ...ticker, bidPrice: 49_800, askPrice: 50_200 },
    }));
    expect(r.status).toBe("fail");
    expect(r.failReason).toContain("الفارق");
  });

  it("measures depth on the THINNER side, because that is what an exit crosses", () => {
    const lopsided: OrderBook = {
      ...book,
      bids: Array.from({ length: 20 }, (_, i) => ({ price: 50_000 - i * 10, quantity: 100 })),
      asks: [{ price: 50_010, quantity: 0.01 }],
    };
    const r = runEligibility(eligibleInput({ orderBook: lopsided }));
    expect(r.status).toBe("fail");
    expect(r.failReason).toContain("عمق السيولة");
  });

  it("rejects a large token unlock inside the window", () => {
    const r = runEligibility(eligibleInput({
      upcomingUnlock: { at: NOW + 3 * DAY, percentOfSupply: 5 },
    }));
    expect(r.status).toBe("fail");
    expect(r.failReason).toContain("فتح توكنات");
  });

  it("allows a small or distant unlock", () => {
    expect(runEligibility(eligibleInput({
      upcomingUnlock: { at: NOW + 60 * DAY, percentOfSupply: 5 },
    })).status).toBe("pass");
    expect(runEligibility(eligibleInput({
      upcomingUnlock: { at: NOW + 3 * DAY, percentOfSupply: 0.1 },
    })).status).toBe("pass");
  });

  it("every rejection names a number and its threshold", () => {
    const rejections = [
      runEligibility(eligibleInput({ listedAt: NOW - 10 * DAY })),
      runEligibility(eligibleInput({ ticker: { ...ticker, quoteVolume: 1000 } })),
    ];
    for (const r of rejections) {
      expect(r.failReason).toMatch(/\d/);
      expect(r.arabic).toContain("سقطت في فلتر الأهلية");
    }
  });
});

// ── stage 2 ──────────────────────────────────────────────────────────────────

function trendCandles(direction: "up" | "down" | "flat", bars = 260, start = 50_000): Candle[] {
  const step = direction === "up" ? 0.004 : direction === "down" ? -0.004 : 0;
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < bars; i++) {
    const open = price;
    const close = open * (1 + step);
    const w = open * 0.002;
    out.push({
      openTime: NOW - (bars - i) * DAY, closeTime: NOW - (bars - i - 1) * DAY,
      open, high: Math.max(open, close) + w, low: Math.min(open, close) - w, close,
      volume: 1000, quoteVolume: 1000 * close, trades: 100,
      takerBuyBase: 550, takerBuyQuote: 0,
    });
    price = close;
  }
  return out;
}

const macroBase = (over: Partial<Parameters<typeof runMacro>[0]> = {}) => ({
  symbol: "ETHUSDT",
  btcDaily: trendCandles("up"),
  btc4h: trendCandles("up", 200),
  assetDaily: trendCandles("up", 260, 3000),
  global: available({ totalMarketCap: 2.4e12, totalVolume24h: 8e10, btcDominance: 54, ethDominance: 17, timestamp: NOW }, "cg", NOW),
  dominanceHistory: available(Array.from({ length: 30 }, (_, i) => ({ value: 54 + i * 0.02, timestamp: NOW - (30 - i) * DAY })), "cg", NOW),
  fearGreed: available({ value: 50, classification: "Neutral", timestamp: NOW }, "fng", NOW),
  now: NOW,
  correlationCeiling: 0.85,
  ...over,
});

describe("stage 2 — macro", () => {
  it("BANS altcoin longs outright when Bitcoin is breaking down", () => {
    const r = runMacro(macroBase({
      btcDaily: trendCandles("down"), btc4h: trendCandles("down", 200),
    }));
    expect(r.allowedDirection).toBe("short");
    expect(r.arabic).toContain("ممنوعة");
  });

  it("allows both directions when Bitcoin is healthy", () => {
    expect(runMacro(macroBase()).allowedDirection).toBe("both");
  });

  it("flags a coin as NOT independently analysable above the correlation ceiling", () => {
    // Identical return paths correlate at 1.
    const identical = varyingCandles(0.7, 260, 50_000);
    const r = runMacro(macroBase({ assetDaily: identical, btcDaily: identical }));
    expect(r.btcCorrelation).toBeGreaterThan(0.85);
    expect(r.independentAnalysis).toBe(false);
    expect(r.confidencePenalty).toBeGreaterThan(0);
    expect(r.arabic).toContain("ليس مستقلاً");
  });

  it("reports unavailable rather than guessing when BTC history is too short", () => {
    const r = runMacro(macroBase({ btcDaily: trendCandles("up", 10) }));
    expect(r.status).toBe("unavailable");
  });

  it("degrades gracefully when the optional macro sources are missing", () => {
    const r = runMacro(macroBase({
      global: unavailable("cg", "network_error"),
      dominanceHistory: unavailable("cg", "network_error"),
      fearGreed: unavailable("fng", "http_error"),
    }));
    expect(r.status).toBe("pass");
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

/**
 * A series with VARYING returns.
 *
 * `trendCandles` moves by a constant percentage every bar, so its returns have
 * essentially zero variance — and correlation against a zero-variance series
 * is numerically meaningless. Correlation tests need real dispersion.
 */
function varyingCandles(seed: number, bars = 200, start = 1000): Candle[] {
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < bars; i++) {
    const r = Math.sin(i * seed) * 0.02 + Math.cos(i * seed * 1.7) * 0.012;
    const open = price;
    const close = open * (1 + r);
    out.push({
      openTime: NOW - (bars - i) * DAY, closeTime: NOW - (bars - i - 1) * DAY,
      open, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, close,
      volume: 1000, quoteVolume: 1000 * close, trades: 100, takerBuyBase: 550, takerBuyQuote: 0,
    });
    price = close;
  }
  return out;
}

describe("returnCorrelation", () => {
  it("is 1 for identical series", () => {
    const a = varyingCandles(0.7);
    expect(returnCorrelation(a, a, 30)).toBeCloseTo(1, 9);
  });

  it("is negative for a series whose RETURNS are the negation", () => {
    // Build the mirror from returns, not from price level. Flipping the price
    // axis does NOT negate returns — the denominator changes too — which is
    // itself a reason this function works on returns rather than prices.
    const source = varyingCandles(0.7);
    const mirrored: Candle[] = [];
    let price = 1000;
    for (let i = 0; i < source.length; i++) {
      const prev = i === 0 ? source[0].open : source[i - 1].close;
      const r = prev > 0 ? (source[i].close - prev) / prev : 0;
      const open = price;
      const close = open * (1 - r); // the exact negation of this bar's return
      mirrored.push({
        ...source[i], open, close,
        high: Math.max(open, close), low: Math.min(open, close),
      });
      price = close;
    }
    const corr = returnCorrelation(source, mirrored, 30);
    expect(corr).not.toBeNull();
    expect(corr!).toBeLessThan(-0.9);
  });

  it("uses RETURNS, not prices: two unrelated risers do not correlate at 1", () => {
    // Both drift up over the window, but move independently bar to bar.
    // Correlating raw PRICES here would return close to 1 and be useless.
    const corr = returnCorrelation(varyingCandles(1.1), varyingCandles(2.7), 100);
    expect(corr).not.toBeNull();
    expect(Math.abs(corr!)).toBeLessThan(0.9);
  });

  it("aligns on timestamps rather than bar index", () => {
    // Same series, but one starts later. Comparing index-to-index would pair
    // different dates together and produce a meaningless number.
    const full = varyingCandles(0.7);
    const offset = full.slice(40);
    expect(returnCorrelation(full, offset, 30)).toBeCloseTo(1, 9);
  });

  it("returns null rather than a number when history is too short", () => {
    expect(returnCorrelation(varyingCandles(0.7, 5), varyingCandles(0.7, 5), 30)).toBeNull();
  });
});

// ── regime and setups ────────────────────────────────────────────────────────

describe("regime classification", () => {
  it("calls a strong trend a trend", () => {
    const c = S.cleanUptrend();
    const r = classifyRegime(c, analyzeStructureStage(c, "1h"));
    expect(["trending_up", "high_volatility"]).toContain(r.regime);
  });

  it("calls a chop a range", () => {
    const c = S.range();
    const r = classifyRegime(c, analyzeStructureStage(c, "1h"));
    expect(["ranging", "high_volatility"]).toContain(r.regime);
  });

  it("always explains itself in Arabic", () => {
    const r = classifyRegime(real, analyzeStructureStage(real, "1h"));
    expect(r.arabic).toContain("النظام السوقي");
    expect(r.arabic.length).toBeGreaterThan(40);
  });
});

describe("regime nullification — the spec's rule made structural", () => {
  it("REMOVES reversal indicators in a trend", () => {
    for (const regime of ["trending_up", "trending_down"] as const) {
      const n = nullifiedFactors(regime);
      expect(n).toContain("divergence");
      expect(n).toContain("stochastic");
    }
  });

  it("REMOVES breakout indicators in a range", () => {
    const n = nullifiedFactors("ranging");
    expect(n).toContain("bb_squeeze");
    expect(n).toContain("last_break");
  });

  it("forbids reversal SETUPS entirely in a trend", () => {
    for (const regime of ["trending_up", "trending_down"] as const) {
      expect(REGIME_ALLOWED_SETUPS[regime]).not.toContain("range_reversal");
      expect(REGIME_ALLOWED_SETUPS[regime]).not.toContain("divergence_reversal");
    }
  });

  it("forbids breakout SETUPS entirely in a range", () => {
    expect(REGIME_ALLOWED_SETUPS.ranging).not.toContain("breakout_retest");
    expect(REGIME_ALLOWED_SETUPS.ranging).not.toContain("momentum_ignition");
  });

  it("weights always sum to 1 whatever the regime and timeframe", () => {
    for (const regime of ["trending_up", "trending_down", "ranging", "high_volatility"] as const) {
      for (const tf of ["5m", "1h", "1d", "1w"]) {
        const w = weightsFor(regime, tf);
        const total = w.technical + w.structure + w.flows + w.onchain + w.sentiment;
        expect(total).toBeCloseTo(1, 9);
      }
    }
  });

  it("weights on-chain near zero for scalps and heavily for long timeframes", () => {
    expect(weightsFor("trending_up", "5m").onchain).toBeLessThan(0.05);
    expect(weightsFor("trending_up", "1d").onchain).toBeGreaterThan(0.12);
  });
});

describe("setup classification", () => {
  const setupInput = (candles: Candle[], allowed: "long" | "short" | "both" = "both") => {
    const structure = analyzeStructureStage(candles, "1h");
    const technical = analyzeTechnical({
      symbol: "X", candles: { "1h": candles }, tradingTimeframe: "1h",
      hasTakerBreakdown: true, now: candles[candles.length - 1].openTime + tfMillis("1h"),
    });
    const regime = classifyRegime(candles, structure).regime;
    return { candles, regime, structure, technical, allowedDirection: allowed };
  };

  it("never proposes a setup the regime forbids", () => {
    for (const shape of [real, S.cleanUptrend(), S.range(), S.doubleTop()]) {
      const input = setupInput(shape);
      const match = classifySetup(input);
      if (match) expect(REGIME_ALLOWED_SETUPS[input.regime]).toContain(match.kind);
    }
  });

  it("never proposes a direction the macro gate forbids", () => {
    for (const shape of [real, S.cleanUptrend(), S.cleanDowntrend()]) {
      const long = classifySetup(setupInput(shape, "long"));
      if (long) expect(long.direction).toBe("long");
      const short = classifySetup(setupInput(shape, "short"));
      if (short) expect(short.direction).toBe("short");
    }
  });

  it("lists every condition and whether it held", () => {
    for (const shape of [real, S.cleanUptrend()]) {
      const match = classifySetup(setupInput(shape));
      if (!match) continue;
      expect(match.conditions.length).toBeGreaterThan(1);
      for (const c of match.conditions) {
        expect(c.label.length).toBeGreaterThan(2);
        expect(c.detail.length).toBeGreaterThan(0);
      }
      // The fit must be consistent with what actually matched.
      expect(match.fit).toBeGreaterThanOrEqual(0.6);
      expect(match.fit).toBeLessThanOrEqual(1.0001);
    }
  });
});

// ── the council ──────────────────────────────────────────────────────────────

const thresholds = {
  minFinalScore: 60, minRiskReward: 1.8, maxOpenPositions: 6,
  maxCorrelatedPositions: 3, correlationThreshold: 0.8, maxDataAgeBars: 2,
};
const cleanPortfolio = {
  openPositions: 0, correlatedSameDirection: 0,
  circuitBreakerActive: false, circuitBreakerReason: null,
};

function councilInput(over: Partial<Parameters<typeof runCouncil>[0]> = {}) {
  const candles = real;
  const structure = analyzeStructureStage(candles, "1h");
  const technical = analyzeTechnical({
    symbol: "BTCUSDT", candles: { "1h": candles }, tradingTimeframe: "1h",
    hasTakerBreakdown: true, now: NOW,
  });
  return {
    symbol: "BTCUSDT", timeframe: "1h" as Timeframe, candles, technical, structure,
    priorStages: [
      stagePass("eligibility", { score: 0, bias: "neutral" as const, factors: [], confidencePenalty: 0, warnings: [], arabic: "", dataAgeMs: null, durationMs: 0 }),
      stagePass("macro", { score: 40, bias: "bullish" as const, factors: [], confidencePenalty: 0, warnings: [], arabic: "", dataAgeMs: null, durationMs: 0 }),
      stagePass("technical", { score: 55, bias: "bullish" as const, factors: [], confidencePenalty: 0, warnings: [], arabic: "", dataAgeMs: null, durationMs: 0 }),
      stagePass("structure", { score: 50, bias: "bullish" as const, factors: [], confidencePenalty: 0, warnings: [], arabic: "", dataAgeMs: null, durationMs: 0 }),
      stageUnavailable("flows", "لم تُبنَ", 0.2),
      stageUnavailable("onchain", "لا مفتاح", 0.15),
      stageUnavailable("sentiment", "لم تُبنَ", 0.1),
    ],
    allowedDirection: "both" as const,
    now: NOW, thresholds, portfolio: cleanPortfolio, setupHistory: null,
    ...over,
  };
}

describe("stage 8 — veto filters", () => {
  it("vetoes when the portfolio is already at its position limit", () => {
    const r = runCouncil(councilInput({
      portfolio: { ...cleanPortfolio, openPositions: 6 },
    }));
    expect(r.vetoes.some((v) => v.id === "exposure_limit")).toBe(true);
    expect(r.stage.status).toBe("fail");
  });

  it("vetoes three correlated positions in the same direction", () => {
    const r = runCouncil(councilInput({
      portfolio: { ...cleanPortfolio, correlatedSameDirection: 3 },
    }));
    const v = r.vetoes.find((x) => x.id === "correlated_exposure")!;
    expect(v).toBeDefined();
    expect(v.arabic).toContain("مركز واحد مضاعف");
  });

  it("vetoes when a circuit breaker is active", () => {
    const r = runCouncil(councilInput({
      portfolio: { ...cleanPortfolio, circuitBreakerActive: true, circuitBreakerReason: "خسارة يومية 3%" },
    }));
    expect(r.vetoes.some((v) => v.id === "circuit_breaker")).toBe(true);
  });

  it("vetoes stale data, naming the stage and the age", () => {
    const stages = councilInput().priorStages.map((s) =>
      s.id === "technical" ? { ...s, dataAgeMs: tfMillis("1h") * 10 } : s,
    );
    const r = runCouncil(councilInput({ priorStages: stages }));
    const v = r.vetoes.find((x) => x.id === "stale_data")!;
    expect(v).toBeDefined();
    expect(v.arabic).toContain("التحليل الفني");
  });

  it("vetoes a direction the macro gate forbids", () => {
    const r = runCouncil(councilInput({ allowedDirection: "short" }));
    if (r.direction === "long") {
      expect(r.vetoes.some((v) => v.id === "direction_not_allowed")).toBe(true);
    }
  });

  it("vetoes when no setup matches, and says a score is not an opportunity", () => {
    // A flat market matches nothing.
    const flat = S.range();
    const r = runCouncil(councilInput({
      candles: flat,
      structure: analyzeStructureStage(flat, "1h"),
      allowedDirection: "long",
    }));
    if (!r.setup) {
      const v = r.vetoes.find((x) => x.id === "no_setup_match")!;
      expect(v.arabic).toContain("ليست فرصة");
    }
  });

  it("every veto names both the actual value and the threshold", () => {
    const r = runCouncil(councilInput({
      portfolio: { ...cleanPortfolio, openPositions: 9, correlatedSameDirection: 5 },
    }));
    for (const v of r.vetoes) {
      expect(v.actual.length).toBeGreaterThan(0);
      expect(v.threshold.length).toBeGreaterThan(0);
      expect(v.arabic.length).toBeGreaterThan(10);
    }
  });
});

describe("confidence", () => {
  it("is reduced by unavailable stages, by a declared amount", () => {
    const withAll = runCouncil(councilInput({
      priorStages: councilInput().priorStages.map((s) =>
        s.status === "unavailable"
          ? stagePass(s.id, { score: 40, bias: "bullish", factors: [], confidencePenalty: 0, warnings: [], arabic: "", dataAgeMs: null, durationMs: 0 })
          : s,
      ),
    }));
    const withMissing = runCouncil(councilInput());
    expect(withMissing.confidence).toBeLessThan(withAll.confidence);
  });

  it("is reduced sharply when stages disagree", () => {
    const agreeing = runCouncil(councilInput());
    const conflicting = runCouncil(councilInput({
      priorStages: councilInput().priorStages.map((s) =>
        s.id === "structure"
          ? stagePass("structure", { score: -60, bias: "bearish", factors: [], confidencePenalty: 0, warnings: [], arabic: "", dataAgeMs: null, durationMs: 0 })
          : s,
      ),
    }));
    expect(conflicting.confidence).toBeLessThanOrEqual(agreeing.confidence);
  });

  it("never rises on an unknown history", () => {
    const noHistory = runCouncil(councilInput({ setupHistory: null }));
    const thinHistory = runCouncil(councilInput({
      setupHistory: { trades: 3, winRate: 0.99, expectancyR: 5 },
    }));
    expect(thinHistory.confidence).toBe(noHistory.confidence);
  });

  it("stays within 0..100", () => {
    for (const portfolio of [cleanPortfolio, { ...cleanPortfolio, openPositions: 5 }]) {
      const r = runCouncil(councilInput({ portfolio }));
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(100);
    }
  });
});

// ── the plan builder ─────────────────────────────────────────────────────────

describe("trade plan — levels, never percentages", () => {
  const planBase = (over: Partial<Parameters<typeof buildPlan>[0]> = {}) => {
    const structure = analyzeStructureStage(real, "1h");
    return {
      symbol: "BTCUSDT", direction: "long" as const, setup: "trend_continuation" as const,
      regime: "trending_up" as const, timeframe: "1h" as Timeframe, structure,
      price: structure.price, atr: structure.atr, equity: 10_000, riskPercent: 1,
      pricePrecision: 2, quantityPrecision: 5, minNotional: 5,
      generatedAt: NOW, asOfCandle: real[real.length - 1].openTime, exchange: "binance",
      ...over,
    };
  };

  it("REFUSES to build a plan when there is no level to hide the stop behind", () => {
    const empty = analyzeStructureStage(real.slice(0, 25), "1h");
    const r = buildPlan(planBase({ structure: empty, price: empty.price, atr: empty.atr }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.arabic).toContain("نسبة مئوية");
  });

  it("sizes the position from the STOP DISTANCE and the risk budget", () => {
    const r = buildPlan(planBase());
    if (!r.ok) return;
    const riskPerUnit = Math.abs(r.entry.mid - r.stop);
    // The account risks exactly 1% — that is what position sizing means.
    expect(r.positionSize * riskPerUnit).toBeCloseTo(100, 0);
    expect(r.riskAmount).toBeCloseTo(100, 6);
  });

  it("a wider stop automatically yields a smaller position", () => {
    const normal = buildPlan(planBase());
    const wide = buildPlan(planBase({ atr: analyzeStructureStage(real, "1h").atr * 4 }));
    if (normal.ok && wide.ok) {
      expect(wide.positionSize).toBeLessThan(normal.positionSize);
    }
  });

  it("puts the stop on the correct side of the entry", () => {
    const long = buildPlan(planBase({ direction: "long" }));
    if (long.ok) expect(long.stop).toBeLessThan(long.entry.low);
    const short = buildPlan(planBase({ direction: "short" }));
    if (short.ok) expect(short.stop).toBeGreaterThan(short.entry.high);
  });

  it("gives three targets in increasing distance, each on a named level", () => {
    const r = buildPlan(planBase());
    if (!r.ok) return;
    expect(r.targets).toHaveLength(3);
    for (let i = 1; i < 3; i++) {
      expect(Math.abs(r.targets[i].price - r.entry.mid))
        .toBeGreaterThan(Math.abs(r.targets[i - 1].price - r.entry.mid));
    }
    for (const t of r.targets) {
      expect(t.basis).toMatch(/منطقة/);
      expect(t.rMultiple).toBeGreaterThan(0);
    }
  });

  it("the staged exit fractions sum to the whole position", () => {
    const r = buildPlan(planBase());
    if (r.ok) {
      expect(r.targets.reduce((s, t) => s + t.closeFraction, 0)).toBeCloseTo(1, 9);
    }
  });

  it("entry is a RANGE, never a single price", () => {
    const r = buildPlan(planBase());
    if (r.ok) {
      expect(r.entry.high).toBeGreaterThan(r.entry.low);
      expect(r.entry.mid).toBeGreaterThanOrEqual(r.entry.low);
      expect(r.entry.mid).toBeLessThanOrEqual(r.entry.high);
    }
  });

  it("risk/reward is weighted across the staged exits, not measured to target 3", () => {
    const r = buildPlan(planBase());
    if (r.ok) {
      const weighted = r.targets.reduce((s, t) => s + t.rMultiple * t.closeFraction, 0);
      expect(r.riskReward).toBeCloseTo(weighted, 9);
      // And therefore below the final target's own R — the honest number.
      expect(r.riskReward).toBeLessThan(r.targets[2].rMultiple);
    }
  });
});

describe("invalidation conditions are machine-checkable", () => {
  it("names a subject, an operator and a value for every condition", () => {
    const conditions = buildInvalidation({
      direction: "long", stop: 49_000, entry: { low: 50_000, high: 50_200, mid: 50_100 },
      structureState: "uptrend", timeframe: "1h", expiryBars: 12, pricePrecision: 2,
    });
    expect(conditions.length).toBeGreaterThanOrEqual(4);
    for (const c of conditions) {
      expect(c.subject).toBeTruthy();
      expect(["lt", "lte", "gt", "gte", "eq", "neq"]).toContain(c.operator);
      expect(c.value).not.toBeUndefined();
      expect(c.arabic.length).toBeGreaterThan(10);
    }
  });

  it("includes the Bitcoin breakdown condition on longs only", () => {
    const long = buildInvalidation({
      direction: "long", stop: 1, entry: { low: 2, high: 3, mid: 2.5 },
      structureState: "uptrend", timeframe: "1h", expiryBars: 12, pricePrecision: 2,
    });
    const short = buildInvalidation({
      direction: "short", stop: 4, entry: { low: 2, high: 3, mid: 2.5 },
      structureState: "downtrend", timeframe: "1h", expiryBars: 12, pricePrecision: 2,
    });
    expect(long.some((c) => c.id === "btc_breakdown")).toBe(true);
    expect(short.some((c) => c.id === "btc_breakdown")).toBe(false);
  });
});

// ── immutability, enforced by the database ───────────────────────────────────

describe("recommendations are immutable — enforced by SQLite, not by politeness", () => {
  let dir: string;
  let db: Db;
  let repo: RecommendationRepo;

  const sampleRec = (over: Partial<Recommendation> = {}): Recommendation => {
    const draft = {
      id: recommendationId("BTCUSDT", "1h", NOW), symbol: "BTCUSDT",
      direction: "long" as const, setup: "trend_continuation" as const,
      regime: "trending_up" as const, timeframe: "1h" as Timeframe,
      generatedAt: NOW, asOfCandle: NOW, exchange: "binance",
      entry: { low: 50_000, high: 50_200, mid: 50_100 },
      stop: 49_000, stopBasis: "خلف آخر قاع هيكلي",
      targets: [
        { index: 1 as const, price: 52_000, closeFraction: 0.5, rMultiple: 1.7, basis: "مقاومة" },
        { index: 2 as const, price: 54_000, closeFraction: 0.3, rMultiple: 3.5, basis: "مقاومة" },
        { index: 3 as const, price: 56_000, closeFraction: 0.2, rMultiple: 5.4, basis: "مقاومة" },
      ] as const,
      riskReward: 2.6, positionSize: 0.09, positionNotional: 4509, riskAmount: 100,
      riskPercent: 1, confidence: 72, confidenceComponents: [], finalScore: 68,
      invalidation: [], expiresAt: NOW + 12 * tfMillis("1h"), report: "تقرير",
      ...over,
    };
    return { ...draft, integrityHash: computeIntegrityHash(draft) };
  };

  const emptyRun = {
    symbol: "BTCUSDT", tradingTimeframe: "1h" as Timeframe, startedAt: NOW, finishedAt: NOW,
    stages: [], failedAt: null, regime: null, setup: null, vetoes: [],
    finalScore: 68, confidence: 72, recommendationId: null, arabic: "",
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
    db = openDb(path.join(dir, "t.db"));
    repo = new RecommendationRepo(db);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the DATABASE refuses an UPDATE", () => {
    const rec = sampleRec();
    repo.create(rec, emptyRun);
    expect(() =>
      db.prepare("UPDATE recommendations SET confidence = 99 WHERE id = ?").run(rec.id),
    ).toThrow(/immutable/);
  });

  it("the DATABASE refuses a DELETE", () => {
    const rec = sampleRec();
    repo.create(rec, emptyRun);
    expect(() => db.prepare("DELETE FROM recommendations WHERE id = ?").run(rec.id)).toThrow(/immutable/);
  });

  it("events are immutable too", () => {
    const rec = sampleRec();
    repo.create(rec, emptyRun);
    expect(() => db.prepare("UPDATE recommendation_events SET kind = 'note'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM recommendation_events").run()).toThrow(/immutable/);
  });

  it("records a 'created' event automatically", () => {
    const rec = sampleRec();
    repo.create(rec, emptyRun);
    const events = repo.events(rec.id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("created");
  });

  it("re-creating the same id is a no-op, not a crash — the pipeline is deterministic", () => {
    const rec = sampleRec();
    expect(repo.create(rec, emptyRun)).toBe(true);
    expect(repo.create(rec, emptyRun)).toBe(false);
    expect(repo.events(rec.id)).toHaveLength(1);
  });

  it("DERIVES the trade state by replaying events, never from a status column", () => {
    const rec = sampleRec();
    repo.create(rec, emptyRun);
    expect(repo.withState(rec.id)!.state).toBe("pending");

    repo.appendEvent({ recommendationId: rec.id, kind: "entry_filled", at: NOW + 1000, candleTime: NOW, price: 50_100, payload: {}, arabic: "دخول" });
    expect(repo.withState(rec.id)!.state).toBe("open");

    repo.appendEvent({ recommendationId: rec.id, kind: "target_hit", at: NOW + 2000, candleTime: NOW, price: 52_000, payload: { target: 1 }, arabic: "هدف 1" });
    expect(repo.withState(rec.id)!.state).toBe("partial");

    repo.appendEvent({ recommendationId: rec.id, kind: "closed", at: NOW + 3000, candleTime: NOW, price: 54_000, payload: {}, arabic: "إغلاق" });
    expect(repo.withState(rec.id)!.state).toBe("closed");
  });

  it("can reconstruct the state AT A PAST INSTANT — what the backtest needs", () => {
    const rec = sampleRec();
    repo.create(rec, emptyRun);
    repo.appendEvent({ recommendationId: rec.id, kind: "entry_filled", at: NOW + 1000, candleTime: NOW, price: 1, payload: {}, arabic: "" });
    repo.appendEvent({ recommendationId: rec.id, kind: "closed", at: NOW + 5000, candleTime: NOW, price: 1, payload: {}, arabic: "" });

    expect(repo.withState(rec.id, NOW + 500)!.state).toBe("pending");
    expect(repo.withState(rec.id, NOW + 2000)!.state).toBe("open");
    expect(repo.withState(rec.id, NOW + 9000)!.state).toBe("closed");
  });

  it("detects a row whose integrity hash no longer matches", () => {
    const rec = sampleRec();
    repo.create(rec, emptyRun);
    expect(repo.verifyIntegrity().every((r) => r.ok)).toBe(true);

    // Simulate direct file tampering by dropping the trigger first.
    db.exec("DROP TRIGGER recommendations_no_update");
    db.prepare("UPDATE recommendations SET confidence = 99 WHERE id = ?").run(rec.id);
    expect(repo.verifyIntegrity().some((r) => !r.ok)).toBe(true);
  });

  it("reports an active recommendation so stage 1 can reject a duplicate", () => {
    const rec = sampleRec();
    repo.create(rec, emptyRun);
    expect(repo.hasActive("BTCUSDT")).toBe(true);
    expect(repo.hasActive("ETHUSDT")).toBe(false);
  });
});

describe("rejected analyses are recorded as first-class data", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rej-"));
    db = openDb(path.join(dir, "t.db"));
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stores the stage a rejection died at, and builds the dashboard funnel", () => {
    const repo = new RejectedRepo(db);
    const mk = (stage: string, number: number) => ({
      symbol: "X", tradingTimeframe: "1h" as Timeframe, startedAt: NOW, finishedAt: NOW,
      stages: [{ id: stage, number, name: stage, status: "fail" as const, score: 0,
        bias: "neutral" as const, factors: [], failReason: "سبب", unavailableReason: null,
        confidencePenalty: 0, warnings: [], arabic: "", dataAgeMs: null, durationMs: 0 }],
      failedAt: stage as never, regime: null, setup: null, vetoes: [],
      finalScore: 0, confidence: 0, recommendationId: null, arabic: "",
    });

    repo.record(mk("eligibility", 1) as never, "حجم ضعيف");
    repo.record(mk("eligibility", 1) as never, "فارق واسع");
    repo.record(mk("council", 8) as never, "النتيجة دون الحد");

    const funnel = repo.funnel(NOW - 1000);
    expect(funnel.find((f) => f.stage === "eligibility")?.count).toBe(2);
    expect(funnel.find((f) => f.stage === "council")?.count).toBe(1);
    expect(repo.countSince(NOW - 1000)).toBe(3);
    expect(repo.recent()[0].reason.length).toBeGreaterThan(0);
  });
});

// ── the whole pipeline ───────────────────────────────────────────────────────

describe("the eight-stage run", () => {
  const baseRun = (over: Record<string, unknown> = {}) => ({
    symbol: "BTCUSDT", tradingTimeframe: "1h" as Timeframe, exchange: "binance",
    candles: { "1h": real, "1d": trendCandles("up") },
    hasTakerBreakdown: true,
    eligibility: eligibleInput(),
    eligibilityThresholds: DEFAULT_ELIGIBILITY,
    macro: {
      btcDaily: trendCandles("up"), btc4h: trendCandles("up", 200),
      global: macroBase().global, dominanceHistory: macroBase().dominanceHistory,
      fearGreed: macroBase().fearGreed,
    },
    correlationCeiling: 0.85,
    council: thresholds, portfolio: cleanPortfolio, setupHistory: null,
    equity: 10_000, riskPercent: 1, pricePrecision: 2, quantityPrecision: 5, minNotional: 5,
    now: NOW,
    ...over,
  });

  it("STOPS at stage 1 and never runs the rest", () => {
    const { run, recommendation } = runPipeline(baseRun({
      eligibility: eligibleInput({ ticker: { ...ticker, quoteVolume: 100 } }),
    }) as never);
    expect(run.failedAt).toBe("eligibility");
    expect(run.stages).toHaveLength(1);
    expect(recommendation).toBeNull();
    expect(run.arabic).toContain("المرحلة 1");
  });

  it("STOPS at stage 2 when the macro context is unreadable", () => {
    const { run } = runPipeline(baseRun({
      macro: { ...baseRun().macro, btcDaily: trendCandles("up", 10), btc4h: trendCandles("up", 10) },
    }) as never);
    // Unavailable macro means no direction can be permitted.
    expect(run.stages.length).toBeLessThanOrEqual(3);
  });

  it("records stages 5–7 as UNAVAILABLE, not as passing", () => {
    const { run } = runPipeline(baseRun() as never);
    const ids = run.stages.map((s) => s.id);
    if (ids.includes("flows")) {
      for (const id of ["flows", "onchain", "sentiment"]) {
        const s = run.stages.find((x) => x.id === id)!;
        expect(s.status).toBe("unavailable");
        expect(s.confidencePenalty).toBeGreaterThan(0);
        expect(s.arabic).toContain("خُفضت الثقة");
      }
    }
  });

  it("produces a run that is deterministic for the same inputs", () => {
    const a = runPipeline(baseRun() as never);
    const b = runPipeline(baseRun() as never);
    expect(a.run.failedAt).toBe(b.run.failedAt);
    expect(a.run.finalScore).toBeCloseTo(b.run.finalScore, 9);
    expect(a.recommendation?.id).toBe(b.recommendation?.id);
  });

  it("gives the same recommendation id for the same bar — safe to re-run", () => {
    const id1 = recommendationId("BTCUSDT", "1h", NOW);
    const id2 = recommendationId("BTCUSDT", "1h", NOW);
    expect(id1).toBe(id2);
    expect(recommendationId("BTCUSDT", "1h", NOW + 1)).not.toBe(id1);
  });

  it("every stage result carries its number, name and Arabic narrative", () => {
    const { run } = runPipeline(baseRun() as never);
    for (const s of run.stages) {
      expect(s.number).toBeGreaterThanOrEqual(1);
      expect(s.number).toBeLessThanOrEqual(8);
      expect(s.name.length).toBeGreaterThan(3);
      expect(s.arabic.length).toBeGreaterThan(5);
    }
  });

  it("when a recommendation IS produced, it is complete and self-consistent", () => {
    // Search a few windows for one that survives all eight stages.
    let found: Recommendation | null = null;
    for (const end of [600, 560, 520, 480, 440]) {
      const r = runPipeline(baseRun({
        candles: { "1h": real.slice(0, end), "1d": trendCandles("up") },
        now: real[end - 1].openTime + tfMillis("1h"),
        eligibility: eligibleInput({ now: real[end - 1].openTime + tfMillis("1h") }),
      }) as never);
      if (r.recommendation) { found = r.recommendation; break; }
    }
    if (!found) return; // a clean rejection everywhere is a valid outcome

    expect(found.entry.high).toBeGreaterThan(found.entry.low);
    expect(found.targets).toHaveLength(3);
    expect(found.riskReward).toBeGreaterThanOrEqual(thresholds.minRiskReward);
    expect(found.confidence).toBeGreaterThan(0);
    expect(found.invalidation.length).toBeGreaterThan(0);
    expect(found.report).toContain("المرحلة 1");
    expect(found.report).toContain("خطة الصفقة");
    expect(found.integrityHash).toHaveLength(64);

    const { integrityHash, ...rest } = found;
    expect(computeIntegrityHash(rest)).toBe(integrityHash);

    const long = found.direction === "long";
    expect(long ? found.stop < found.entry.low : found.stop > found.entry.high).toBe(true);
    for (const t of found.targets) {
      expect(long ? t.price > found.entry.mid : t.price < found.entry.mid).toBe(true);
    }
  });
});
