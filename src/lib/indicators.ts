/**
 * Pure technical-analysis primitives. No dependencies, no side effects —
 * every function takes numbers and returns numbers, so they're trivially
 * testable and reusable across the signal engine, charts, and any worker.
 *
 * Arrays are returned same-length as the input, with `NaN` during the warmup
 * period so indices stay aligned with the source candles.
 */
import type { Candle } from "@/lib/candles";

export const last = <T>(a: T[]): T => a[a.length - 1];

export function sma(v: number[], p: number): number[] {
  const out = new Array(v.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= p) sum -= v[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

/** EMA that tolerates leading NaN (so it composes — e.g. EMA of the MACD line). */
export function ema(v: number[], p: number): number[] {
  const out = new Array(v.length).fill(NaN);
  const k = 2 / (p + 1);
  let prev = NaN;
  let seeded = false;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (!Number.isFinite(x)) continue;
    if (!seeded) {
      seedSum += x;
      seedCount++;
      if (seedCount === p) {
        prev = seedSum / p;
        out[i] = prev;
        seeded = true;
      }
    } else {
      prev = x * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(v: number[], p = 14): number[] {
  const out = new Array(v.length).fill(NaN);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < v.length; i++) {
    const ch = v[i] - v[i - 1];
    const gain = Math.max(0, ch);
    const loss = Math.max(0, -ch);
    if (i <= p) {
      avgGain += gain;
      avgLoss += loss;
      if (i === p) {
        avgGain /= p;
        avgLoss /= p;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (p - 1) + gain) / p;
      avgLoss = (avgLoss * (p - 1) + loss) / p;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

export function macd(v: number[], fast = 12, slow = 26, signalP = 9) {
  const ef = ema(v, fast);
  const es = ema(v, slow);
  const line = v.map((_, i) => (Number.isFinite(ef[i]) && Number.isFinite(es[i]) ? ef[i] - es[i] : NaN));
  const signal = ema(line, signalP);
  const hist = line.map((x, i) => (Number.isFinite(x) && Number.isFinite(signal[i]) ? x - signal[i] : NaN));
  return { line, signal, hist };
}

export function bollinger(v: number[], p = 20, k = 2) {
  const mid = sma(v, p);
  const upper = new Array(v.length).fill(NaN);
  const lower = new Array(v.length).fill(NaN);
  for (let i = p - 1; i < v.length; i++) {
    let sq = 0;
    for (let j = i - p + 1; j <= i; j++) sq += (v[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sq / p);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
  }
  return { mid, upper, lower };
}

/** Wilder's ATR on OHLC candles. */
export function atr(c: Candle[], p = 14): number[] {
  const tr = new Array(c.length).fill(NaN);
  for (let i = 0; i < c.length; i++) {
    tr[i] =
      i === 0
        ? c[i].h - c[i].l
        : Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
  }
  const out = new Array(c.length).fill(NaN);
  let prev = NaN;
  for (let i = 1; i < c.length; i++) {
    if (i === p) {
      let s = 0;
      for (let j = 1; j <= p; j++) s += tr[j];
      prev = s / p;
      out[i] = prev;
    } else if (i > p) {
      prev = (prev * (p - 1) + tr[i]) / p;
      out[i] = prev;
    }
  }
  return out;
}

/** Cumulative VWAP across the supplied window. */
export function vwap(c: Candle[]): number[] {
  const out = new Array(c.length).fill(NaN);
  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < c.length; i++) {
    const typical = (c[i].h + c[i].l + c[i].c) / 3;
    cumPV += typical * c[i].v;
    cumV += c[i].v;
    out[i] = cumV > 0 ? cumPV / cumV : NaN;
  }
  return out;
}

export function fibLevels(high: number, low: number) {
  const d = high - low;
  return {
    "0.0": high,
    "0.236": high - d * 0.236,
    "0.382": high - d * 0.382,
    "0.5": high - d * 0.5,
    "0.618": high - d * 0.618,
    "0.786": high - d * 0.786,
    "1.0": low,
  };
}

/** Pivot swing highs/lows (a high higher than `lb` bars on each side). */
export function swings(c: Candle[], lb = 2) {
  const highs: { i: number; price: number }[] = [];
  const lows: { i: number; price: number }[] = [];
  for (let i = lb; i < c.length - lb; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lb; j <= i + lb; j++) {
      if (j === i) continue;
      if (c[j].h >= c[i].h) isHigh = false;
      if (c[j].l <= c[i].l) isLow = false;
    }
    if (isHigh) highs.push({ i, price: c[i].h });
    if (isLow) lows.push({ i, price: c[i].l });
  }
  return { highs, lows };
}

/** Most recent bullish/bearish 3-candle fair-value gap, if any. */
export function findFVG(c: Candle[], lookback = 12): { type: "bull" | "bear"; top: number; bottom: number; i: number } | null {
  const start = Math.max(2, c.length - lookback);
  for (let i = c.length - 1; i >= start; i--) {
    if (c[i - 2].h < c[i].l) return { type: "bull", top: c[i].l, bottom: c[i - 2].h, i };
    if (c[i - 2].l > c[i].h) return { type: "bear", top: c[i - 2].l, bottom: c[i].h, i };
  }
  return null;
}
