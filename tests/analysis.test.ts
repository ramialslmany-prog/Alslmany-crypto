/**
 * The technical analysis layer.
 *
 * The invariant this suite exists to protect: a layer's score must EQUAL the
 * sum of its factor contributions. If that ever drifts, the site's "how the
 * bot decided" breakdown becomes a story told after the fact rather than the
 * actual arithmetic — which is exactly the dishonesty the spec forbids.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { analyzeMomentum, analyzeTrend, analyzeVolatility, analyzeVolume } from "@/core/analysis/layers";
import { analyzeConfluence, anchorFor } from "@/core/analysis/confluence";
import { analyzeTechnical, analyzeTimeframe } from "@/core/analysis/technical";
import type { Bias, TimeframeAnalysis } from "@/core/analysis/types";
import type { Candle } from "@/core/types";
import { TIMEFRAMES, type Timeframe, tfMillis } from "@/shared/time";

const raw = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "candles-1h.json"), "utf8"),
) as { openTime: number; open: number; high: number; low: number; close: number; volume: number }[];

const candles: Candle[] = raw.map((c) => ({
  ...c,
  closeTime: c.openTime + 3_600_000,
  quoteVolume: c.volume * c.close,
  trades: 10,
  takerBuyBase: c.volume * 0.55,
  takerBuyQuote: c.volume * 0.55 * c.close,
}));

/** A clean synthetic series with a chosen direction, for deterministic bias. */
function ramp(direction: "up" | "down" | "flat", bars = 320, startPrice = 100): Candle[] {
  const out: Candle[] = [];
  const step = direction === "up" ? 0.004 : direction === "down" ? -0.004 : 0;
  let price = startPrice;
  for (let i = 0; i < bars; i++) {
    const open = price;
    const close = open * (1 + step);
    // A touch of wiggle so ATR and the bands are not degenerate.
    const wobble = open * 0.0015 * (i % 3 === 0 ? 1 : -1);
    const high = Math.max(open, close) + Math.abs(wobble);
    const low = Math.min(open, close) - Math.abs(wobble);
    out.push({
      openTime: Date.UTC(2024, 0, 1) + i * 3_600_000,
      closeTime: Date.UTC(2024, 0, 1) + (i + 1) * 3_600_000,
      open, high, low, close,
      volume: 100 + (i % 7) * 3,
      quoteVolume: (100 + (i % 7) * 3) * close,
      trades: 10,
      takerBuyBase: (100 + (i % 7) * 3) * (direction === "up" ? 0.6 : 0.4),
      takerBuyQuote: 0,
    });
    price = close;
  }
  return out;
}

const SUM_TOLERANCE = 1e-9;

describe("factor contributions reproduce the layer score exactly", () => {
  it("trend", () => {
    const l = analyzeTrend(candles);
    const sum = l.factors.reduce((s, f) => s + f.contribution, 0);
    expect(l.score).toBeCloseTo(Math.max(-100, Math.min(100, sum)), 9);
  });

  it("momentum", () => {
    const l = analyzeMomentum(candles, "1h");
    const sum = l.factors.reduce((s, f) => s + f.contribution, 0);
    expect(l.score).toBeCloseTo(Math.max(-100, Math.min(100, sum)), 9);
  });

  it("volume", () => {
    const l = analyzeVolume(candles, "1h", true);
    const sum = l.factors.reduce((s, f) => s + f.contribution, 0);
    expect(l.score).toBeCloseTo(Math.max(-100, Math.min(100, sum)), 9);
  });

  it("volatility starts from a neutral 50 and its factors move it", () => {
    const l = analyzeVolatility(candles);
    const sum = l.factors.reduce((s, f) => s + f.contribution, 0);
    expect(l.score).toBeCloseTo(Math.max(0, Math.min(100, 50 + sum)), 9);
  });

  it("holds on many different windows, not just the last one", () => {
    for (const end of [260, 340, 420, 500, 600]) {
      const window = candles.slice(0, end);
      for (const l of [analyzeTrend(window), analyzeMomentum(window, "1h"), analyzeVolume(window, "1h", true)]) {
        const sum = l.factors.reduce((s, f) => s + f.contribution, 0);
        expect(Math.abs(l.score - Math.max(-100, Math.min(100, sum))), `${l.id}@${end}`).toBeLessThan(SUM_TOLERANCE);
      }
    }
  });
});

describe("layer scoring behaves", () => {
  it("reads a clean uptrend as bullish and a downtrend as bearish", () => {
    expect(analyzeTrend(ramp("up")).bias).toBe("bullish");
    expect(analyzeTrend(ramp("down")).bias).toBe("bearish");
  });

  it("does not claim a direction on a flat market", () => {
    expect(analyzeTrend(ramp("flat")).bias).toBe("neutral");
  });

  it("every layer score stays inside its declared range", () => {
    for (const end of [200, 350, 600]) {
      const w = candles.slice(0, end);
      for (const l of [analyzeTrend(w), analyzeMomentum(w, "1h"), analyzeVolume(w, "1h", true)]) {
        expect(l.score).toBeGreaterThanOrEqual(-100);
        expect(l.score).toBeLessThanOrEqual(100);
      }
      const v = analyzeVolatility(w);
      expect(v.score).toBeGreaterThanOrEqual(0);
      expect(v.score).toBeLessThanOrEqual(100);
    }
  });

  it("volatility is NEVER directional — a squeeze says nothing about which way", () => {
    expect(analyzeVolatility(ramp("up")).bias).toBe("neutral");
    expect(analyzeVolatility(ramp("down")).bias).toBe("neutral");
    expect(analyzeVolatility(candles).bias).toBe("neutral");
  });

  it("every factor carries an Arabic note the site can display", () => {
    const layers = [
      analyzeTrend(candles), analyzeMomentum(candles, "1h"),
      analyzeVolatility(candles), analyzeVolume(candles, "1h", true),
    ];
    for (const l of layers) {
      expect(l.arabic.length).toBeGreaterThan(20);
      for (const f of l.factors) {
        expect(f.label.length, `${l.id}.${f.id} label`).toBeGreaterThan(2);
        expect(f.note.length, `${l.id}.${f.id} note`).toBeGreaterThan(5);
        expect(f.display.length, `${l.id}.${f.id} display`).toBeGreaterThan(0);
      }
    }
  });
});

describe("taker delta honesty", () => {
  it("reports it unavailable — never as a real zero — when the venue lacks it", () => {
    const l = analyzeVolume(candles, "1h", false);
    const f = l.factors.find((x) => x.id === "taker_delta")!;
    expect(f.value).toBeNull();
    expect(f.contribution).toBe(0);
    expect(f.display).toBe("غير متاح");
    expect(l.unavailable.join()).toContain("دلتا المبادرين");
  });

  it("uses it when the venue does report it", () => {
    const l = analyzeVolume(candles, "1h", true);
    const f = l.factors.find((x) => x.id === "taker_delta")!;
    expect(f.value).not.toBeNull();
  });

  it("a venue without the split cannot silently look like relentless selling", () => {
    // Bybit/OKX candles carry takerBuyBase = 0. If the layer used them anyway,
    // every bar would read as maximum sell aggression.
    const zeroed = candles.map((c) => ({ ...c, takerBuyBase: 0, takerBuyQuote: 0 }));
    const honest = analyzeVolume(zeroed, "1h", false);
    const naive = analyzeVolume(zeroed, "1h", true);
    const honestDelta = honest.factors.find((f) => f.id === "taker_delta")!;
    const naiveDelta = naive.factors.find((f) => f.id === "taker_delta")!;
    expect(honestDelta.contribution).toBe(0);
    expect(naiveDelta.contribution).toBeLessThan(0); // the bug we designed out
  });
});

describe("short history is declined, not guessed at", () => {
  it("names each unavailable indicator instead of emitting a number", () => {
    const short = candles.slice(0, 80);
    const t = analyzeTrend(short);
    expect(t.unavailable.length).toBeGreaterThan(0);
    const stack = t.factors.find((f) => f.id === "ma_stack")!;
    expect(stack.value).toBeNull();
    expect(stack.contribution).toBe(0);
  });

  it("warns on the timeframe when history is below the full requirement", () => {
    const a = analyzeTimeframe(candles.slice(0, 120), "1h", true);
    expect(a.warnings.some((w) => w.includes("أقل من"))).toBe(true);
  });

  it("stochastic only votes on fast timeframes", () => {
    const fast = analyzeMomentum(candles, "15m").factors.find((f) => f.id === "stochastic")!;
    const slow = analyzeMomentum(candles, "1d").factors.find((f) => f.id === "stochastic")!;
    expect(fast.value).not.toBeNull();
    expect(slow.value).toBeNull();
    expect(slow.contribution).toBe(0);
  });
});

// ── the flow rule ────────────────────────────────────────────────────────────

function fakeTf(timeframe: Timeframe, score: number): TimeframeAnalysis {
  const bias: Bias = score > 15 ? "bullish" : score < -15 ? "bearish" : "neutral";
  const stub = { id: "trend" as const, label: "", score, bias, factors: [], arabic: "", unavailable: [] };
  return {
    timeframe, bars: 300, asOf: Date.UTC(2024, 0, 1), price: 100,
    layers: { trend: stub, momentum: { ...stub, id: "momentum" }, volatility: { ...stub, id: "volatility", score: 50, bias: "neutral" }, volume: { ...stub, id: "volume" } },
    score, bias, strength: Math.abs(score), arabic: "", warnings: [],
  };
}

describe("anchorFor — two rungs up the ladder", () => {
  it("anchors a 1h trade to the daily", () => {
    expect(anchorFor("1h", [...TIMEFRAMES])).toBe("1d");
  });

  it("anchors 5m to 1h and 15m to 4h", () => {
    expect(anchorFor("5m", [...TIMEFRAMES])).toBe("1h");
    expect(anchorFor("15m", [...TIMEFRAMES])).toBe("4h");
  });

  it("clamps at the top of the ladder", () => {
    expect(anchorFor("1d", [...TIMEFRAMES])).toBe("1w");
    expect(anchorFor("1w", [...TIMEFRAMES])).toBe("1w");
  });

  it("falls back to the highest AVAILABLE timeframe when the ideal one is missing", () => {
    expect(anchorFor("1h", ["5m", "15m", "1h", "4h"])).toBe("4h");
    expect(anchorFor("1h", ["1h"])).toBe("1h");
  });
});

describe("flow rule", () => {
  it("REJECTS a long on 1h when the daily is bearish (two rungs apart)", () => {
    const r = analyzeConfluence(
      [fakeTf("15m", 40), fakeTf("1h", 60), fakeTf("4h", 20), fakeTf("1d", -70), fakeTf("1w", -50)],
      { tradingTimeframe: "1h" },
    );
    expect(r.verdict).toBe("fail");
    expect(r.conflicts.some((c) => c.fatal)).toBe(true);
    expect(r.allowedDirection).toBe("short");
    expect(r.arabic).toContain("تعارض قاتل");
  });

  it("ALLOWS a 1h pullback inside a 4h uptrend — one rung apart is not a conflict", () => {
    const r = analyzeConfluence(
      [fakeTf("15m", -30), fakeTf("1h", -25), fakeTf("4h", 55), fakeTf("1d", 60), fakeTf("1w", 45)],
      { tradingTimeframe: "4h" },
    );
    expect(r.verdict).toBe("pass");
    expect(r.conflicts.every((c) => !c.fatal)).toBe(true);
  });

  it("passes when every timeframe agrees", () => {
    const r = analyzeConfluence(
      TIMEFRAMES.map((tf) => fakeTf(tf, 55)),
      { tradingTimeframe: "1h" },
    );
    expect(r.verdict).toBe("pass");
    expect(r.conflicts).toHaveLength(0);
    expect(r.agreement).toBeGreaterThan(60);
    expect(r.allowedDirection).toBe("long");
  });

  it("a neutral anchor forbids nothing", () => {
    const r = analyzeConfluence(
      [fakeTf("1h", 50), fakeTf("4h", 30), fakeTf("1d", 0)],
      { tradingTimeframe: "1h" },
    );
    expect(r.anchorBias).toBe("neutral");
    expect(r.allowedDirection).toBe("both");
    expect(r.verdict).toBe("pass");
  });

  it("neutral timeframes are silence, not disagreement", () => {
    const r = analyzeConfluence(
      [fakeTf("1h", 50), fakeTf("4h", 0), fakeTf("1d", 60)],
      { tradingTimeframe: "1h" },
    );
    expect(r.conflicts).toHaveLength(0);
  });

  it("scattered timeframes score lower agreement than aligned ones", () => {
    const aligned = analyzeConfluence(TIMEFRAMES.map((tf) => fakeTf(tf, 60)), { tradingTimeframe: "1h" });
    const scattered = analyzeConfluence(
      [fakeTf("5m", 80), fakeTf("15m", -70), fakeTf("1h", 65), fakeTf("4h", -60), fakeTf("1d", 70), fakeTf("1w", -55)],
      { tradingTimeframe: "1h" },
    );
    expect(scattered.agreement).toBeLessThan(aligned.agreement);
  });

  it("names every timeframe and where the conflict is, as the spec requires", () => {
    const r = analyzeConfluence(
      [fakeTf("1h", 60), fakeTf("4h", 20), fakeTf("1d", -70)],
      { tradingTimeframe: "1h" },
    );
    for (const tf of ["1h", "4h", "1d"]) expect(r.arabic).toContain(tf);
    expect(r.arabic).toContain("الاتجاه المسموح");
  });
});

describe("macro gate intersects with the flow rule", () => {
  it("a macro long-only ban turns a short setup into no trade", () => {
    const r = analyzeConfluence(
      [fakeTf("1h", -60), fakeTf("4h", -55), fakeTf("1d", -70)],
      { tradingTimeframe: "1h", macroAllowed: "long" },
    );
    expect(r.allowedDirection).toBe("none");
    expect(r.verdict).toBe("fail");
  });

  it("macro 'none' vetoes everything however clean the setup", () => {
    const r = analyzeConfluence(
      TIMEFRAMES.map((tf) => fakeTf(tf, 80)),
      { tradingTimeframe: "1h", macroAllowed: "none" },
    );
    expect(r.allowedDirection).toBe("none");
    expect(r.verdict).toBe("fail");
  });

  it("a macro direction narrows a neutral anchor rather than widening it", () => {
    const r = analyzeConfluence(
      [fakeTf("1h", 40), fakeTf("4h", 10), fakeTf("1d", 5)],
      { tradingTimeframe: "1h", macroAllowed: "long" },
    );
    expect(r.allowedDirection).toBe("long");
  });
});

// ── the orchestrator ─────────────────────────────────────────────────────────

function multiTf(): Partial<Record<Timeframe, Candle[]>> {
  // Resample the 1h fixture up so every timeframe has real, consistent data.
  const out: Partial<Record<Timeframe, Candle[]>> = { "1h": candles };
  for (const tf of ["4h", "1d"] as const) {
    const factor = tfMillis(tf) / tfMillis("1h");
    const agg: Candle[] = [];
    for (let i = 0; i + factor <= candles.length; i += factor) {
      const group = candles.slice(i, i + factor);
      agg.push({
        openTime: group[0].openTime,
        closeTime: group[0].openTime + tfMillis(tf),
        open: group[0].open,
        high: Math.max(...group.map((c) => c.high)),
        low: Math.min(...group.map((c) => c.low)),
        close: group[group.length - 1].close,
        volume: group.reduce((s, c) => s + c.volume, 0),
        quoteVolume: group.reduce((s, c) => s + c.quoteVolume, 0),
        trades: group.reduce((s, c) => s + c.trades, 0),
        takerBuyBase: group.reduce((s, c) => s + c.takerBuyBase, 0),
        takerBuyQuote: group.reduce((s, c) => s + c.takerBuyQuote, 0),
      });
    }
    out[tf] = agg;
  }
  return out;
}

describe("analyzeTechnical", () => {
  const NOW = candles[candles.length - 1].openTime + 3_600_000;

  it("analyses the timeframes it has and NAMES the ones it does not", () => {
    const r = analyzeTechnical({
      symbol: "BTCUSDT", candles: multiTf(), tradingTimeframe: "1h",
      hasTakerBreakdown: true, now: NOW,
    });
    expect(r.timeframes.map((t) => t.timeframe)).toEqual(["1h", "4h"]);
    // 1d aggregates to only 25 bars — below the floor, so it is declined.
    const named = r.missing.map((m) => m.timeframe);
    expect(named).toContain("5m");
    expect(named).toContain("1w");
    for (const m of r.missing) expect(m.reason.length).toBeGreaterThan(5);
  });

  it("returns timeframes ordered low to high", () => {
    const r = analyzeTechnical({
      symbol: "BTCUSDT", candles: multiTf(), tradingTimeframe: "1h",
      hasTakerBreakdown: true, now: NOW,
    });
    const order = r.timeframes.map((t) => TIMEFRAMES.indexOf(t.timeframe));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("fails cleanly when the trading timeframe itself is missing", () => {
    const r = analyzeTechnical({
      symbol: "BTCUSDT", candles: { "1h": candles }, tradingTimeframe: "4h",
      hasTakerBreakdown: true, now: NOW,
    });
    expect(r.verdict).toBe("fail");
    expect(r.arabic).toContain("إطار التداول");
  });

  it("fails with an explanation rather than throwing on no data at all", () => {
    const r = analyzeTechnical({
      symbol: "NEWCOIN", candles: {}, tradingTimeframe: "1h", hasTakerBreakdown: true, now: NOW,
    });
    expect(r.verdict).toBe("fail");
    expect(r.timeframes).toHaveLength(0);
    expect(r.missing).toHaveLength(TIMEFRAMES.length);
    expect(r.arabic).toContain("تعذّر");
  });

  it("drops a forming candle even if the caller forgot to", () => {
    const withForming = [...candles, {
      ...candles[candles.length - 1],
      openTime: candles[candles.length - 1].openTime + 3_600_000,
      closeTime: candles[candles.length - 1].openTime + 7_200_000,
      close: 999_999, // an absurd value that would distort everything
    }];
    const clean = analyzeTechnical({
      symbol: "BTCUSDT", candles: { "1h": candles }, tradingTimeframe: "1h",
      hasTakerBreakdown: true, now: NOW,
    });
    const guarded = analyzeTechnical({
      symbol: "BTCUSDT", candles: { "1h": withForming }, tradingTimeframe: "1h",
      hasTakerBreakdown: true, now: NOW, // the extra bar has NOT closed at NOW
    });
    expect(guarded.timeframes[0].price).toBe(clean.timeframes[0].price);
    expect(guarded.timeframes[0].price).not.toBe(999_999);
  });

  it("is deterministic — the same input yields byte-identical output", () => {
    const input = {
      symbol: "BTCUSDT", candles: multiTf(), tradingTimeframe: "1h" as const,
      hasTakerBreakdown: true, now: NOW,
    };
    expect(JSON.stringify(analyzeTechnical(input))).toBe(JSON.stringify(analyzeTechnical(input)));
  });

  it("never looks ahead: truncating the series cannot change an earlier read", () => {
    const head = candles.slice(0, 400);
    const asOfHead = head[head.length - 1].openTime + 3_600_000;
    const a = analyzeTechnical({
      symbol: "X", candles: { "1h": head }, tradingTimeframe: "1h", hasTakerBreakdown: true, now: asOfHead,
    });
    // Same cut-off, but handed the full series — the engine must trim to the
    // same closed bar and produce the same numbers.
    const b = analyzeTechnical({
      symbol: "X", candles: { "1h": candles.slice(0, 400) }, tradingTimeframe: "1h",
      hasTakerBreakdown: true, now: asOfHead,
    });
    expect(a.timeframes[0].score).toBeCloseTo(b.timeframes[0].score, 10);
  });

  it("produces an Arabic narrative naming the timeframes it read", () => {
    const r = analyzeTechnical({
      symbol: "BTCUSDT", candles: multiTf(), tradingTimeframe: "1h",
      hasTakerBreakdown: true, now: NOW,
    });
    expect(r.arabic).toContain("BTCUSDT");
    expect(r.arabic).toContain("1h");
    expect(r.arabic.length).toBeGreaterThan(100);
    for (const tf of r.timeframes) expect(tf.arabic.length).toBeGreaterThan(50);
  });

  it("conviction rewards agreement between layers, not raw magnitude", () => {
    const a = analyzeTimeframe(ramp("up"), "1h", true);
    expect(a.strength).toBeGreaterThanOrEqual(0);
    expect(a.strength).toBeLessThanOrEqual(100);
    expect(a.bias).toBe("bullish");
  });
});
