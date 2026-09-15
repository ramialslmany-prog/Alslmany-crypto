/**
 * Divergence between price and an oscillator.
 *
 * Built strictly on CONFIRMED pivots. A divergence detected against an
 * unconfirmed swing is a divergence against a swing that may not exist yet —
 * it will evaporate on the next bar and it will never be reproducible live.
 *
 * Four kinds, and the distinction matters for how they are traded:
 *   regular bearish — price higher high,  oscillator lower high   → exhaustion
 *   regular bullish — price lower low,    oscillator higher low   → exhaustion
 *   hidden bearish  — price lower high,   oscillator higher high  → continuation
 *   hidden bullish  — price higher low,   oscillator lower low    → continuation
 *
 * Hidden divergence is a TREND-FOLLOWING signal. Trading it as a reversal,
 * which happens often, is backwards.
 */
import { type Pivot, findPivots, pivotHighs, pivotLows } from "@/core/indicators/pivots";
import type { Series } from "@/core/indicators/series";
import type { Candle } from "@/core/types";

export type DivergenceKind =
  | "regular_bullish"
  | "regular_bearish"
  | "hidden_bullish"
  | "hidden_bearish";

export interface Divergence {
  readonly kind: DivergenceKind;
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly fromPrice: number;
  readonly toPrice: number;
  readonly fromOscillator: number;
  readonly toOscillator: number;
  /** Bars between the two pivots — a 3-bar divergence is noise. */
  readonly span: number;
  /** 0..1. Combines oscillator separation with how extreme the reading was. */
  readonly strength: number;
  readonly arabic: string;
}

export interface DivergenceOptions {
  readonly pivotLeft?: number;
  readonly pivotRight?: number;
  /** Ignore pairs closer together than this — they are noise, not structure. */
  readonly minSpan?: number;
  /** Ignore pairs further apart than this — the context has changed. */
  readonly maxSpan?: number;
  /** Only look this far back from the end of the series. */
  readonly lookback?: number;
  /** Require the oscillator to differ by at least this much. */
  readonly minOscillatorDelta?: number;
}

const AR: Record<DivergenceKind, string> = {
  regular_bullish: "انحراف صعودي عادي — قاع أدنى في السعر يقابله قاع أعلى في المؤشّر: البائع يفقد قوّته",
  regular_bearish: "انحراف هبوطي عادي — قمة أعلى في السعر تقابلها قمة أدنى في المؤشّر: المشتري يفقد قوّته",
  hidden_bullish: "انحراف صعودي خفي — قاع أعلى في السعر يقابله قاع أدنى في المؤشّر: استمرار للاتجاه الصاعد",
  hidden_bearish: "انحراف هبوطي خفي — قمة أدنى في السعر تقابلها قمة أعلى في المؤشّر: استمرار للاتجاه الهابط",
};

export function findDivergences(
  candles: readonly Candle[],
  oscillator: Series,
  opts: DivergenceOptions = {},
): Divergence[] {
  const left = opts.pivotLeft ?? 3;
  const right = opts.pivotRight ?? 3;
  const minSpan = opts.minSpan ?? 5;
  const maxSpan = opts.maxSpan ?? 60;
  const lookback = opts.lookback ?? 120;
  const minDelta = opts.minOscillatorDelta ?? 1;

  const endIndex = candles.length - 1;
  const all = findPivots(candles, left, right);
  // Only pivots already confirmed at the last bar may be used.
  const usable = all.filter(
    (p) => p.confirmedAt <= endIndex && p.index >= candles.length - lookback,
  );

  const out: Divergence[] = [];
  out.push(...scan(pivotHighs(usable), oscillator, "high", { minSpan, maxSpan, minDelta }));
  out.push(...scan(pivotLows(usable), oscillator, "low", { minSpan, maxSpan, minDelta }));
  out.sort((a, b) => a.toIndex - b.toIndex);
  return out;
}

function scan(
  pivots: readonly Pivot[],
  osc: Series,
  side: "high" | "low",
  cfg: { minSpan: number; maxSpan: number; minDelta: number },
): Divergence[] {
  const out: Divergence[] = [];

  // Compare each pivot with the previous one of the same kind only.
  for (let i = 1; i < pivots.length; i++) {
    const prev = pivots[i - 1];
    const curr = pivots[i];
    const span = curr.index - prev.index;
    if (span < cfg.minSpan || span > cfg.maxSpan) continue;

    const o1 = osc[prev.index];
    const o2 = osc[curr.index];
    if (!Number.isFinite(o1) || !Number.isFinite(o2)) continue;
    if (Math.abs(o2 - o1) < cfg.minDelta) continue;

    const priceUp = curr.price > prev.price;
    const oscUp = o2 > o1;
    let kind: DivergenceKind | null = null;

    if (side === "high") {
      if (priceUp && !oscUp) kind = "regular_bearish";
      else if (!priceUp && oscUp) kind = "hidden_bearish";
    } else {
      if (!priceUp && oscUp) kind = "regular_bullish";
      else if (priceUp && !oscUp) kind = "hidden_bullish";
    }
    if (!kind) continue;

    out.push({
      kind,
      fromIndex: prev.index,
      toIndex: curr.index,
      fromPrice: prev.price,
      toPrice: curr.price,
      fromOscillator: o1,
      toOscillator: o2,
      span,
      strength: strengthOf(o1, o2, kind),
      arabic: AR[kind],
    });
  }
  return out;
}

/**
 * 0..1. Two thirds from how far apart the oscillator readings are, one third
 * from how extreme the reading was — a bearish divergence printed at RSI 78
 * carries more weight than the same separation printed at RSI 55.
 */
function strengthOf(o1: number, o2: number, kind: DivergenceKind): number {
  const separation = Math.min(1, Math.abs(o2 - o1) / 20);
  const bearish = kind === "regular_bearish" || kind === "hidden_bearish";
  const extreme = bearish
    ? Math.min(1, Math.max(0, (Math.max(o1, o2) - 60) / 30))
    : Math.min(1, Math.max(0, (40 - Math.min(o1, o2)) / 30));
  return Math.min(1, separation * 0.67 + extreme * 0.33);
}

/** The most recent divergence, if any — what the analysis stage reports. */
export function latestDivergence(divergences: readonly Divergence[]): Divergence | null {
  return divergences.length ? divergences[divergences.length - 1] : null;
}
