/**
 * Backtest tests.
 *
 * The important ones here are not "does it produce a number" — they are the
 * traps: a look-ahead bar planted in the data, an execution that would be too
 * good, and a metric that would flatter the result. A backtester that passes
 * only the happy-path tests is exactly the kind that produces a beautiful
 * curve and loses money.
 */
import { describe, expect, it } from "vitest";
import {
  runBacktest, sliceUpTo, tickerFromCandles,
  type BacktestSettings, type BacktestSymbol, type BacktestTrade, type EquityPoint,
} from "@/core/backtest/engine";
import { buyAndHold, bySetup, computeMetrics, funnelVerdict } from "@/core/backtest/metrics";
import {
  allowedFromTraining, countFolds, holdoutBoundary, HOLDOUT_FRACTION,
} from "@/core/backtest/walkforward";
import { DEFAULT_COSTS } from "@/core/execution/fills";
import { DEFAULT_ELIGIBILITY } from "@/core/pipeline/stage1-eligibility";
import { backtestSymbol } from "./fixtures/market";
import type { Candle, SymbolInfo } from "@/core/types";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const START = Date.UTC(2024, 0, 1);

function candle(i: number, price: number, volume = 1_000): Candle {
  return {
    openTime: START + i * HOUR,
    closeTime: START + (i + 1) * HOUR,
    open: price, high: price * 1.01, low: price * 0.99, close: price,
    volume, quoteVolume: volume * price, trades: 100,
    takerBuyBase: volume * 0.5, takerBuyQuote: volume * price * 0.5,
  };
}

const series = (n: number, f: (i: number) => number): Candle[] =>
  Array.from({ length: n }, (_, i) => candle(i, f(i)));

// ── the look-ahead trap ──────────────────────────────────────────────────────

describe("point-in-time slicing", () => {
  const candles = series(10, (i) => 100 + i);

  it("never returns a bar whose close has not happened yet", () => {
    // Decision moment: exactly the close of bar 4.
    const at = candles[4].closeTime;
    const sliced = sliceUpTo(candles, at, 100);
    expect(sliced).toHaveLength(5);
    expect(sliced[sliced.length - 1].closeTime).toBe(at);
  });

  it("EXCLUDES a bar that closes one millisecond after the decision", () => {
    // This is the whole ballgame. A backtester that includes this bar knows
    // the future by one bar and will look brilliant.
    const at = candles[4].closeTime - 1;
    const sliced = sliceUpTo(candles, at, 100);
    expect(sliced).toHaveLength(4);
    expect(sliced.every((c) => c.closeTime <= at)).toBe(true);
  });

  it("honours the lookback bound from the RECENT end, not the old end", () => {
    const sliced = sliceUpTo(candles, candles[9].closeTime, 3);
    expect(sliced).toHaveLength(3);
    expect(sliced[2].close).toBe(109);
  });

  it("returns nothing before the first close", () => {
    expect(sliceUpTo(candles, START, 100)).toHaveLength(0);
  });
});

describe("ticker rebuilt from candles", () => {
  it("sums only the last 24 hours of quote volume", () => {
    const candles = series(48, () => 100);
    const t = tickerFromCandles("TESTUSDT", candles)!;
    // 24 one-hour bars at 1000 base × 100 price.
    expect(t.quoteVolume).toBeCloseTo(24 * 1000 * 100, 6);
  });

  it("leaves bid and ask at zero rather than inventing a spread", () => {
    const t = tickerFromCandles("TESTUSDT", series(30, () => 100))!;
    expect(t.bidPrice).toBe(0);
    expect(t.askPrice).toBe(0);
  });

  it("returns null on an empty window instead of a zero-priced ticker", () => {
    expect(tickerFromCandles("TESTUSDT", [])).toBeNull();
  });
});

// ── the engine end to end ────────────────────────────────────────────────────

const info: SymbolInfo = {
  symbol: "TESTUSDT", nativeSymbol: "TESTUSDT", base: "TEST", quote: "USDT",
  market: "spot", status: "trading", pricePrecision: 2, quantityPrecision: 4,
  minNotional: 10,
};

function settings(over: Partial<BacktestSettings> = {}): BacktestSettings {
  return {
    tradingTimeframe: "1h",
    exchange: "test",
    hasTakerBreakdown: true,
    startingEquity: 10_000,
    riskPercent: 1,
    correlationCeiling: 0.85,
    limits: {
      riskPerTradePct: 1, maxOpenPositions: 6, maxCorrelatedPositions: 3,
      correlationThreshold: 0.7, dailyLossHaltPct: 3, dailyHaltHours: 24,
      maxDrawdownHaltPct: 15,
    },
    council: {
      minFinalScore: 55, minRiskReward: 1.8, maxOpenPositions: 6,
      maxCorrelatedPositions: 3, correlationThreshold: 0.7, maxDataAgeBars: 3,
    },
    eligibility: { ...DEFAULT_ELIGIBILITY, requireLiveBook: false },
    costs: DEFAULT_COSTS,
    lookbackBars: 300,
    fearGreedHistory: [],
    allowedSetups: null,
    seedSetupStats: new Map(),
    ...over,
  };
}

function symbol(candles: Candle[]): BacktestSymbol {
  return {
    symbol: "TESTUSDT",
    info,
    listedAt: START - 400 * DAY,
    candles: { "1h": candles, "4h": [], "1d": [], "15m": [] },
  };
}

describe("the engine", () => {
  const candles = series(500, (i) => 100 + Math.sin(i / 9) * 6 + i * 0.02);
  const sym = symbol(candles);

  it("runs without touching the network and counts every analysis", () => {
    const out = runBacktest([sym], settings(), candles[100].closeTime, candles[400].closeTime);
    expect(out.funnel.analyses).toBeGreaterThan(200);
    expect(out.equityCurve.length).toBeGreaterThan(200);
  });

  it("records WHERE runs died, so the funnel is measured and not guessed", () => {
    const out = runBacktest([sym], settings(), candles[100].closeTime, candles[400].closeTime);
    const died = Object.values(out.funnel.failedAt).reduce((s, n) => s + n, 0);
    expect(died + out.funnel.recommendations + out.funnel.riskBlocked + out.funnel.setupDisallowed)
      .toBe(out.funnel.analyses);
  });

  it("never analyses a bar outside the requested window", () => {
    const from = candles[200].closeTime;
    const to = candles[260].closeTime;
    const out = runBacktest([sym], settings(), from, to);
    expect(out.equityCurve.every((p) => p.at > from && p.at <= to)).toBe(true);
  });

  it("keeps equity flat when no trade is ever taken", () => {
    // An impossible bar of entry: nothing can pass, so equity must not move.
    const out = runBacktest(
      [sym],
      settings({ council: { ...settings().council, minFinalScore: 200 } }),
      candles[100].closeTime, candles[300].closeTime,
    );
    expect(out.funnel.recommendations).toBe(0);
    expect(out.finalEquity).toBe(10_000);
  });

  it("states its caveats instead of presenting the result as complete", () => {
    const out = runBacktest([sym], settings(), candles[100].closeTime, candles[200].closeTime);
    expect(out.caveats.join(" ")).toContain("دفاتر الأوامر");
    expect(out.caveats.join(" ")).toContain("متفائلة");
  });
});

// ── metrics ──────────────────────────────────────────────────────────────────

function trade(over: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    symbol: "TESTUSDT", direction: "long", setup: "trend_continuation",
    regime: "trending_up", confidence: 70, openedAt: START, closedAt: START + HOUR,
    barsHeld: 4, realizedR: 1, realizedPnl: 100, maxFavorableR: 1.2,
    maxAdverseR: -0.3, exitReason: "target", targetsHit: 1, ...over,
  };
}

describe("metrics", () => {
  it("reports expectancy PER TRADE, so more trades cannot fake quality", () => {
    const few = computeMetrics([trade(), trade()], [], 10_000);
    const many = computeMetrics(Array.from({ length: 20 }, () => trade()), [], 10_000);
    expect(few.expectancyR).toBeCloseTo(many.expectancyR, 10);
    expect(many.totalR).toBeGreaterThan(few.totalR);
  });

  it("returns null profit factor rather than Infinity when nothing lost", () => {
    const m = computeMetrics([trade(), trade()], [], 10_000);
    expect(m.profitFactor).toBeNull();
  });

  it("measures drawdown on the equity curve, including open positions", () => {
    const curve: EquityPoint[] = [
      { at: 1, equity: 10_000, openPositions: 0, drawdownPct: 0 },
      { at: 2, equity: 12_000, openPositions: 1, drawdownPct: 0 },
      { at: 3, equity: 9_000, openPositions: 1, drawdownPct: 25 },
      { at: 4, equity: 11_000, openPositions: 0, drawdownPct: 8 },
    ];
    // Closed trades alone would show no drawdown at all here.
    const m = computeMetrics([trade({ realizedPnl: 1_000 })], curve, 10_000);
    expect(m.maxDrawdownPct).toBeCloseTo(25, 6);
  });

  it("counts the longest losing streak, not just the loss count", () => {
    const m = computeMetrics(
      [trade({ realizedR: -1 }), trade({ realizedR: -1 }), trade({ realizedR: 2 }), trade({ realizedR: -1 })],
      [], 10_000,
    );
    expect(m.losses).toBe(3);
    expect(m.longestLosingStreak).toBe(2);
  });

  it("splits by setup so a losing one cannot hide inside the average", () => {
    const rows = bySetup(
      [
        trade({ setup: "trend_continuation", realizedR: 2 }),
        trade({ setup: "trend_continuation", realizedR: 2 }),
        trade({ setup: "range_reversal", realizedR: -1, realizedPnl: -100 }),
      ],
      10_000,
    );
    const range = rows.find((r) => r.setup === "range_reversal")!;
    expect(range.metrics.expectancyR).toBeCloseTo(-1, 6);
    expect(rows[0].setup).toBe("trend_continuation"); // sorted by sample size
  });
});

describe("buy and hold", () => {
  it("charges the benchmark the same fee the bot pays", () => {
    const flat = series(50, () => 100);
    const bh = buyAndHold("TESTUSDT", flat, START - 1, flat[49].closeTime, 10)!;
    // Flat price, but two 10bp crossings: the benchmark must show a LOSS.
    expect(bh.returnPct).toBeLessThan(0);
  });

  it("reports the benchmark even when it beats the strategy", () => {
    const up = series(50, (i) => 100 + i * 2);
    const bh = buyAndHold("TESTUSDT", up, START - 1, up[49].closeTime, 10)!;
    expect(bh.returnPct).toBeGreaterThan(50);
  });

  it("returns null rather than a fabricated zero on a too-short window", () => {
    expect(buyAndHold("TESTUSDT", series(50, () => 100), START, START + HOUR, 10)).toBeNull();
  });
});

describe("the funnel verdict", () => {
  const outcome = (analyses: number, recommendations: number) => ({
    funnel: {
      analyses, recommendations, riskBlocked: 0, setupDisallowed: 0,
      failedAt: {}, vetoes: {},
    },
  } as Parameters<typeof funnelVerdict>[0]);

  it("calls one-in-five too loose", () => {
    expect(funnelVerdict(outcome(100, 20)).verdict).toBe("too_loose");
  });

  it("calls one-in-fifty healthy", () => {
    expect(funnelVerdict(outcome(1_000, 20)).verdict).toBe("healthy");
  });

  it("calls one-in-five-hundred too tight", () => {
    expect(funnelVerdict(outcome(1_000, 2)).verdict).toBe("too_tight");
  });

  it("does not divide by zero when nothing was recommended", () => {
    const v = funnelVerdict(outcome(500, 0));
    expect(v.ratio).toBeNull();
    expect(v.verdict).toBe("too_tight");
  });
});

// ── walk forward ─────────────────────────────────────────────────────────────

describe("walk forward", () => {
  it("holds out the LAST fifth of the period", () => {
    const from = START;
    const to = START + 1_000 * DAY;
    expect(holdoutBoundary(from, to)).toBe(to - 200 * DAY);
    expect(HOLDOUT_FRACTION).toBe(0.2);
  });

  it("counts the folds a period will produce, for progress reporting", () => {
    const from = START;
    // Two years: the holdout takes the last ~146 days, leaving ~584 for the
    // rolling loop. The first fold needs 182+30 days, then one per 30.
    expect(countFolds(from, from + 730 * DAY)).toBe(13);
  });

  it("produces no folds when the period is shorter than one train window", () => {
    // And says so rather than silently returning an empty result as success.
    expect(countFolds(START, START + 100 * DAY)).toBe(0);
  });

  it("bans a setup that lost money on a judgeable sample", () => {
    const losers = Array.from({ length: 12 }, () =>
      trade({ setup: "range_reversal", realizedR: -1, realizedPnl: -100 }));
    const winners = Array.from({ length: 12 }, () =>
      trade({ setup: "trend_continuation", realizedR: 1 }));
    const allowed = allowedFromTraining({ trades: [...losers, ...winners] } as never);
    expect(allowed).toContain("trend_continuation");
    expect(allowed).not.toContain("range_reversal");
  });

  it("does NOT ban a setup that merely has too few trades to judge", () => {
    // Unproven is not the same as bad. Banning here would shrink the strategy
    // every time a fold happened to be quiet.
    const few = Array.from({ length: 3 }, () =>
      trade({ setup: "liquidity_sweep", realizedR: -1, realizedPnl: -100 }));
    expect(allowedFromTraining({ trades: few } as never)).toContain("liquidity_sweep");
  });
});

// ── the full lifecycle, on a seeded market ───────────────────────────────────

describe("a complete trade, end to end", () => {
  // Deterministic prices, so this is a regression test and not a dice roll.
  // The score threshold is lowered to 25 ONLY here: with three of eight
  // stages unavailable in history, their declared penalties keep almost
  // everything under the live threshold of 55 — which is the system being
  // conservative, not broken, and is reported as a finding rather than
  // tuned away.
  const alt = backtestSymbol("ALTUSDT", 300, 7, 100);
  const btc = backtestSymbol("BTCUSDT", 300, 99, 30_000);
  const h1 = alt.candles["1h"]!;

  const out = runBacktest(
    [alt, btc],
    settings({
      council: { ...settings().council, minFinalScore: 25 },
      eligibility: { ...DEFAULT_ELIGIBILITY, requireLiveBook: false, minQuoteVolume24h: 1_000 },
    }),
    h1[h1.length - 200].closeTime,
    h1[h1.length - 1].closeTime,
  );

  it("opens, manages and closes a position", () => {
    expect(out.funnel.recommendations).toBeGreaterThanOrEqual(1);
    expect(out.trades.length).toBeGreaterThanOrEqual(1);
  });

  it("records WHICH veto fired, not only that the council said no", () => {
    // A bare "died at the council" cannot distinguish a threshold that is too
    // high from a setup classifier that never matches anything — and the two
    // call for opposite fixes.
    const fired = Object.entries(out.funnel.vetoes);
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.reduce((s, [, n]) => s + n, 0)).toBeGreaterThan(0);
  });

  it("moves equity by exactly the CLOSED trades' net P&L, once nothing is open", () => {
    // The identity only holds with no open position: an open one is marked to
    // market and legitimately moves equity without a closed trade behind it.
    if (out.openAtEnd !== 0) return;
    const net = out.trades.reduce((s, t) => s + t.realizedPnl, 0);
    expect(out.finalEquity).toBeCloseTo(10_000 + net, 6);
  });

  it("exits for a NAMED reason, never silently", () => {
    // Deliberately not pinned to one outcome: which setup fires first depends
    // on the price path, and a test that pins the P&L pins the market rather
    // than the machinery.
    for (const t of out.trades) {
      expect([
        "target_1", "target_2", "target_3", "stop_loss", "breakeven_stop",
        "trailing_stop", "invalidated", "time_exit", "circuit_breaker", "manual",
      ]).toContain(t.exitReason);
    }
  });

  it("records the heat the trade took, not only its result", () => {
    const t = out.trades[0];
    expect(t.maxAdverseR).toBeLessThan(0);
    expect(t.maxFavorableR).toBeGreaterThan(t.realizedR);
  });

  it("holds the position for real bars, not an instant round trip", () => {
    for (const t of out.trades) {
      expect(t.barsHeld).toBeGreaterThan(1);
      expect(t.closedAt).toBeGreaterThan(t.openedAt);
    }
  });
});
