/**
 * Candlestick patterns — GATED BY LOCATION.
 *
 * This is the rule the spec states and it is the whole design of this file:
 * an engulfing candle in the middle of nowhere is worth nothing. The same
 * candle at a level that has held four times on heavy volume is a signal.
 *
 * So `detectCandlePatterns` finds the shapes, and `qualifyAtLevels` is the
 * function callers must use — it DISCARDS every pattern that did not form at
 * a level, and it is the only exported path that produces a scoring
 * contribution. A pattern with no level keeps a record for the UI but carries
 * a contribution of exactly zero.
 *
 * Every pattern is read on CLOSED candles, so none of them can appear and then
 * vanish as the bar develops.
 */
import { atr } from "@/core/indicators/volatility";
import type { LevelZone } from "@/core/structure/levels";
import type { Candle } from "@/core/types";

export type CandlePatternKind =
  | "bullish_engulfing"
  | "bearish_engulfing"
  | "hammer"
  | "shooting_star"
  | "bullish_pin_bar"
  | "bearish_pin_bar"
  | "morning_star"
  | "evening_star"
  | "bullish_marubozu"
  | "bearish_marubozu"
  | "doji";

export const CANDLE_AR: Record<CandlePatternKind, string> = {
  bullish_engulfing: "ابتلاع شرائي",
  bearish_engulfing: "ابتلاع بيعي",
  hammer: "مطرقة",
  shooting_star: "نجمة هابطة",
  bullish_pin_bar: "شمعة رفض صاعدة",
  bearish_pin_bar: "شمعة رفض هابطة",
  morning_star: "نجمة الصباح",
  evening_star: "نجمة المساء",
  bullish_marubozu: "شمعة كاملة صاعدة",
  bearish_marubozu: "شمعة كاملة هابطة",
  doji: "دوجي",
};

export interface CandlePattern {
  readonly kind: CandlePatternKind;
  readonly direction: "bullish" | "bearish" | "neutral";
  readonly index: number;
  readonly time: number;
  /** 0..1 from the candle's own geometry, before any location gating. */
  readonly rawQuality: number;
  /** The level it formed at, if any. */
  readonly atLevel: LevelZone | null;
  /** 0..1 — how central the pattern is to that level. 0 when there is none. */
  readonly locationScore: number;
  /**
   * The only number a caller should score with. Zero unless the pattern formed
   * at a level, by design.
   */
  readonly weight: number;
  readonly arabic: string;
}

interface Geometry {
  body: number;
  range: number;
  upperWick: number;
  lowerWick: number;
  bullish: boolean;
}

function geometry(c: Candle): Geometry {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  return {
    body,
    range,
    upperWick: c.high - Math.max(c.open, c.close),
    lowerWick: Math.min(c.open, c.close) - c.low,
    bullish: c.close >= c.open,
  };
}

/**
 * Find candle shapes in the last `scan` bars.
 *
 * These are raw shapes only. Use `qualifyAtLevels` before scoring any of them.
 */
export function detectCandlePatterns(candles: readonly Candle[], scan = 5): CandlePattern[] {
  if (candles.length < 5) return [];
  const out: CandlePattern[] = [];
  const atrSeries = atr(candles, 14);
  const endIndex = candles.length - 1;
  const from = Math.max(3, candles.length - scan);

  for (let i = from; i <= endIndex; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const g = geometry(c);
    const gp = geometry(prev);
    const a = Number.isFinite(atrSeries[i]) && atrSeries[i] > 0 ? atrSeries[i] : c.close * 0.01;

    if (g.range <= 0) continue;

    const push = (kind: CandlePatternKind, direction: CandlePattern["direction"], quality: number) => {
      out.push({
        kind, direction, index: i, time: c.openTime,
        rawQuality: Math.max(0, Math.min(1, quality)),
        atLevel: null, locationScore: 0, weight: 0,
        arabic: "",
      });
    };

    // ── engulfing: the body must swallow the previous body outright ────────
    if (g.bullish && !gp.bullish && c.close > prev.open && c.open < prev.close && gp.body > 0) {
      // Size relative to ATR matters: a tiny engulfing of a tiny body is noise.
      push("bullish_engulfing", "bullish", Math.min(1, (g.body / a) * 0.6 + (g.body / gp.body) * 0.2));
    }
    if (!g.bullish && gp.bullish && c.close < prev.open && c.open > prev.close && gp.body > 0) {
      push("bearish_engulfing", "bearish", Math.min(1, (g.body / a) * 0.6 + (g.body / gp.body) * 0.2));
    }

    // ── hammer / shooting star ────────────────────────────────────────────
    // The opposing wick is measured against the RANGE, not the body. Against
    // the body it rejects exactly the strongest hammers: a hammer with a
    // near-zero body has a tiny upper wick in absolute terms that is still
    // many times that body, and "upperWick <= body * 0.8" throws it out.
    const bodyRatio = g.body / g.range;
    if (g.lowerWick >= g.body * 2 && g.upperWick <= g.range * 0.15 && bodyRatio < 0.4) {
      push("hammer", "bullish", Math.min(1, (g.lowerWick / g.range) * 1.1));
    }
    if (g.upperWick >= g.body * 2 && g.lowerWick <= g.range * 0.15 && bodyRatio < 0.4) {
      push("shooting_star", "bearish", Math.min(1, (g.upperWick / g.range) * 1.1));
    }

    // ── pin bar: an extreme rejection, stronger than a hammer ──────────────
    if (g.lowerWick / g.range > 0.66 && g.range > a * 0.8) {
      push("bullish_pin_bar", "bullish", Math.min(1, g.lowerWick / g.range));
    }
    if (g.upperWick / g.range > 0.66 && g.range > a * 0.8) {
      push("bearish_pin_bar", "bearish", Math.min(1, g.upperWick / g.range));
    }

    // ── three-bar stars ────────────────────────────────────────────────────
    if (i >= 2) {
      const first = candles[i - 2];
      const gf = geometry(first);
      const gm = geometry(prev);
      const smallMiddle = gm.body < gf.body * 0.5 && gm.body < g.body * 0.5;

      if (!gf.bullish && smallMiddle && g.bullish && c.close > first.open - gf.body * 0.5) {
        push("morning_star", "bullish", Math.min(1, (g.body / a) * 0.5 + 0.3));
      }
      if (gf.bullish && smallMiddle && !g.bullish && c.close < first.open + gf.body * 0.5) {
        push("evening_star", "bearish", Math.min(1, (g.body / a) * 0.5 + 0.3));
      }
    }

    // ── marubozu: conviction, almost no wick ───────────────────────────────
    if (bodyRatio > 0.9 && g.range > a) {
      push(g.bullish ? "bullish_marubozu" : "bearish_marubozu", g.bullish ? "bullish" : "bearish",
        Math.min(1, bodyRatio));
    }

    // ── doji: indecision. Never directional on its own. ────────────────────
    if (bodyRatio < 0.08 && g.range > a * 0.4) {
      push("doji", "neutral", 1 - bodyRatio * 10);
    }
  }

  return out;
}

/**
 * Attach levels and compute the weight.
 *
 * THIS IS THE GATE. A pattern that did not form inside or immediately adjacent
 * to a level keeps `weight: 0` and says so in Arabic. Callers must score on
 * `weight`, never on `rawQuality`.
 */
export function qualifyAtLevels(
  patterns: readonly CandlePattern[],
  candles: readonly Candle[],
  levels: readonly LevelZone[],
  /** How far from a zone still counts as "at" it, in ATR. */
  proximityAtr = 0.4,
): CandlePattern[] {
  const atrSeries = atr(candles, 14);

  return patterns.map((p) => {
    const c = candles[p.index];
    const a =
      Number.isFinite(atrSeries[p.index]) && atrSeries[p.index] > 0
        ? atrSeries[p.index]
        : c.close * 0.01;
    const tolerance = a * proximityAtr;

    // The candle's own extreme is what tests a level, not its close: a hammer
    // tests support with its low.
    const probe =
      p.direction === "bullish" ? c.low : p.direction === "bearish" ? c.high : c.close;

    let best: LevelZone | null = null;
    let bestLocation = 0;

    for (const zone of levels) {
      const inside = probe >= zone.low - tolerance && probe <= zone.high + tolerance;
      if (!inside) continue;
      // Closer to the zone centre and a stronger zone both raise the score.
      const centreDistance = Math.abs(probe - zone.price);
      const halfWidth = Math.max((zone.high - zone.low) / 2 + tolerance, 1e-9);
      const centrality = Math.max(0, 1 - centreDistance / halfWidth);
      const location = centrality * 0.5 + (zone.strength / 100) * 0.5;
      if (location > bestLocation) {
        bestLocation = location;
        best = zone;
      }
    }

    const weight = best ? p.rawQuality * bestLocation : 0;

    return {
      ...p,
      atLevel: best,
      locationScore: bestLocation,
      weight,
      arabic: describeCandle(p, best, bestLocation, weight),
    };
  });
}

function describeCandle(
  p: CandlePattern,
  level: LevelZone | null,
  location: number,
  weight: number,
): string {
  const name = CANDLE_AR[p.kind];
  if (!level) {
    return `${name} تشكّلت في منتصف الفراغ — لا مستوى مهم عندها، فلا تُحتسب إطلاقاً.`;
  }
  const quality = weight > 0.5 ? "قوية" : weight > 0.25 ? "متوسطة" : "ضعيفة";
  return (
    `${name} تشكّلت عند ${level.arabic.split("،")[0]} — إشارة ${quality}. ` +
    `درجة الموقع ${(location * 100).toFixed(0)}% ووزنها النهائي ${(weight * 100).toFixed(0)}%.`
  );
}

/** Patterns that actually count: formed at a level and pointing somewhere. */
export function significantPatterns(patterns: readonly CandlePattern[]): CandlePattern[] {
  return patterns
    .filter((p) => p.weight > 0 && p.direction !== "neutral")
    .sort((a, b) => b.index - a.index || b.weight - a.weight);
}
