import type { Candle } from "@/lib/market/types";

/**
 * Pure technical primitives.
 *
 * Every function returns a line aligned index-for-index with its input, using
 * `null` for bars where the indicator is not yet defined. Nothing here is
 * allowed to silently shorten a series — misalignment between an indicator and
 * its price bars is the classic way a backtest lies to you.
 */

export type Line = (number | null)[];

export function last(line: Line): number | null {
  for (let i = line.length - 1; i >= 0; i--) {
    const v = line[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

/** Value `n` bars back from the end, skipping nothing. */
export function at(line: Line, fromEnd: number): number | null {
  const i = line.length - 1 - fromEnd;
  if (i < 0 || i >= line.length) return null;
  const v = line[i];
  return v !== null && Number.isFinite(v) ? v : null;
}

export const closes = (c: Candle[]) => c.map((x) => x.c);
export const highs = (c: Candle[]) => c.map((x) => x.h);
export const lows = (c: Candle[]) => c.map((x) => x.l);
export const volumes = (c: Candle[]) => c.map((x) => x.v);

export function sma(values: number[], period: number): Line {
  const out: Line = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): Line {
  const out: Line = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` values — the standard convention.
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (used by RSI, ATR and ADX — not the same as an EMA). */
function wilder(values: number[], period: number): Line {
  const out: Line = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function rsi(values: number[], period = 14): Line {
  const out: Line = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }

  const avgGain = wilder(gains.slice(1), period);
  const avgLoss = wilder(losses.slice(1), period);

  for (let i = 0; i < avgGain.length; i++) {
    const g = avgGain[i];
    const l = avgLoss[i];
    if (g === null || l === null) continue;
    // A period with no losses is defined as 100, not a division by zero.
    out[i + 1] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

export type MacdResult = { macd: Line; signal: Line; histogram: Line };

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const fastLine = ema(values, fast);
  const slowLine = ema(values, slow);
  const macdLine: Line = values.map((_, i) => {
    const f = fastLine[i];
    const s = slowLine[i];
    return f !== null && s !== null ? f - s : null;
  });

  // The signal EMA runs only over the defined part of the MACD line.
  const firstDefined = macdLine.findIndex((v) => v !== null);
  const dense = firstDefined === -1 ? [] : (macdLine.slice(firstDefined) as number[]);
  const signalDense = ema(dense, signalPeriod);

  const signal: Line = new Array(values.length).fill(null);
  if (firstDefined !== -1) {
    for (let i = 0; i < signalDense.length; i++) signal[firstDefined + i] = signalDense[i];
  }

  const histogram: Line = values.map((_, i) => {
    const m = macdLine[i];
    const s = signal[i];
    return m !== null && s !== null ? m - s : null;
  });

  return { macd: macdLine, signal, histogram };
}

/** True range per bar — the basis for ATR and every volatility-scaled stop. */
export function trueRange(candles: Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const prevClose = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose));
  });
}

export function atr(candles: Candle[], period = 14): Line {
  return wilder(trueRange(candles), period);
}

/** ATR as a percentage of price — comparable across assets of any price. */
export function atrPercent(candles: Candle[], period = 14): Line {
  const a = atr(candles, period);
  return a.map((v, i) => (v === null ? null : (v / candles[i].c) * 100));
}

export type Bollinger = { upper: Line; middle: Line; lower: Line; width: Line };

export function bollinger(values: number[], period = 20, mult = 2): Bollinger {
  const middle = sma(values, period);
  const upper: Line = new Array(values.length).fill(null);
  const lower: Line = new Array(values.length).fill(null);
  const width: Line = new Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i++) {
    const m = middle[i];
    if (m === null) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (values[j] - m) ** 2;
    const sd = Math.sqrt(variance / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
    width[i] = m !== 0 ? ((upper[i]! - lower[i]!) / m) * 100 : null;
  }
  return { upper, middle, lower, width };
}

/** ADX with directional indicators — trend *strength*, direction-agnostic. */
export type Adx = { adx: Line; plusDi: Line; minusDi: Line };

export function adx(candles: Candle[], period = 14): Adx {
  const n = candles.length;
  const empty: Line = new Array(n).fill(null);
  if (n < period * 2) return { adx: empty, plusDi: [...empty], minusDi: [...empty] };

  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  for (let i = 1; i < n; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const down = candles[i - 1].l - candles[i].l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }

  const tr = trueRange(candles);
  const smTr = wilder(tr.slice(1), period);
  const smPlus = wilder(plusDM.slice(1), period);
  const smMinus = wilder(minusDM.slice(1), period);

  const plusDi: Line = new Array(n).fill(null);
  const minusDi: Line = new Array(n).fill(null);
  const dx: number[] = [];
  const dxIndex: number[] = [];

  for (let i = 0; i < smTr.length; i++) {
    const t = smTr[i];
    const p = smPlus[i];
    const m = smMinus[i];
    if (t === null || p === null || m === null || t === 0) continue;
    const pdi = (p / t) * 100;
    const mdi = (m / t) * 100;
    plusDi[i + 1] = pdi;
    minusDi[i + 1] = mdi;
    const sum = pdi + mdi;
    if (sum > 0) {
      dx.push((Math.abs(pdi - mdi) / sum) * 100);
      dxIndex.push(i + 1);
    }
  }

  const adxDense = wilder(dx, period);
  const adxLine: Line = new Array(n).fill(null);
  for (let i = 0; i < adxDense.length; i++) {
    if (adxDense[i] !== null) adxLine[dxIndex[i]] = adxDense[i];
  }

  return { adx: adxLine, plusDi, minusDi };
}

/** Stochastic RSI — reaches its extremes far more often than plain RSI. */
export function stochRsi(values: number[], rsiPeriod = 14, stochPeriod = 14): Line {
  const r = rsi(values, rsiPeriod);
  const out: Line = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (r[i] === null) continue;
    const window: number[] = [];
    for (let j = Math.max(0, i - stochPeriod + 1); j <= i; j++) {
      if (r[j] !== null) window.push(r[j]!);
    }
    if (window.length < stochPeriod) continue;
    const lo = Math.min(...window);
    const hi = Math.max(...window);
    out[i] = hi === lo ? 50 : ((r[i]! - lo) / (hi - lo)) * 100;
  }
  return out;
}

/** On-balance volume — does volume confirm the direction of the move? */
export function obv(candles: Candle[]): Line {
  const out: Line = new Array(candles.length).fill(null);
  let running = 0;
  out[0] = 0;
  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i].c - candles[i - 1].c;
    running += diff > 0 ? candles[i].v : diff < 0 ? -candles[i].v : 0;
    out[i] = running;
  }
  return out;
}

/** Rolling VWAP — the volume-weighted level most desks anchor to. */
export function vwap(candles: Candle[], period = 24): Line {
  const out: Line = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let pv = 0;
    let vol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const typical = (candles[j].h + candles[j].l + candles[j].c) / 3;
      pv += typical * candles[j].v;
      vol += candles[j].v;
    }
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

/**
 * Percent rank of the latest value within its own history (0–100).
 *
 * Returns null when the distribution has no meaningful spread. Ranking a
 * near-flat line puts the last value at the 100th percentile on nothing but
 * rounding noise, which downstream would read as an extreme — a calm market
 * reported as a shock.
 */
export function percentRank(line: Line, lookback = 100): number | null {
  const values = line.filter((v): v is number => v !== null).slice(-lookback);
  if (values.length < 10) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const scale = Math.abs(hi) + Math.abs(lo);
  if (scale === 0 || (hi - lo) / scale < 1e-6) return null;
  const current = values[values.length - 1];
  const below = values.filter((v) => v < current).length;
  return (below / (values.length - 1)) * 100;
}

/** Median of the defined values in a line. */
export function median(line: Line, lookback = 120): number | null {
  const values = line
    .filter((v): v is number => v !== null)
    .slice(-lookback)
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/** Annualised realised volatility from log returns, in percent. */
export function realizedVolatility(values: number[], period = 30, barsPerYear = 8760): number | null {
  if (values.length < period + 1) return null;
  const window = values.slice(-(period + 1));
  const rets: number[] = [];
  for (let i = 1; i < window.length; i++) {
    if (window[i - 1] > 0) rets.push(Math.log(window[i] / window[i - 1]));
  }
  if (rets.length < 5) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(barsPerYear) * 100;
}

/** Pearson correlation — how much of an alt's move is really just Bitcoin. */
export function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 20) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const rx: number[] = [];
  const ry: number[] = [];
  for (let i = 1; i < n; i++) {
    if (x[i - 1] > 0 && y[i - 1] > 0) {
      rx.push(Math.log(x[i] / x[i - 1]));
      ry.push(Math.log(y[i] / y[i - 1]));
    }
  }
  if (rx.length < 15) return null;
  const mx = rx.reduce((s, v) => s + v, 0) / rx.length;
  const my = ry.reduce((s, v) => s + v, 0) / ry.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  // A series with no meaningful return variance (a peg, a stalled feed, a
  // synthetic straight line) makes correlation undefined. Guarding only
  // against an exact zero lets floating-point noise through as a confident
  // reading, which would then feed a real position-sizing decision.
  if (!Number.isFinite(den) || den < 1e-12) return null;
  return num / den;
}
