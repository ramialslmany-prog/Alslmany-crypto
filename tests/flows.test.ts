/**
 * Flows and derivatives.
 *
 * The cases worth pinning are the ones where a plausible-looking shortcut
 * produces a confident wrong answer:
 *   - a venue without a taker split reading as relentless selling
 *   - a spoofed wall counted as real supply
 *   - a funding rate called "extreme" with no history to compare against
 *   - extreme funding in the trade's own direction treated as a deduction
 *     rather than the veto it is
 */
import { describe, expect, it } from "vitest";
import { analyzeCvd } from "@/core/flows/cvd";
import { findLargeTrades } from "@/core/flows/large-trades";
import { analyzeImbalance, findWalls, trackWalls } from "@/core/flows/orderbook";
import {
  analyzeFunding, analyzeOpenInterest, analyzePositioning,
  compositeRead, estimateLiquidationClusters,
} from "@/core/flows/derivatives";
import { runFlows } from "@/core/pipeline/stage5-flows";
import type { Candle, FundingRate, LongShortRatio, OpenInterest, OrderBook, Trade } from "@/core/types";

const NOW = Date.UTC(2024, 5, 1);
const HOUR = 3_600_000;

function candles(count: number, opts: { takerShare?: number; drift?: number; base?: number } = {}): Candle[] {
  const share = opts.takerShare ?? 0.5;
  const drift = opts.drift ?? 0;
  let p = opts.base ?? 100;
  return Array.from({ length: count }, (_, i) => {
    const open = p;
    const close = open * (1 + drift + Math.sin(i / 7) * 0.004);
    const volume = 1000;
    p = close;
    return {
      openTime: NOW - (count - i) * HOUR, closeTime: NOW - (count - i - 1) * HOUR,
      open, high: Math.max(open, close) * 1.004, low: Math.min(open, close) * 0.996, close,
      volume, quoteVolume: volume * close, trades: 100,
      takerBuyBase: volume * share, takerBuyQuote: volume * share * close,
    };
  });
}

const book = (mid: number, over: Partial<OrderBook> = {}): OrderBook => ({
  symbol: "BTCUSDT",
  bids: Array.from({ length: 30 }, (_, i) => ({ price: mid - 1 - i, quantity: 10 })),
  asks: Array.from({ length: 30 }, (_, i) => ({ price: mid + 1 + i, quantity: 10 })),
  timestamp: NOW, lastUpdateId: 1, ...over,
});

// ── CVD ──────────────────────────────────────────────────────────────────────

describe("cumulative volume delta", () => {
  it("is positive when buyers are the aggressors", () => {
    const r = analyzeCvd(candles(120, { takerShare: 0.65 }));
    expect(r.netRatio).toBeGreaterThan(0.2);
    expect(r.arabic).toContain("المشترون هم المبادرون");
  });

  it("is negative when sellers are", () => {
    const r = analyzeCvd(candles(120, { takerShare: 0.35 }));
    expect(r.netRatio).toBeLessThan(-0.2);
  });

  it("is flat when the split is even", () => {
    const r = analyzeCvd(candles(120, { takerShare: 0.5 }));
    expect(Math.abs(r.netRatio)).toBeLessThan(0.02);
    expect(r.arabic).toContain("متوازنة");
  });

  it("READS AS MAXIMUM SELLING on a venue with no taker split — the bug we gate", () => {
    // Bybit and OKX candles carry takerBuyBase = 0. This is what the number
    // would say if the capability flag were ignored.
    const r = analyzeCvd(candles(120, { takerShare: 0 }));
    expect(r.netRatio).toBeCloseTo(-1, 6);
  });

  it("returns a series the same length as its input", () => {
    const c = candles(80);
    expect(analyzeCvd(c).cumulative).toHaveLength(80);
    expect(analyzeCvd(c).perBar).toHaveLength(80);
  });
});

// ── large trades ─────────────────────────────────────────────────────────────

describe("large trades", () => {
  const routine = (n: number, notional: number): Trade[] =>
    Array.from({ length: n }, (_, i) => ({
      id: i, price: 100, quantity: notional / 100, quoteQuantity: notional,
      timestamp: NOW - (n - i) * 1000, buyerIsMaker: i % 2 === 0,
    }));

  it("finds nothing when every print is the same size", () => {
    expect(findLargeTrades(routine(100, 500)).trades).toHaveLength(0);
  });

  it("finds a whale among routine prints", () => {
    const trades = [
      ...routine(100, 500),
      { id: 999, price: 100, quantity: 500, quoteQuantity: 50_000, timestamp: NOW, buyerIsMaker: false },
    ];
    const r = findLargeTrades(trades);
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.trades[0].side).toBe("buy");
    expect(r.bias).toBeGreaterThan(0);
  });

  it("uses the MEDIAN, so a cluster of whales cannot hide itself", () => {
    // With a mean-based threshold, ten whales drag the average up and none of
    // them register. With a median they all do.
    const trades = [
      ...routine(100, 500),
      ...Array.from({ length: 10 }, (_, i) => ({
        id: 900 + i, price: 100, quantity: 400, quoteQuantity: 40_000,
        timestamp: NOW - i * 500, buyerIsMaker: false,
      })),
    ];
    expect(findLargeTrades(trades).trades.length).toBeGreaterThanOrEqual(10);
  });

  it("declines on too few trades rather than guessing", () => {
    const r = findLargeTrades(routine(10, 500));
    expect(r.trades).toHaveLength(0);
    expect(r.arabic).toContain("غير كافٍ");
  });
});

// ── order book ───────────────────────────────────────────────────────────────

describe("order book imbalance", () => {
  it("is near zero for a symmetric book", () => {
    expect(Math.abs(analyzeImbalance(book(100)).imbalance)).toBeLessThan(0.05);
  });

  it("leans to the side with more depth", () => {
    const heavyBids = book(100, {
      bids: Array.from({ length: 30 }, (_, i) => ({ price: 100 - 1 - i, quantity: 100 })),
    });
    expect(analyzeImbalance(heavyBids).imbalance).toBeGreaterThan(0.5);
  });

  it("warns that a snapshot is a snapshot", () => {
    expect(analyzeImbalance(book(100)).arabic).toContain("لقطة لحظية");
  });

  it("handles an empty book without throwing", () => {
    const r = analyzeImbalance({ symbol: "X", bids: [], asks: [], timestamp: NOW, lastUpdateId: 0 });
    expect(r.imbalance).toBe(0);
    expect(r.arabic).toContain("فارغ");
  });
});

describe("liquidity walls", () => {
  const withWall = (mid: number, wallPrice: number, size: number): OrderBook => ({
    ...book(mid),
    asks: Array.from({ length: 30 }, (_, i) => {
      const price = mid + 1 + i;
      return { price, quantity: Math.abs(price - wallPrice) < 0.5 ? size : 10 };
    }),
  });

  it("finds a level far larger than its neighbours", () => {
    const walls = findWalls(withWall(100, 103, 500));
    expect(walls.length).toBeGreaterThan(0);
    expect(walls[0].price).toBeCloseTo(103, 1);
    expect(walls[0].multiple).toBeGreaterThan(5);
  });

  it("IGNORES a wall further away than the search band", () => {
    // A wall 20% away will not be reached in the life of the setup, and
    // counting it would clutter the reading with irrelevant levels.
    expect(findWalls(withWall(100, 120, 500))).toHaveLength(0);
  });

  it("finds nothing in an even book", () => {
    expect(findWalls(book(100))).toHaveLength(0);
  });

  it("CLASSIFIES A SPOOF: the wall vanishes as price approaches it", () => {
    // Price moves 100 → 102 while the 103 wall disappears.
    const before = withWall(100, 103, 500);
    const after = withWall(102, 103, 10);
    const tracked = trackWalls([before, after]);
    const wall = tracked.find((w) => Math.abs(w.price - 103) < 0.5)!;
    expect(wall.behaviour).toBe("pulled");
    expect(wall.arabic).toContain("أمر وهمي");
  });

  it("classifies a wall that HELD through an approach as real", () => {
    const before = withWall(100, 103, 500);
    const after = withWall(102, 103, 500);
    const wall = trackWalls([before, after]).find((w) => Math.abs(w.price - 103) < 0.5)!;
    expect(wall.behaviour).toBe("held");
    expect(wall.arabic).toContain("سيولة حقيقية");
  });

  it("does not call a wall spoofed when price never came near it", () => {
    const before = withWall(100, 103, 500);
    const after = withWall(96, 103, 10); // shrank, but price moved AWAY
    const wall = trackWalls([before, after]).find((w) => Math.abs(w.price - 103) < 0.5)!;
    expect(wall.behaviour).toBe("consumed");
  });

  it("returns nothing from a single snapshot — behaviour needs a sequence", () => {
    expect(trackWalls([book(100)])).toHaveLength(0);
  });
});

// ── derivatives ──────────────────────────────────────────────────────────────

const funding = (rate: number, at = NOW): FundingRate => ({
  symbol: "BTCUSDT", rate, fundingTime: at, intervalHours: 8,
});

describe("funding", () => {
  it("REFUSES to call a rate extreme without enough history", () => {
    const r = analyzeFunding(funding(0.003), [funding(0.0001), funding(0.0002)]);
    expect(r.percentile).toBeNull();
    expect(r.extreme).toBe("none");
    expect(r.arabic).toContain("الرقم وحده لا يعني شيئاً");
  });

  it("places a rate inside its own distribution once history exists", () => {
    const history = Array.from({ length: 200 }, (_, i) => funding(0.00005 + (i % 20) * 0.000005));
    const high = analyzeFunding(funding(0.002), history);
    expect(high.percentile).toBeGreaterThan(0.9);
    expect(high.extreme).toBe("high");
    expect(high.arabic).toContain("مزدحم في جانب الشراء");
  });

  it("recognises an extreme LOW as crowding on the short side", () => {
    const history = Array.from({ length: 200 }, (_, i) => funding(0.0005 + (i % 20) * 0.00001));
    const low = analyzeFunding(funding(-0.002), history);
    expect(low.extreme).toBe("low");
  });

  it("annualises so the number is comparable to any other yield", () => {
    // 0.01% every 8h = 3 times a day = 1095 periods a year.
    const r = analyzeFunding(funding(0.0001), []);
    expect(r.annualizedPct).toBeCloseTo(0.0001 * 1095 * 100, 6);
  });
});

describe("open interest and positioning", () => {
  const oi = (v: number, i: number): OpenInterest => ({
    symbol: "BTCUSDT", openInterest: v, openInterestValue: v * 50_000, timestamp: NOW - i * HOUR,
  });

  it("reports the change across the window", () => {
    const r = analyzeOpenInterest([oi(1000, 5), oi(1100, 4), oi(1200, 0)]);
    expect(r.changePct).toBeCloseTo(20, 6);
  });

  it("declines on a single reading", () => {
    expect(analyzeOpenInterest([oi(1000, 0)]).changePct).toBeNull();
  });

  it("warns that account ratios are not capital ratios", () => {
    const ls: LongShortRatio[] = Array.from({ length: 40 }, (_, i) => ({
      symbol: "BTCUSDT", longAccountPct: 60, shortAccountPct: 40, ratio: 1.5, timestamp: NOW - i * HOUR,
    }));
    expect(analyzePositioning(ls)!.arabic).toContain("ليست نسبة رأس المال");
  });
});

describe("liquidation clusters", () => {
  it("places long clusters below price and short clusters above", () => {
    const clusters = estimateLiquidationClusters(100, 10_000_000);
    for (const c of clusters) {
      if (c.side === "long") expect(c.price).toBeLessThan(100);
      else expect(c.price).toBeGreaterThan(100);
    }
  });

  it("weights lower leverage more heavily than the 100x tier", () => {
    const clusters = estimateLiquidationClusters(100, 10_000_000);
    const at10x = clusters.find((c) => c.side === "long" && Math.abs(c.price - 90) < 0.1)!;
    const at100x = clusters.find((c) => c.side === "long" && Math.abs(c.price - 99) < 0.1)!;
    expect(at10x.estimatedNotional).toBeGreaterThan(at100x.estimatedNotional);
  });

  it("returns nothing without a price or open interest", () => {
    expect(estimateLiquidationClusters(0, 1000)).toHaveLength(0);
    expect(estimateLiquidationClusters(100, 0)).toHaveLength(0);
  });
});

// ── the composite readings ───────────────────────────────────────────────────

describe("composite readings — the spec's three rules", () => {
  const history = Array.from({ length: 200 }, (_, i) => funding(0.00005 + (i % 20) * 0.000005));
  const highFunding = analyzeFunding(funding(0.002), history);
  const normalFunding = analyzeFunding(funding(0.00008), history);
  const lowHistory = Array.from({ length: 200 }, (_, i) => funding(0.0005 + (i % 20) * 0.00001));
  const lowFunding = analyzeFunding(funding(-0.002), lowHistory);

  it("VETOES a long when funding is extreme on the long side", () => {
    const r = compositeRead({
      priceChangePct: 5, openInterestChangePct: 10, funding: highFunding,
      cvdNetRatio: 0.2, direction: "long",
    });
    expect(r.kind).toBe("crowded_against");
    expect(r.veto).toBe(true);
    expect(r.confidenceMultiplier).toBe(0);
    expect(r.arabic).toContain("الصفقة تسقط");
  });

  it("does NOT veto a SHORT when funding is extreme on the long side", () => {
    // The crowding is on the other side — that is fuel, not a warning.
    const r = compositeRead({
      priceChangePct: 5, openInterestChangePct: 10, funding: highFunding,
      cvdNetRatio: 0.2, direction: "short",
    });
    expect(r.veto).toBe(false);
  });

  it("LOWERS confidence for a rise funded by leverage", () => {
    // History runs 0.00005 … 0.000145. This sits around the 80th percentile —
    // above the 0.7 threshold for "leveraged" but below the 0.9 that vetoes.
    const funded = analyzeFunding(funding(0.000125), history);
    const r = compositeRead({
      priceChangePct: 8, openInterestChangePct: 15, funding: funded,
      cvdNetRatio: 0.1, direction: "long",
    });
    expect(r.kind).toBe("leveraged_fragile");
    expect(r.confidenceMultiplier).toBeLessThan(1);
    expect(r.arabic).toContain("مموّل برافعة");
  });

  it("RAISES confidence for genuine spot demand", () => {
    const r = compositeRead({
      priceChangePct: 8, openInterestChangePct: -4, funding: normalFunding,
      cvdNetRatio: 0.18, direction: "long",
    });
    expect(r.kind).toBe("genuine_spot");
    expect(r.confidenceMultiplier).toBeGreaterThan(1);
    expect(r.arabic).toContain("شراء نقدي حقيقي");
  });

  it("recognises trapped shorts as fuel rather than fragility", () => {
    const r = compositeRead({
      priceChangePct: 8, openInterestChangePct: 15, funding: lowFunding,
      cvdNetRatio: 0.05, direction: "long",
    });
    expect(r.kind).toBe("short_squeeze_fuel");
    expect(r.confidenceMultiplier).toBeGreaterThan(1);
  });

  it("claims nothing when the conditions do not line up", () => {
    const r = compositeRead({
      priceChangePct: 0.2, openInterestChangePct: 0.5, funding: normalFunding,
      cvdNetRatio: 0.0, direction: "long",
    });
    expect(r.kind).toBe("none");
    expect(r.confidenceMultiplier).toBe(1);
  });
});

// ── the stage ────────────────────────────────────────────────────────────────

describe("stage 5", () => {
  const fullInput = (over: Partial<Parameters<typeof runFlows>[0]> = {}) => ({
    symbol: "BTCUSDT",
    candles: candles(120, { takerShare: 0.58, drift: 0.002 }),
    hasTakerBreakdown: true,
    trades: Array.from({ length: 200 }, (_, i) => ({
      id: i, price: 100, quantity: 5, quoteQuantity: 500,
      timestamp: NOW - i * 1000, buyerIsMaker: i % 3 === 0,
    })),
    bookSnapshots: [book(100), book(100)],
    funding: funding(0.0001),
    fundingHistory: Array.from({ length: 200 }, (_, i) => funding(0.00005 + (i % 20) * 0.000005)),
    openInterest: Array.from({ length: 24 }, (_, i) => ({
      symbol: "BTCUSDT", openInterest: 1000 + i, openInterestValue: (1000 + i) * 50_000,
      timestamp: NOW - (24 - i) * HOUR,
    })),
    longShort: Array.from({ length: 40 }, (_, i) => ({
      symbol: "BTCUSDT", longAccountPct: 55, shortAccountPct: 45, ratio: 1.22, timestamp: NOW - i * HOUR,
    })),
    direction: "long" as const,
    now: NOW,
    ...over,
  });

  it("passes with a full set of inputs", () => {
    const r = runFlows(fullInput());
    expect(r.status).toBe("pass");
    expect(r.cvd).not.toBeNull();
    expect(r.funding).not.toBeNull();
  });

  it("factor contributions reproduce the score", () => {
    const r = runFlows(fullInput());
    const sum = r.factors.reduce((s, f) => s + f.contribution, 0);
    expect(r.score).toBeCloseTo(Math.max(-100, Math.min(100, sum)), 9);
  });

  it("marks CVD unavailable — never zero — on a venue without the split", () => {
    const r = runFlows(fullInput({ hasTakerBreakdown: false }));
    const cvdFactor = r.factors.find((f) => f.id === "cvd")!;
    expect(cvdFactor.value).toBeNull();
    expect(cvdFactor.contribution).toBe(0);
    expect(cvdFactor.note).toContain("بيعاً عنيفاً في كل شمعة");
    expect(r.cvd).toBeNull();
  });

  it("FAILS the stage on the crowding veto, rather than deducting", () => {
    const extremeHistory = Array.from({ length: 200 }, (_, i) => funding(0.00005 + (i % 20) * 0.000005));
    const r = runFlows(fullInput({
      funding: funding(0.003), fundingHistory: extremeHistory, direction: "long",
    }));
    expect(r.status).toBe("fail");
    expect(r.failReason).toContain("مزدحم في جانبك");
    expect(r.confidenceMultiplier).toBe(0);
  });

  it("reports unavailable when almost nothing is readable", () => {
    const r = runFlows(fullInput({
      hasTakerBreakdown: false, trades: null, bookSnapshots: null,
      funding: null, fundingHistory: null, openInterest: null, longShort: null,
    }));
    expect(r.status).toBe("unavailable");
    expect(r.confidencePenalty).toBeGreaterThan(0);
  });

  it("says a single book snapshot cannot tell a spoof from real supply", () => {
    const withWall: OrderBook = {
      ...book(100),
      asks: Array.from({ length: 30 }, (_, i) => {
        const price = 101 + i;
        return { price, quantity: Math.abs(price - 103) < 0.5 ? 500 : 10 };
      }),
    };
    const r = runFlows(fullInput({ bookSnapshots: [withWall] }));
    const wallFactor = r.factors.find((f) => f.id === "walls");
    expect(wallFactor?.note).toContain("لقطة واحدة لا تكفي");
  });

  it("labels the liquidation estimate as a model, not a measurement", () => {
    const r = runFlows(fullInput());
    const liq = r.factors.find((f) => f.id === "liquidations");
    if (liq) {
      expect(liq.note).toContain("وليس قياساً");
      expect(liq.label).toContain("تقدير");
    }
  });

  it("never lets open interest vote on its own", () => {
    const r = runFlows(fullInput());
    const oi = r.factors.find((f) => f.id === "open_interest")!;
    expect(oi.contribution).toBe(0);
    expect(oi.note).toContain("وحدها لا تحمل اتجاهاً");
  });

  it("is deterministic", () => {
    const input = fullInput();
    expect(runFlows(input).score).toBe(runFlows(input).score);
  });
});
