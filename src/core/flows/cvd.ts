/**
 * Cumulative volume delta — who is actually initiating.
 *
 * Every trade has a buyer and a seller, so "buy volume" alone is meaningless.
 * What carries information is which side CROSSED THE SPREAD: a taker buy is
 * someone paying up to get filled now, and a run of them is real demand
 * rather than resting interest.
 *
 * ONLY VALID WHERE THE VENUE REPORTS THE TAKER SPLIT. Bybit and OKX do not,
 * and their candles carry takerBuyBase = 0 — computing a delta from those
 * would report maximum sell aggression on every single bar. The capability
 * flag is checked by the caller and this module refuses to guess.
 */
import { type Series, filled, slopePct } from "@/core/indicators/series";
import { findPivots } from "@/core/indicators/pivots";
import type { Candle } from "@/core/types";

export interface CvdResult {
  /** Cumulative delta, same length as the input. */
  readonly cumulative: Series;
  /** Per-bar delta. */
  readonly perBar: Series;
  /** Delta over the window as a fraction of total volume, −1..1. */
  readonly netRatio: number;
  /** Slope of the CVD over the trailing window, percent per bar. */
  readonly slope: number;
  /** True when CVD and price disagree on direction. */
  readonly divergence: CvdDivergence | null;
  readonly arabic: string;
}

export interface CvdDivergence {
  readonly kind: "bullish" | "bearish";
  /** How many bars the disagreement has persisted. */
  readonly bars: number;
  /** 0..1 — how strongly they disagree. */
  readonly strength: number;
  readonly arabic: string;
}

export function analyzeCvd(candles: readonly Candle[], window = 40): CvdResult {
  const n = candles.length;
  const perBar = filled(n);
  const cumulative = filled(n);

  let sum = 0;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    // takerBuy − takerSell, where takerSell = volume − takerBuy.
    const delta = c.takerBuyBase - (c.volume - c.takerBuyBase);
    perBar[i] = delta;
    sum += delta;
    cumulative[i] = sum;
  }

  const tail = candles.slice(-window);
  const tailVolume = tail.reduce((s, c) => s + c.volume, 0);
  const tailDelta = tail.reduce((s, c) => s + (c.takerBuyBase - (c.volume - c.takerBuyBase)), 0);
  const netRatio = tailVolume > 0 ? tailDelta / tailVolume : 0;

  const cvdSlope = slopePct(cumulative, Math.min(window, n))[n - 1];
  const priceSlope = slopePct(candles.map((c) => c.close), Math.min(window, n))[n - 1];

  const divergence = detectDivergence(candles, cumulative, window);

  return {
    cumulative,
    perBar,
    netRatio,
    slope: Number.isFinite(cvdSlope) ? cvdSlope : 0,
    divergence,
    arabic: narrate(netRatio, cvdSlope, priceSlope, divergence),
  };
}

/**
 * CVD against price on confirmed swings.
 *
 * Price making a higher high while CVD does not means the move up was not
 * bought — it drifted on thin resting liquidity, and that is the specific
 * condition that precedes a reversal rather than a continuation.
 */
function detectDivergence(
  candles: readonly Candle[],
  cvd: Series,
  window: number,
): CvdDivergence | null {
  const end = candles.length - 1;
  const from = Math.max(0, candles.length - window);

  const pivots = findPivots(candles, 3, 3).filter((p) => p.confirmedAt <= end && p.index >= from);
  const highs = pivots.filter((p) => p.kind === "high");
  const lows = pivots.filter((p) => p.kind === "low");

  const check = (
    points: typeof highs,
    kind: "bullish" | "bearish",
  ): CvdDivergence | null => {
    if (points.length < 2) return null;
    const prev = points[points.length - 2];
    const curr = points[points.length - 1];

    const priceUp = curr.price > prev.price;
    const cvdPrev = cvd[prev.index];
    const cvdCurr = cvd[curr.index];
    if (!Number.isFinite(cvdPrev) || !Number.isFinite(cvdCurr)) return null;
    const cvdUp = cvdCurr > cvdPrev;

    // Bearish: higher high in price, lower high in CVD.
    if (kind === "bearish" && priceUp && !cvdUp) {
      const scale = Math.abs(cvdPrev) || 1;
      return {
        kind: "bearish",
        bars: curr.index - prev.index,
        strength: Math.min(1, Math.abs(cvdCurr - cvdPrev) / scale),
        arabic:
          "السعر صنع قمة أعلى بينما دلتا الحجم التراكمي صنعت قمة أدنى — " +
          "الارتفاع لم يُشترَ فعلاً، بل انجرف على سيولة رقيقة.",
      };
    }
    // Bullish: lower low in price, higher low in CVD.
    if (kind === "bullish" && !priceUp && cvdUp) {
      const scale = Math.abs(cvdPrev) || 1;
      return {
        kind: "bullish",
        bars: curr.index - prev.index,
        strength: Math.min(1, Math.abs(cvdCurr - cvdPrev) / scale),
        arabic:
          "السعر صنع قاعاً أدنى بينما دلتا الحجم التراكمي صنعت قاعاً أعلى — " +
          "الهبوط لم يُبَع فعلاً، والبائع المبادر يفقد قوّته.",
      };
    }
    return null;
  };

  return check(highs, "bearish") ?? check(lows, "bullish");
}

function narrate(
  netRatio: number,
  cvdSlope: number,
  priceSlope: number,
  divergence: CvdDivergence | null,
): string {
  const parts: string[] = [];
  const pct = (netRatio * 100).toFixed(1);

  if (Math.abs(netRatio) < 0.03) {
    parts.push(`المبادرة متوازنة بين الطرفين (صافي ${pct}% من الحجم).`);
  } else if (netRatio > 0) {
    parts.push(`المشترون هم المبادرون: صافي دلتا ${pct}% من الحجم — شراء يعبر الفارق فعلاً.`);
  } else {
    parts.push(`البائعون هم المبادرون: صافي دلتا ${pct}% من الحجم.`);
  }

  if (Number.isFinite(cvdSlope) && Number.isFinite(priceSlope)) {
    const agree = (cvdSlope > 0) === (priceSlope > 0);
    parts.push(
      agree
        ? "واتجاه الدلتا يوافق اتجاه السعر — الحركة مدعومة بمبادرة حقيقية."
        : "واتجاه الدلتا يخالف اتجاه السعر.",
    );
  }

  if (divergence) parts.push(divergence.arabic);
  return parts.join(" ");
}
