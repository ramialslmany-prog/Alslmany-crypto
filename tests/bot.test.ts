import type { Candle } from "../src/lib/market/types";
import type { Recommendation } from "../src/lib/engine/recommendation";
import { PaperBroker, rMultipleOf } from "../src/lib/bot/broker";
import { canOpen, closePosition, considerEntries, manage, openPosition, stepPosition, type Quote } from "../src/lib/bot/engine";
import { computeStats } from "../src/lib/bot/ledger";
import { backtest, resample } from "../src/lib/bot/backtest";
import { DEFAULT_BOT_CONFIG, emptyState, type Position } from "../src/lib/bot/types";
import { describe, equal, isNull, near, ok } from "./_harness";

const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c, v: 100 });

/** A zero-slippage broker, so arithmetic assertions are exact. */
const clean = new PaperBroker(0);

function makeRec(over: Partial<Recommendation> = {}): Recommendation {
  return {
    symbol: "TEST", name: "Test", nameAr: "اختبار", sector: "smart-contract", tier: 1,
    generatedAt: 0, price: 100, verdict: "enter", grade: "A", score: 75, confidence: 70,
    horizon: "swing",
    plan: {
      entryLow: 99, entryHigh: 100, reference: 100, stop: 90, stopDistancePct: 10,
      targets: [
        { price: 110, rMultiple: 1, allocationPct: 40, basis: "level:3" },
        { price: 120, rMultiple: 2, allocationPct: 35, basis: "level:2" },
        { price: 140, rMultiple: 4, allocationPct: 25, basis: "extension:4R" },
      ],
      rewardRisk: 2.05, positionSizePct: 10, riskPerTradePct: 1,
      invalidationKey: "invalidation.structure", invalidationPrice: 90,
    },
    timeframes: [], bullish: [], bearish: [], scenarios: [], warnings: [],
    // Only the fields the bot actually reads are stubbed here.
    regime: { label: "bull" } as unknown as Recommendation["regime"],
    structure: {} as unknown as Recommendation["structure"],
    dataSource: "binance", degraded: false,
    ...over,
  } as Recommendation;
}

async function openTest(over: Partial<Recommendation> = {}): Promise<Position> {
  const result = await openPosition(makeRec(over), DEFAULT_BOT_CONFIG, clean, 0);
  return result!.position;
}

const quote = (b: Candle, atr = 5): Quote => ({ symbol: "TEST", bar: b, atr });

export async function run() {
  await describe("R accounting", () => {
    near(rMultipleOf(100, 90, 110), 1, 1e-9, "entry 100, stop 90, price 110 → +1R");
    near(rMultipleOf(100, 90, 120), 2, 1e-9, "→ +2R at 120");
    near(rMultipleOf(100, 90, 90), -1, 1e-9, "→ −1R at the stop");
    near(rMultipleOf(100, 90, 95), -0.5, 1e-9, "→ −0.5R halfway to the stop");
    equal(rMultipleOf(100, 100, 120), 0, "a zero-width stop yields no R rather than infinity");
    equal(rMultipleOf(100, 110, 120), 0, "an inverted stop yields no R");
  });

  await describe("paper broker charges slippage against us", () => {
    const costly = new PaperBroker(50); // 0.5%
    return (async () => {
      const fill = await costly.buy("TEST", 100, 10, 0);
      ok(fill.price > 100, "a buy fills above the quote", fill.price.toFixed(4));
      const position = await openTest();
      const exit = await costly.sell(position, 110, 1, "target", 1);
      ok(exit.price < 110, "a sell fills below the quote", exit.price.toFixed(4));
    })();
  });

  await describe("entry", async () => {
    const position = await openTest();
    equal(position.entry, 100, "fills at the quote with a clean broker");
    equal(position.initialStop, 90, "stop anchored to the fill");
    equal(position.remaining, 1, "opens at full size");
    equal(position.status, "open", "is open");
    ok(position.thesis.bullish !== undefined, "freezes the thesis at entry");

    // With slippage the stop must follow the fill, keeping risk honest.
    const slipped = (await openPosition(makeRec(), DEFAULT_BOT_CONFIG, new PaperBroker(100), 0))!.position;
    ok(slipped.entry > 100, "a slipped fill is above the quote");
    near(slipped.entry - slipped.initialStop, 10, 1e-6, "and the stop distance is preserved, so 1R still means 1R");
  });

  await describe("exits — the stop is taken first when a bar covers both", async () => {
    const position = await openTest();
    // This bar reaches the first target AND the stop.
    const result = await stepPosition(position, quote(bar(1, 100, 115, 85, 95)), DEFAULT_BOT_CONFIG, clean);
    equal(result.position.status, "closed", "the position closes");
    equal(result.position.exitReason, "stop", "as a stop, not a target");
    near(result.position.realizedR, -1, 1e-6, "taking the full −1R");
  });

  await describe("exits — staged take-profits fire in order", async () => {
    let p = await openTest();
    let r = await stepPosition(p, quote(bar(1, 100, 111, 99, 110)), DEFAULT_BOT_CONFIG, clean);
    p = r.position;
    equal(p.targetsHit, 1, "first target fills");
    near(p.remaining, 0.6, 1e-6, "releasing 40% of the position");
    near(p.realizedR, 0.4, 1e-6, "banking 0.4R — the tranche, not the whole trade");
    equal(p.stop, 100, "and the stop moves to breakeven");

    r = await stepPosition(p, quote(bar(2, 110, 121, 105, 120)), DEFAULT_BOT_CONFIG, clean);
    p = r.position;
    equal(p.targetsHit, 2, "second target fills");
    near(p.remaining, 0.25, 1e-6, "leaving the runner");
    near(p.realizedR, 0.4 + 0.35 * 2, 1e-6, "R accumulates weighted by tranche size");

    r = await stepPosition(p, quote(bar(3, 120, 141, 118, 140)), DEFAULT_BOT_CONFIG, clean);
    p = r.position;
    equal(p.status, "closed", "the final target closes the position");
    equal(p.exitReason, "target", "recorded as a target exit");
    near(p.realizedR, 0.4 + 0.7 + 0.25 * 4, 1e-6, "total R reconciles across all three tranches");
    near(p.remaining, 0, 1e-9, "nothing is left held");
  });

  await describe("stop discipline — a stop may only ever move in our favour", async () => {
    let p = await openTest();
    // Hit target 1 → breakeven.
    p = (await stepPosition(p, quote(bar(1, 100, 111, 99, 110)), DEFAULT_BOT_CONFIG, clean)).position;
    equal(p.stop, 100, "breakeven after the first target");

    // A deep pullback that does not reach the stop must not widen it.
    p = (await stepPosition(p, quote(bar(2, 110, 110, 101, 102)), DEFAULT_BOT_CONFIG, clean)).position;
    equal(p.stop, 100, "a pullback does not give the trade more room");

    // Hit target 2 → trailing begins.
    p = (await stepPosition(p, quote(bar(3, 102, 121, 101, 120)), DEFAULT_BOT_CONFIG, clean)).position;
    const afterTrail = p.stop;
    ok(afterTrail >= 100, "the trail never drops below breakeven", `${afterTrail}`);

    // A lower high must not pull the trailing stop back down.
    p = (await stepPosition(p, quote(bar(4, 120, 121, 112, 113)), DEFAULT_BOT_CONFIG, clean)).position;
    ok(p.stop >= afterTrail, "a lower high cannot lower the stop", `${p.stop}`);

    // A new high raises it.
    p = (await stepPosition(p, quote(bar(5, 113, 135, 112, 134)), DEFAULT_BOT_CONFIG, clean)).position;
    ok(p.stop > afterTrail, "a new high raises the trail", `${p.stop}`);
  });

  await describe("exits — a stale thesis is cut", async () => {
    const p = await openTest();
    const late = DEFAULT_BOT_CONFIG.maxHoldHours * 3_600_000 + 1000;
    // Went nowhere for the full hold window.
    const r = await stepPosition(p, quote(bar(late, 100, 102, 99, 101)), DEFAULT_BOT_CONFIG, clean);
    equal(r.position.status, "closed", "the position is closed");
    equal(r.position.exitReason, "time", "for time, not for a stop");

    // A trade that IS working is left alone at the same age.
    const working = await openTest();
    const r2 = await stepPosition(working, quote(bar(late, 100, 108, 99, 107)), DEFAULT_BOT_CONFIG, clean);
    equal(r2.position.status, "open", "a position in profit is not cut merely for being old");
  });

  await describe("portfolio guards", async () => {
    const empty = emptyState(0);
    ok(canOpen(empty, makeRec()).ok, "a clean grade-A setup is allowed");
    equal(canOpen(empty, makeRec({ verdict: "watch" })).ok, false, "a watch-list call is refused");
    equal(canOpen(empty, makeRec({ grade: "C" })).ok, false, "a grade C is refused");
    equal(canOpen(empty, makeRec({ confidence: 20 })).ok, false, "low confidence is refused");
    equal(canOpen(empty, makeRec({ degraded: true })).ok, false, "demo data is refused — the bot never trades synthetic prices");

    const thin = makeRec();
    thin.plan!.rewardRisk = 1.1;
    equal(canOpen(empty, thin).ok, false, "thin reward-to-risk is refused");

    const full = { ...empty, positions: Array.from({ length: DEFAULT_BOT_CONFIG.maxPositions }, (_, i) => ({ ...({} as Position), symbol: `S${i}`, sector: "defi", status: "open" })) as Position[] };
    equal(canOpen(full, makeRec()).ok, false, "a full book is refused");

    const concentrated = {
      ...empty,
      positions: [
        { ...({} as Position), symbol: "A", sector: "smart-contract", status: "open" },
        { ...({} as Position), symbol: "B", sector: "smart-contract", status: "open" },
      ] as Position[],
    };
    equal(canOpen(concentrated, makeRec()).ok, false, "sector concentration is refused");

    const held = { ...empty, positions: [{ ...({} as Position), symbol: "TEST", sector: "defi", status: "open" }] as Position[] };
    equal(canOpen(held, makeRec()).ok, false, "the same symbol is never doubled up");
  });

  await describe("considerEntries respects guards as it fills", async () => {
    const candidates = ["A", "B", "C", "D", "E", "F", "G"].map((s, i) =>
      makeRec({ symbol: s, sector: (i % 2 ? "defi" : "infrastructure") as Recommendation["sector"] }),
    );
    const result = await considerEntries(emptyState(0), candidates, DEFAULT_BOT_CONFIG, clean, 0);
    ok(result.opened.length <= DEFAULT_BOT_CONFIG.maxPositions, "never exceeds the position cap", `${result.opened.length}`);
    const perSector = new Map<string, number>();
    for (const p of result.opened) perSector.set(p.sector, (perSector.get(p.sector) ?? 0) + 1);
    ok([...perSector.values()].every((n) => n <= DEFAULT_BOT_CONFIG.maxPerSector), "never exceeds the sector cap");
    ok(result.refused.length > 0, "and reports what it refused, with reasons");
  });

  await describe("manage", async () => {
    const position = await openTest();
    const state = { ...emptyState(0), positions: [position] };

    const untouched = await manage(state, [], DEFAULT_BOT_CONFIG, clean);
    equal(untouched.positions.length, 1, "a symbol with no fresh bar is left alone, not guessed at");

    const stopped = await manage(state, [quote(bar(1, 100, 101, 85, 88))], DEFAULT_BOT_CONFIG, clean);
    equal(stopped.positions.length, 0, "a stopped position leaves the book");
    equal(stopped.closed.length, 1, "and lands in history");
    equal(stopped.equityR.length, 1, "extending the equity curve");
    near(stopped.equityR[0].cumulative, -1, 1e-6, "by −1R");
  });

  await describe("ledger statistics", () => {
    const trade = (r: number, at: number, reason: Position["exitReason"] = "target"): Position =>
      ({ ...({} as Position), realizedR: r, openedAt: at, closedAt: at + 3_600_000, exitReason: reason });

    const stats = computeStats([trade(2, 1), trade(-1, 2), trade(3, 3), trade(-1, 4), trade(-1, 5)]);
    equal(stats.trades, 5, "counts every trade");
    equal(stats.wins, 2, "two wins");
    equal(stats.losses, 3, "three losses");
    near(stats.winRate, 40, 1e-6, "a 40% win rate is reported as 40%, not rounded up");
    near(stats.totalR, 2, 1e-6, "total R");
    near(stats.expectancyR, 0.4, 1e-6, "expectancy is positive despite losing more often than winning");
    near(stats.profitFactor!, 5 / 3, 1e-3, "profit factor");
    near(stats.averageWinR, 2.5, 1e-6, "average win");
    near(stats.averageLossR, -1, 1e-6, "average loss");
    equal(stats.longestLossStreak, 2, "longest losing streak");
    near(stats.bestR, 3, 1e-6, "best trade");
    near(stats.worstR, -1, 1e-6, "worst trade");

    // Drawdown: +2, +1, +4, +3, +2 → peak 4, trough 2.
    near(stats.maxDrawdownR, 2, 1e-6, "max drawdown is peak-to-trough of the R curve");

    const scratch = computeStats([trade(0.001, 1), trade(2, 2)]);
    equal(scratch.wins, 1, "a scratch trade is not counted as a win");
    equal(scratch.breakeven, 1, "it is reported as breakeven");

    const none = computeStats([]);
    equal(none.trades, 0, "an empty ledger reports zero, not NaN");
    isNull(none.profitFactor, "and no profit factor");
    equal(Number.isFinite(none.expectancyR), true, "expectancy stays finite");
  });

  await describe("closePosition", async () => {
    const p = await openTest();
    const { position } = await closePosition(p, 105, "regime", clean, 5);
    equal(position.status, "closed", "closes");
    equal(position.exitReason, "regime", "records why");
    near(position.realizedR, 0.5, 1e-6, "realising the R at that price");
  });

  await describe("resample", () => {
    const base = Array.from({ length: 12 }, (_, i) => bar(i * 3600_000, 10 + i, 20 + i, 5 + i, 15 + i));
    const four = resample(base, 4);
    equal(four.length, 3, "twelve 1h bars become three 4h bars");
    equal(four[0].o, base[0].o, "open comes from the first bar");
    equal(four[0].c, base[3].c, "close comes from the last");
    equal(four[0].h, Math.max(...base.slice(0, 4).map((b) => b.h)), "high is the max of the group");
    equal(four[0].l, Math.min(...base.slice(0, 4).map((b) => b.l)), "low is the min");
    near(four[0].v, base.slice(0, 4).reduce((s, b) => s + b.v, 0), 1e-9, "volume sums");
    equal(resample(base, 1).length, 12, "a factor of 1 is a no-op");
    // A partial trailing group is dropped rather than emitted half-formed.
    equal(resample(base, 5).length, 2, "an incomplete final group is dropped, never emitted partial");
  });

  await describe("backtest", async () => {
    // A long uptrend with pullbacks, so the strategy has something to trade.
    const trend: Candle[] = [];
    let p = 100;
    for (let i = 0; i < 700; i++) {
      const drift = 0.004 + Math.sin(i / 40) * 0.006;
      const next = p * (1 + drift);
      trend.push({ t: i * 3600_000, o: p, h: Math.max(p, next) * 1.006, l: Math.min(p, next) * 0.994, c: next, v: 1000 });
      p = next;
    }
    const entry = { symbol: "TEST", id: "test", name: "Test", nameAr: "اختبار", sector: "smart-contract" as const, tier: 1 as const };
    const result = await backtest({ entry, candles: trend, timeframe: "1h", broker: clean, stride: 4 });

    ok(result.barsTested > 0, "walks the series", `${result.barsTested} bars`);
    // Without this the suite once passed on a run that skipped every single
    // bar and reported "0 trades" as though that were a finding.
    ok(result.barsEvaluated > 0, "bars actually reach the engine", `${result.barsEvaluated} evaluated`);
    ok(result.stats.trades > 0, "and the strategy actually trades", `${result.stats.trades} trades`);
    ok(result.marketProxy, "states that it used a proxy for the market regime");
    ok(Number.isFinite(result.buyHoldPct), "reports buy-and-hold as the benchmark", `${result.buyHoldPct}%`);
    equal(result.stats.trades, result.trades.length, "stats and trades agree");
    ok(result.trades.every((t) => t.status === "closed"), "nothing is left open at the end");
    ok(result.trades.every((t) => (t.closedAt ?? 0) >= t.openedAt), "no trade closes before it opened");
    ok(result.trades.every((t) => t.openedAt >= trend[260].t), "no trade opens inside the warm-up window");
    equal(result.equityR.length, result.trades.length, "the equity curve has one point per trade");

    // No look-ahead: a decision taken on bar i must fill at the open of i+1,
    // never at the close it was decided on.
    const opens = new Set(trend.map((c) => c.o));
    ok(
      result.trades.every((t) => opens.has(t.entry)),
      "every entry fills at a bar open, never at the close it was decided on",
    );
    ok(
      result.trades.every((t) => {
        const idx = trend.findIndex((c) => c.t === t.openedAt);
        return idx > 0 && trend[idx].o === t.entry;
      }),
      "and specifically at the open of the bar after the decision",
    );

    // Determinism: the same history must produce the same result.
    const again = await backtest({ entry, candles: trend, timeframe: "1h", broker: clean, stride: 4 });
    equal(again.stats.trades, result.stats.trades, "the same history yields the same trade count");
    near(again.stats.totalR, result.stats.totalR, 1e-9, "and the same total R");

    // A tape that trends up, breaks down, then recovers — so the run has to
    // survive real drawdown rather than only riding one clean advance.
    const mixed: Candle[] = [];
    let q = 100;
    for (let i = 0; i < 1400; i++) {
      const phase = Math.floor(i / 350) % 2 === 0 ? 0.005 : -0.005;
      const drift = phase + Math.sin(i / 25) * 0.008;
      const next = q * (1 + drift);
      mixed.push({ t: i * 3600_000, o: q, h: Math.max(q, next) * 1.008, l: Math.min(q, next) * 0.992, c: next, v: 1000 });
      q = next;
    }
    const cycle = await backtest({ entry, candles: mixed, timeframe: "1h", broker: clean, stride: 4 });
    ok(cycle.stats.trades > 0, "trades through a full cycle", `${cycle.stats.trades} trades`);
    ok(cycle.stats.losses > 0, "and takes losses — a strategy that never loses is not being tested", `${cycle.stats.losses} losses`);
    near(
      cycle.stats.totalR,
      cycle.trades.reduce((s, t) => s + t.realizedR, 0),
      0.01,
      "reported total R reconciles with the individual trades",
    );
    ok(
      cycle.stats.maxDrawdownR >= 0,
      "drawdown is reported, not hidden",
      `${cycle.stats.maxDrawdownR}R`,
    );

    let threw = false;
    try {
      await backtest({ entry, candles: trend.slice(0, 100), timeframe: "1h", broker: clean });
    } catch { threw = true; }
    ok(threw, "refuses too little history rather than returning a meaningless result");

    ok(result.barsAnalysed > 0, "and bars produce real analysis", `${result.barsAnalysed} analysed`);

    // Long enough to iterate, far too short to resample 15m bars into the 4h
    // context the engine requires. That must raise, not report a quiet zero.
    let starved = false;
    let message = "";
    try {
      await backtest({ entry, candles: trend.slice(0, 400), timeframe: "15m", broker: clean, stride: 8 });
    } catch (err) {
      starved = true;
      message = err instanceof Error ? err.message : "";
    }
    ok(starved, "a run that can never produce analysis raises rather than reporting zero trades");
    ok(message.includes("no analysis"), "and the error says what is actually wrong", message.slice(0, 60));
  });
}
