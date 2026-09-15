/**
 * Paper execution, monitoring and portfolio protection.
 *
 * The cases this suite exists for are the ones that separate an honest
 * backtest from a flattering one:
 *   - a bar that touches BOTH the stop and a target
 *   - a bar that GAPS through the stop
 *   - execution at the next open rather than at the trigger price
 *   - slippage that scales with real liquidity instead of a constant
 * Each of these, done the easy way, invents profit that never existed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, openDb, type Db } from "@/storage/db";
import { PositionRepo, EquityRepo, BreakerRepo } from "@/storage/repositories/positions";
import { DEFAULT_COSTS, fillFromBook, fillFromLiquidity, roundTripCostBps } from "@/core/execution/fills";
import { evaluatePosition, updateExcursions, __testing as monitorTesting } from "@/core/execution/monitor";
import { applyActions, closeSummary, openPending } from "@/core/execution/paper-broker";
import {
  activeBreakers, checkRisk, evaluateBreakers, positionSizeFor, updateSnapshot, type RiskLimits,
} from "@/core/execution/risk";
import { LiveBroker, LiveTradingDisabledError } from "@/core/execution/live-broker";
import { getConfig } from "@/shared/config";
import type { Candle, OrderBook } from "@/core/types";
import type { InvalidationCondition } from "@/core/recommendation/types";
import type { PortfolioSnapshot, Position } from "@/core/execution/types";

const NOW = Date.UTC(2024, 5, 1, 12, 0, 0);
const HOUR = 3_600_000;

const candle = (o: number, h: number, l: number, c: number, v = 1000): Candle => ({
  openTime: NOW, closeTime: NOW + HOUR, open: o, high: h, low: l, close: c,
  volume: v, quoteVolume: v * c, trades: 100, takerBuyBase: v * 0.5, takerBuyQuote: 0,
});

const book = (mid: number, depth = 10): OrderBook => ({
  symbol: "BTCUSDT",
  bids: Array.from({ length: 20 }, (_, i) => ({ price: mid - 1 - i, quantity: depth })),
  asks: Array.from({ length: 20 }, (_, i) => ({ price: mid + 1 + i, quantity: depth })),
  timestamp: NOW, lastUpdateId: 1,
});

const basePosition = (over: Partial<Position> = {}): Position => ({
  ...openPending({
    id: "p1", recommendationId: "r1", symbol: "BTCUSDT", direction: "long",
    timeframe: "1h", entry: { low: 99, high: 101, mid: 100 }, stop: 95,
    targets: [
      { index: 1, price: 110, closeFraction: 0.5 },
      { index: 2, price: 120, closeFraction: 0.3 },
      { index: 3, price: 130, closeFraction: 0.2 },
    ],
    size: 10, risk: 50, expiresAt: NOW + 12 * HOUR,
  }),
  ...over,
});

const ctx = (c: Candle, over: Partial<Parameters<typeof evaluatePosition>[1]> = {}) => ({
  candle: c, barIndex: 10, atr: 2, structureState: "uptrend",
  stageScores: { technical: 50, structure: 40 }, btcDailyScore: 30,
  flowsAgainst: false, invalidation: [] as InvalidationCondition[], now: NOW, ...over,
});

const execCtx = (c: Candle, orderBook: OrderBook | null = null) => ({
  candle: c, orderBook, costs: DEFAULT_COSTS, now: NOW,
});

// ── fills ────────────────────────────────────────────────────────────────────

describe("fill model", () => {
  it("walks the book: a bigger order gets a worse average price", () => {
    const small = fillFromBook(book(100), "buy", 5);
    const large = fillFromBook(book(100), "buy", 150);
    expect(large.price).toBeGreaterThan(small.price);
    expect(large.slippageBps).toBeGreaterThan(small.slippageBps);
  });

  it("flags when the visible book could not absorb the order", () => {
    const shallow: OrderBook = { ...book(100), asks: [{ price: 101, quantity: 1 }] };
    const r = fillFromBook(shallow, "buy", 500);
    expect(r.partialLiquidity).toBe(true);
    expect(r.basis).toContain("العمق لم يكفِ");
  });

  it("a buy fills above the reference and a sell below it — never the reverse", () => {
    const buy = fillFromBook(book(100), "buy", 10);
    const sell = fillFromBook(book(100), "sell", 10);
    expect(buy.price).toBeGreaterThan(100);
    expect(sell.price).toBeLessThan(100);
  });

  it("charges a fee on the notional actually transacted", () => {
    const r = fillFromBook(book(100), "buy", 10);
    expect(r.fee).toBeCloseTo(r.price * 10 * (DEFAULT_COSTS.takerFeeBps / 10_000), 9);
  });

  it("SCALES with liquidity: the same order costs more on a thin bar", () => {
    const liquid = fillFromLiquidity(candle(100, 101, 99, 100, 1_000_000), "buy", 10, 100);
    const thin = fillFromLiquidity(candle(100, 101, 99, 100, 50), "buy", 10, 100);
    expect(thin.slippageBps).toBeGreaterThan(liquid.slippageBps);
  });

  it("never returns a free fill, even on a perfect book", () => {
    const r = fillFromBook(book(100), "buy", 0.001);
    expect(r.slippageBps).toBeGreaterThanOrEqual(DEFAULT_COSTS.minSlippageBps);
  });

  it("caps a pathological estimate rather than producing an absurd number", () => {
    const r = fillFromLiquidity(candle(100, 500, 1, 100, 0.0001), "buy", 1_000_000, 100);
    expect(r.slippageBps).toBeLessThanOrEqual(DEFAULT_COSTS.maxSlippageBps);
  });

  it("round-trip cost counts BOTH sides", () => {
    expect(roundTripCostBps(DEFAULT_COSTS, 5)).toBe((10 + 5) * 2);
  });
});

// ── the monitor ──────────────────────────────────────────────────────────────

describe("entry timing", () => {
  it("does NOT enter until price reaches the entry zone", () => {
    const away = candle(105, 106, 104, 105);
    expect(evaluatePosition(basePosition(), ctx(away))).toEqual([]);
  });

  it("enters when the candle trades inside the zone", () => {
    const touched = candle(103, 104, 99.5, 102);
    const actions = evaluatePosition(basePosition(), ctx(touched));
    expect(actions[0].kind).toBe("fill_entry");
  });

  it("REFUSES to enter when the same bar also took out the stop", () => {
    // Reaching the entry and the stop on one bar means the idea failed before
    // it started; entering would be reading a favourable order into the bar.
    const violent = candle(103, 104, 94, 96);
    const actions = evaluatePosition(basePosition(), ctx(violent));
    expect(actions[0].kind).toBe("invalidate");
    expect((actions[0] as { reason: string }).reason).toContain("سقطت قبل أن تبدأ");
  });

  it("expires when the entry is never reached in time", () => {
    const actions = evaluatePosition(basePosition(), ctx(candle(105, 106, 104, 105), { now: NOW + 20 * HOUR }));
    expect(actions[0].kind).toBe("expire");
  });

  it("re-validates immediately before executing and cancels on a material change", () => {
    const invalidation: InvalidationCondition[] = [{
      id: "structure_flip", subject: "structure_state", operator: "eq", value: "downtrend",
      arabic: "انقلب الهيكل إلى هابط",
    }];
    const actions = evaluatePosition(
      basePosition(),
      ctx(candle(103, 104, 99.5, 102), { invalidation, structureState: "downtrend" }),
    );
    expect(actions[0].kind).toBe("invalidate");
    expect((actions[0] as { reason: string }).reason).toContain("تغيّر جوهري قبل التنفيذ");
  });
});

describe("the ambiguous bar — stop and target in the same candle", () => {
  const openPos = basePosition({ status: "open", openQuantity: 10, averageEntry: 100, openedAt: NOW });

  it("takes the STOP, because OHLC cannot tell us which came first", () => {
    const both = candle(100, 115, 94, 100); // reaches target 1 (110) AND stop (95)
    const actions = evaluatePosition(openPos, ctx(both));
    expect(actions[0].kind).toBe("hit_stop");
    expect(actions.some((a) => a.kind === "hit_target")).toBe(false);
  });

  it("explains why, so the assumption is visible rather than hidden", () => {
    const actions = evaluatePosition(openPos, ctx(candle(100, 115, 94, 100)));
    const alert = actions.find((a) => a.kind === "alert") as { reason: string };
    expect(alert.reason).toContain("اختراع ربح غير موجود");
  });

  it("takes the target when the stop was NOT touched", () => {
    const actions = evaluatePosition(openPos, ctx(candle(100, 115, 99, 112)));
    expect(actions.some((a) => a.kind === "hit_target")).toBe(true);
    expect(actions.some((a) => a.kind === "hit_stop")).toBe(false);
  });
});

describe("staged exit and stop management", () => {
  const openPos = basePosition({ status: "open", openQuantity: 10, averageEntry: 100, openedAt: NOW });

  it("moves the stop to breakeven at target 1 — the remainder can no longer lose", () => {
    const actions = evaluatePosition(openPos, ctx(candle(100, 112, 99, 111)));
    const move = actions.find((a) => a.kind === "move_stop") as { to: number; reason: string };
    expect(move).toBeDefined();
    expect(move.to).toBe(100);
    expect(move.reason).toContain("التعادل");
  });

  it("closes only the planned fraction at each target", () => {
    const actions = evaluatePosition(openPos, ctx(candle(100, 112, 99, 111)));
    const hit = actions.find((a) => a.kind === "hit_target") as { quantity: number };
    expect(hit.quantity).toBeCloseTo(5, 9); // 50% of 10
  });

  it("starts trailing only AFTER target 2", () => {
    const afterOne = basePosition({
      status: "open", openQuantity: 5, averageEntry: 100, openedAt: NOW,
      targetsHit: [1], stopMovedToBreakeven: true, currentStop: 100,
    });
    const noTrail = evaluatePosition(afterOne, ctx(candle(112, 115, 111, 114)));
    expect(noTrail.some((a) => a.kind === "move_stop" && a.reason.includes("متتبّع"))).toBe(false);

    const afterTwo = { ...afterOne, targetsHit: [1, 2] as (1 | 2 | 3)[], openQuantity: 2 };
    const trail = evaluatePosition(afterTwo, ctx(candle(122, 125, 121, 124), { atr: 2 }));
    const move = trail.find((a) => a.kind === "move_stop") as { to: number };
    expect(move).toBeDefined();
    expect(move.to).toBeCloseTo(124 - 2 * 1.5, 9);
  });

  it("the trailing stop only ever tightens, never loosens", () => {
    const pos = basePosition({
      status: "open", openQuantity: 2, averageEntry: 100, openedAt: NOW,
      targetsHit: [1, 2], currentStop: 121, trailingActive: true,
    });
    // A pullback would put the trail at 118 — below the current 121.
    const actions = evaluatePosition(pos, ctx(candle(122, 122, 120, 121), { atr: 2 }));
    expect(actions.some((a) => a.kind === "move_stop")).toBe(false);
  });

  it("flows turning against the position is an ALERT, not an exit", () => {
    const actions = evaluatePosition(openPos, ctx(candle(100, 105, 99, 103), { flowsAgainst: true }));
    expect(actions.some((a) => a.kind === "hit_stop")).toBe(false);
    const alert = actions.find((a) => a.kind === "alert") as { reason: string };
    expect(alert.reason).toContain("تنبيه فقط");
  });
});

describe("invalidation conditions are evaluated literally", () => {
  const openPos = basePosition({ status: "open", openQuantity: 10, averageEntry: 100, openedAt: NOW });

  it("fires on a numeric stage-score condition", () => {
    const invalidation: InvalidationCondition[] = [{
      id: "technical_reversal", subject: "stage_score", stage: "technical",
      operator: "lt", value: -30, arabic: "انقلب التحليل الفني",
    }];
    const actions = evaluatePosition(openPos, ctx(candle(100, 105, 99, 103), {
      invalidation, stageScores: { technical: -50 },
    }));
    expect(actions[0].kind).toBe("hit_stop");
    expect((actions[0] as { reason: string }).reason).toBe("invalidated");
  });

  it("fires on a string condition", () => {
    const invalidation: InvalidationCondition[] = [{
      id: "structure_flip", subject: "structure_state", operator: "eq", value: "downtrend",
      arabic: "انقلب الهيكل",
    }];
    const actions = evaluatePosition(openPos, ctx(candle(100, 105, 99, 103), {
      invalidation, structureState: "downtrend",
    }));
    expect(actions[0].kind).toBe("hit_stop");
  });

  it("NEVER fires on an unknown input — ignorance is not a trigger", () => {
    const invalidation: InvalidationCondition[] = [{
      id: "btc_breakdown", subject: "btc_daily_score", operator: "lte", value: -45,
      arabic: "انهيار البيتكوين",
    }];
    const actions = evaluatePosition(openPos, ctx(candle(100, 105, 99, 103), {
      invalidation, btcDailyScore: null,
    }));
    expect(actions.some((a) => a.kind === "hit_stop")).toBe(false);
  });

  it("compares numbers and strings without coercing between them", () => {
    const { compare } = monitorTesting;
    expect(compare(5, "lt", 10)).toBe(true);
    expect(compare(10, "lte", 10)).toBe(true);
    expect(compare("uptrend", "eq", "uptrend")).toBe(true);
    expect(compare("uptrend", "neq", "downtrend")).toBe(true);
    // A string against a number is never "less than"; it is meaningless.
    expect(compare("uptrend", "lt", 5)).toBe(false);
  });
});

// ── the broker ───────────────────────────────────────────────────────────────

describe("execution happens at the NEXT candle's open", () => {
  it("fills the entry at the open, not at the zone price", () => {
    const pos = basePosition();
    const nextBar = candle(102, 103, 101, 102.5);
    const r = applyActions(pos, [{ kind: "fill_entry", price: 100, quantity: 10, reason: "وصل" }], execCtx(nextBar));
    // The reference is the OPEN (102), not the planned entry mid (100).
    expect(r.position.fills[0].referencePrice).toBe(102);
    expect(r.position.averageEntry).toBeGreaterThan(102);
    expect(r.position.status).toBe("open");
  });

  it("fills a stop AT the stop when the bar traded through it normally", () => {
    const pos = basePosition({ status: "open", openQuantity: 10, averageEntry: 100, openedAt: NOW });
    const bar = candle(98, 99, 94, 96); // opened above the 95 stop
    const r = applyActions(pos, [{ kind: "hit_stop", price: 95, quantity: 10, reason: "stop_loss" }], execCtx(bar));
    expect(r.position.fills[0].referencePrice).toBe(95);
  });

  it("fills at the OPEN when the bar GAPPED through the stop — that price never traded", () => {
    const pos = basePosition({ status: "open", openQuantity: 10, averageEntry: 100, openedAt: NOW });
    const gap = candle(90, 91, 88, 89); // opened far below the 95 stop
    const r = applyActions(pos, [{ kind: "hit_stop", price: 95, quantity: 10, reason: "stop_loss" }], execCtx(gap));
    expect(r.position.fills[0].referencePrice).toBe(90);
    expect(r.events[0].arabic).toContain("لم يُتداول");
    // And the loss is genuinely worse than the planned risk.
    expect(r.position.realizedPnl).toBeLessThan(-10 * 5);
  });

  it("fills a target at the OPEN when the bar gapped past it", () => {
    const pos = basePosition({ status: "open", openQuantity: 10, averageEntry: 100, openedAt: NOW });
    const gap = candle(115, 118, 114, 117); // opened above the 110 target
    const r = applyActions(pos, [{ kind: "hit_target", target: 1, price: 110, quantity: 5 }], execCtx(gap));
    expect(r.position.fills[0].referencePrice).toBe(115);
  });

  it("subtracts fees and slippage from the realized result", () => {
    const pos = basePosition({ status: "open", openQuantity: 10, averageEntry: 100, openedAt: NOW });
    const bar = candle(110, 112, 109, 111);
    const r = applyActions(pos, [{ kind: "hit_target", target: 1, price: 110, quantity: 5 }], execCtx(bar));
    const gross = (110 - 100) * 5;
    expect(r.position.realizedPnl).toBeLessThan(gross);
  });

  it("records the result in R once closed", () => {
    const pos = basePosition({ status: "open", openQuantity: 10, averageEntry: 100, openedAt: NOW });
    const r = applyActions(pos, [{ kind: "hit_stop", price: 95, quantity: 10, reason: "stop_loss" }], execCtx(candle(98, 99, 94, 96)));
    expect(r.position.status).toBe("closed");
    // Planned risk 50; a full stop should land near -1R.
    expect(r.position.realizedR).toBeLessThan(-0.9);
    expect(r.position.realizedR).toBeGreaterThan(-1.3);
  });

  it("emits an Arabic event for every action", () => {
    const pos = basePosition();
    const r = applyActions(pos, [{ kind: "fill_entry", price: 100, quantity: 10, reason: "وصل" }], execCtx(candle(102, 103, 101, 102)));
    expect(r.events).toHaveLength(1);
    expect(r.events[0].arabic.length).toBeGreaterThan(30);
    expect(r.events[0].candleTime).toBe(NOW);
  });
});

describe("excursion tracking", () => {
  it("records the best and worst the trade ever looked, in R", () => {
    const pos = basePosition({ status: "open", openQuantity: 10, averageEntry: 100, openedAt: NOW });
    const e = updateExcursions(pos, candle(100, 115, 92, 105), 5);
    expect(e.maxFavorableR).toBeCloseTo(3, 6);  // (115-100)/5
    expect(e.maxAdverseR).toBeCloseTo(-1.6, 6); // (92-100)/5
  });

  it("only ever widens — a calm bar does not erase an earlier excursion", () => {
    const pos = basePosition({
      status: "open", openQuantity: 10, averageEntry: 100, openedAt: NOW,
      maxFavorableR: 3, maxAdverseR: -1.6,
    });
    const e = updateExcursions(pos, candle(100, 101, 99, 100), 5);
    expect(e.maxFavorableR).toBe(3);
    expect(e.maxAdverseR).toBe(-1.6);
  });

  it("the close summary calls out a winner that turned into a loser", () => {
    const pos = basePosition({
      status: "closed", exitReason: "stop_loss", realizedR: -1, realizedPnl: -50,
      maxFavorableR: 2.4, maxAdverseR: -1, barsHeld: 30,
      fills: [{ at: NOW, candleTime: NOW, side: "sell", quantity: 10, referencePrice: 95,
        price: 95, slippage: 0.1, slippageBps: 10, fee: 1, feeBps: 10, notional: 950, reason: "" }],
    });
    expect(closeSummary(pos)).toContain("الخلل في قواعد الخروج");
  });

  it("the close summary reports every field the spec asks for", () => {
    const pos = basePosition({
      status: "closed", exitReason: "target_2", realizedR: 2.1, realizedPnl: 105,
      maxFavorableR: 2.5, maxAdverseR: -0.4, barsHeld: 18, fills: [],
    });
    const s = closeSummary(pos);
    for (const needle of ["سبب الخروج", "أقصى ربح عائم", "أقصى خسارة عائمة", "مدة الاحتفاظ", "الرسوم"]) {
      expect(s).toContain(needle);
    }
  });
});

// ── risk ─────────────────────────────────────────────────────────────────────

const limits: RiskLimits = {
  riskPerTradePct: 1, maxOpenPositions: 6, maxCorrelatedPositions: 3,
  correlationThreshold: 0.8, dailyLossHaltPct: 3, dailyHaltHours: 24, maxDrawdownHaltPct: 15,
};

const snapshot = (over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot => ({
  at: NOW, equity: 10_000, cash: 10_000, openPositions: 0, exposureNotional: 0,
  peakEquity: 10_000, drawdownPct: 0, dayStartEquity: 10_000, dayPnlPct: 0, ...over,
});

describe("position sizing", () => {
  it("risks exactly the configured fraction of equity", () => {
    const r = positionSizeFor(10_000, 1, 100, 95)!;
    expect(r.riskAmount).toBe(100);
    expect(r.size * r.riskPerUnit).toBeCloseTo(100, 9);
  });

  it("a wider stop automatically buys fewer units", () => {
    const tight = positionSizeFor(10_000, 1, 100, 99)!;
    const wide = positionSizeFor(10_000, 1, 100, 90)!;
    expect(wide.size).toBeLessThan(tight.size);
    // But both risk the same money — that is the whole point.
    expect(wide.riskAmount).toBe(tight.riskAmount);
  });

  it("refuses rather than dividing by zero when the stop equals the entry", () => {
    expect(positionSizeFor(10_000, 1, 100, 100)).toBeNull();
  });
});

describe("risk limits", () => {
  const openPos = (symbol: string, direction: "long" | "short" = "long") =>
    basePosition({ id: symbol, symbol, direction, status: "open", openQuantity: 1, averageEntry: 100 });

  it("blocks at the position cap", () => {
    const r = checkRisk({
      snapshot: snapshot(), openPositions: Array.from({ length: 6 }, (_, i) => openPos(`S${i}`)),
      candidate: { symbol: "NEW", direction: "long" }, correlations: {},
      activeBreakers: [], limits, now: NOW,
    });
    expect(r.allowed).toBe(false);
    expect(r.blockers[0].id).toBe("max_positions");
  });

  it("blocks three correlated positions in the SAME direction", () => {
    const r = checkRisk({
      snapshot: snapshot(),
      openPositions: [openPos("ETHUSDT"), openPos("SOLUSDT"), openPos("AVAXUSDT")],
      candidate: { symbol: "MATICUSDT", direction: "long" },
      correlations: { ETHUSDT: 0.92, SOLUSDT: 0.88, AVAXUSDT: 0.85 },
      activeBreakers: [], limits, now: NOW,
    });
    expect(r.allowed).toBe(false);
    expect(r.blockers[0].arabic).toContain("مركز واحد يخاطر بمجموعها");
  });

  it("does NOT count correlated positions in the opposite direction", () => {
    const r = checkRisk({
      snapshot: snapshot(),
      openPositions: [openPos("ETHUSDT", "short"), openPos("SOLUSDT", "short"), openPos("AVAXUSDT", "short")],
      candidate: { symbol: "MATICUSDT", direction: "long" },
      correlations: { ETHUSDT: 0.92, SOLUSDT: 0.88, AVAXUSDT: 0.85 },
      activeBreakers: [], limits, now: NOW,
    });
    expect(r.correlatedCount).toBe(0);
    expect(r.allowed).toBe(true);
  });

  it("does not count weakly correlated positions", () => {
    const r = checkRisk({
      snapshot: snapshot(),
      openPositions: [openPos("ETHUSDT"), openPos("XMRUSDT"), openPos("LTCUSDT")],
      candidate: { symbol: "NEW", direction: "long" },
      correlations: { ETHUSDT: 0.5, XMRUSDT: 0.3, LTCUSDT: 0.2 },
      activeBreakers: [], limits, now: NOW,
    });
    expect(r.allowed).toBe(true);
  });
});

describe("circuit breakers", () => {
  it("trips the daily-loss breaker at the threshold", () => {
    const tripped = evaluateBreakers(snapshot({ dayPnlPct: -3.1 }), limits, [], NOW);
    expect(tripped).toHaveLength(1);
    expect(tripped[0].kind).toBe("daily_loss");
    expect(tripped[0].requiresManualReset).toBe(false);
    expect(tripped[0].resumesAt).toBe(NOW + 24 * HOUR);
  });

  it("the daily breaker RESUMES itself after the cooldown", () => {
    const [breaker] = evaluateBreakers(snapshot({ dayPnlPct: -3.1 }), limits, [], NOW);
    expect(activeBreakers([breaker], NOW + HOUR)).toHaveLength(1);
    expect(activeBreakers([breaker], NOW + 25 * HOUR)).toHaveLength(0);
  });

  it("the drawdown breaker NEVER resumes itself — it needs a human", () => {
    const [breaker] = evaluateBreakers(snapshot({ drawdownPct: 15.5 }), limits, [], NOW);
    expect(breaker.kind).toBe("max_drawdown");
    expect(breaker.requiresManualReset).toBe(true);
    expect(breaker.resumesAt).toBeNull();
    // Still active a year later.
    expect(activeBreakers([breaker], NOW + 365 * 24 * HOUR)).toHaveLength(1);
    expect(breaker.arabic).toContain("تشغيل يدوي");
  });

  it("does not re-trip a breaker that is already active", () => {
    const [breaker] = evaluateBreakers(snapshot({ dayPnlPct: -3.1 }), limits, [], NOW);
    expect(evaluateBreakers(snapshot({ dayPnlPct: -5 }), limits, [breaker], NOW + HOUR)).toHaveLength(0);
  });

  it("an active breaker blocks every new position", () => {
    const [breaker] = evaluateBreakers(snapshot({ drawdownPct: 20 }), limits, [], NOW);
    const r = checkRisk({
      snapshot: snapshot(), openPositions: [], candidate: { symbol: "X", direction: "long" },
      correlations: {}, activeBreakers: [breaker], limits, now: NOW,
    });
    expect(r.allowed).toBe(false);
    expect(r.blockers[0].id).toContain("circuit");
  });
});

describe("portfolio snapshot", () => {
  it("peak equity only ever rises, so drawdown means 'from the high-water mark'", () => {
    let s = snapshot();
    s = updateSnapshot(s, 12_000, [], NOW);
    expect(s.peakEquity).toBe(12_000);
    s = updateSnapshot(s, 9_000, [], NOW + HOUR);
    expect(s.peakEquity).toBe(12_000);
    expect(s.drawdownPct).toBeCloseTo(25, 6);
  });

  it("computes the day's P&L against the day's own starting equity", () => {
    const s = updateSnapshot(snapshot({ dayStartEquity: 10_000 }), 9_700, [], NOW);
    expect(s.dayPnlPct).toBeCloseTo(-3, 6);
  });
});

// ── live trading is off ──────────────────────────────────────────────────────

describe("the live layer refuses to trade", () => {
  const env = (o: Record<string, string> = {}) => o as unknown as NodeJS.ProcessEnv;

  it("is disabled by default", () => {
    const b = new LiveBroker(getConfig(env()));
    expect(b.enabled).toBe(false);
    expect(b.statusAr()).toContain("معطّل");
  });

  it("stays disabled with a key but no explicit enable", () => {
    expect(new LiveBroker(getConfig(env({ LIVE_EXCHANGE_API_KEY: "k", LIVE_EXCHANGE_API_SECRET: "s" }))).enabled).toBe(false);
  });

  it("throws rather than silently doing nothing", async () => {
    const b = new LiveBroker(getConfig(env()));
    await expect(b.placeEntry({
      symbol: "BTCUSDT", side: "buy", kind: "market", quantity: 1, clientOrderId: "x",
    })).rejects.toThrow(LiveTradingDisabledError);
  });

  it("STILL refuses when enabled and keyed, until withdrawal permission is acknowledged", async () => {
    const b = new LiveBroker(getConfig(env({
      LIVE_TRADING_ENABLED: "true", LIVE_EXCHANGE_API_KEY: "k", LIVE_EXCHANGE_API_SECRET: "s",
    })));
    await expect(b.placeEntry({
      symbol: "BTCUSDT", side: "buy", kind: "market", quantity: 1, clientOrderId: "x",
    })).rejects.toThrow(/صلاحية سحب/);
  });

  it("the kill switch overrides everything", async () => {
    const b = new LiveBroker(getConfig(env({
      LIVE_TRADING_ENABLED: "true", LIVE_EXCHANGE_API_KEY: "k", LIVE_EXCHANGE_API_SECRET: "s",
    })));
    b.acknowledgeWithdrawalPermissionDisabled();
    b.engageKillSwitch("تدخّل يدوي");
    expect(b.enabled).toBe(false);
    await expect(b.placeEntry({
      symbol: "BTCUSDT", side: "buy", kind: "market", quantity: 1, clientOrderId: "x",
    })).rejects.toThrow(/الإيقاف الفوري/);
  });

  it("preflight lists every gate and why it is or is not satisfied", () => {
    const report = new LiveBroker(getConfig(env())).preflight();
    expect(report.ready).toBe(false);
    expect(report.checks).toHaveLength(4);
    for (const c of report.checks) expect(c.arabic.length).toBeGreaterThan(5);
  });

  it("even a fully-configured broker refuses, because the order path is deliberately unbuilt", async () => {
    const b = new LiveBroker(getConfig(env({
      LIVE_TRADING_ENABLED: "true", LIVE_EXCHANGE_API_KEY: "k", LIVE_EXCHANGE_API_SECRET: "s",
    })));
    b.acknowledgeWithdrawalPermissionDisabled();
    expect(b.preflight().ready).toBe(true);
    await expect(b.placeEntry({
      symbol: "BTCUSDT", side: "buy", kind: "market", quantity: 1, clientOrderId: "x",
    })).rejects.toThrow(/لم يُنفَّذ بعد عمداً/);
  });
});

// ── storage ──────────────────────────────────────────────────────────────────

describe("execution storage", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-"));
    db = openDb(path.join(dir, "t.db"));
    db.prepare(
      `INSERT INTO recommendations (id, symbol, direction, setup, regime, timeframe, exchange,
        generated_at, as_of_candle, entry_low, entry_high, entry_mid, stop, stop_basis,
        targets_json, risk_reward, position_size, position_notional, risk_amount, risk_percent,
        confidence, final_score, confidence_components_json, invalidation_json, expires_at,
        report, integrity_hash, pipeline_json)
       VALUES ('r1','BTCUSDT','long','trend_continuation','trending_up','1h','binance',
        ?,?,99,101,100,95,'x','[]',2,10,1000,50,1,70,65,'[]','[]',?,'x','x','{}')`,
    ).run(NOW, NOW, NOW + 12 * HOUR);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a position through the database", () => {
    const repo = new PositionRepo(db);
    const pos = basePosition();
    repo.save(pos);
    const back = repo.get("p1")!;
    expect(back.symbol).toBe("BTCUSDT");
    expect(back.plannedTargets).toHaveLength(3);
    expect(back.status).toBe("pending");
  });

  it("updates a position in place while its audit trail stays append-only", () => {
    const repo = new PositionRepo(db);
    repo.save(basePosition());
    repo.save(basePosition({ status: "open", openQuantity: 10, averageEntry: 100.5, currentStop: 100 }));
    const back = repo.get("p1")!;
    expect(back.status).toBe("open");
    expect(back.currentStop).toBe(100);
    expect(repo.live()).toHaveLength(1);
  });

  it("separates live from closed positions", () => {
    const repo = new PositionRepo(db);
    repo.save(basePosition({ status: "closed", closedAt: NOW, exitReason: "target_1", realizedR: 1.7 }));
    expect(repo.live()).toHaveLength(0);
    expect(repo.closed()).toHaveLength(1);
    expect(repo.closed()[0].realizedR).toBe(1.7);
  });

  it("the equity curve is append-only and tracks the peak", () => {
    const repo = new EquityRepo(db);
    repo.record(snapshot({ at: NOW, equity: 10_000 }), 50_000);
    repo.record(snapshot({ at: NOW + HOUR, equity: 11_000, peakEquity: 11_000 }), 51_000);
    expect(repo.latest()!.equity).toBe(11_000);
    expect(repo.curve(NOW - 1, NOW + 2 * HOUR)).toHaveLength(2);
    expect(() => db.prepare("DELETE FROM equity_curve").run()).toThrow(/append-only/);
  });

  it("stores Bitcoin's price alongside, so buy-and-hold stays comparable later", () => {
    const repo = new EquityRepo(db);
    repo.record(snapshot(), 50_000);
    expect(repo.latest()!.btcPrice).toBe(50_000);
  });

  it("records breakers and distinguishes cleared from active", () => {
    const repo = new BreakerRepo(db);
    const [breaker] = evaluateBreakers(snapshot({ drawdownPct: 20 }), limits, [], NOW);
    repo.trip(breaker);
    expect(repo.uncleared()).toHaveLength(1);
    expect(repo.clear("max_drawdown", "operator")).toBe(1);
    expect(repo.uncleared()).toHaveLength(0);
    expect(repo.history()[0].clearedBy).toBe("operator");
  });
});
