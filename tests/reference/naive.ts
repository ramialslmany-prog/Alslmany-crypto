/**
 * INDEPENDENT reference implementations, written straight from each
 * indicator's textbook definition.
 *
 * These are deliberately slow, allocation-happy and obvious — recomputing
 * whole windows, no rolling sums, no shared helpers with `src/`. That is the
 * point: the production code is incremental and stateful, which is where
 * off-by-one and stale-accumulator bugs live. If two implementations written
 * from different angles agree on every bar of a 600-bar series, the fast one
 * is almost certainly right.
 *
 * The golden file is generated from THESE, never from src/. A bug copied into
 * both would defeat the exercise, so nothing here imports from src/.
 */

const nan = (n: number): number[] => new Array<number>(n).fill(NaN);

export interface RefCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime: number;
}

/** Mean of a window, computed from scratch every time. */
export function naiveSma(v: readonly number[], p: number): number[] {
  const out = nan(v.length);
  for (let i = p - 1; i < v.length; i++) {
    const window = v.slice(i - p + 1, i + 1);
    if (window.some((x) => !Number.isFinite(x))) continue;
    out[i] = window.reduce((a, b) => a + b, 0) / p;
  }
  return out;
}

/**
 * EMA from the definition: seed with the SMA of the first p finite values,
 * then apply the recurrence one bar at a time.
 */
export function naiveEma(v: readonly number[], p: number): number[] {
  const out = nan(v.length);
  const k = 2 / (p + 1);
  const finiteIdx: number[] = [];
  for (let i = 0; i < v.length; i++) if (Number.isFinite(v[i])) finiteIdx.push(i);
  if (finiteIdx.length < p) return out;

  const seedIdx = finiteIdx[p - 1];
  let prev = finiteIdx.slice(0, p).reduce((a, i) => a + v[i], 0) / p;
  out[seedIdx] = prev;

  for (const i of finiteIdx.slice(p)) {
    prev = v[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RMA: same shape as EMA but alpha = 1/p. */
export function naiveRma(v: readonly number[], p: number): number[] {
  const out = nan(v.length);
  const a = 1 / p;
  const finiteIdx: number[] = [];
  for (let i = 0; i < v.length; i++) if (Number.isFinite(v[i])) finiteIdx.push(i);
  if (finiteIdx.length < p) return out;

  const seedIdx = finiteIdx[p - 1];
  let prev = finiteIdx.slice(0, p).reduce((acc, i) => acc + v[i], 0) / p;
  out[seedIdx] = prev;

  for (const i of finiteIdx.slice(p)) {
    prev = v[i] * a + prev * (1 - a);
    out[i] = prev;
  }
  return out;
}

export function naiveWma(v: readonly number[], p: number): number[] {
  const out = nan(v.length);
  const denom = (p * (p + 1)) / 2;
  for (let i = p - 1; i < v.length; i++) {
    const w = v.slice(i - p + 1, i + 1);
    if (w.some((x) => !Number.isFinite(x))) continue;
    out[i] = w.reduce((acc, x, k) => acc + x * (k + 1), 0) / denom;
  }
  return out;
}

/** RSI = 100 - 100/(1 + avgGain/avgLoss), averages being Wilder's. */
export function naiveRsi(v: readonly number[], p = 14): number[] {
  const gains = nan(v.length);
  const losses = nan(v.length);
  for (let i = 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }
  const ag = naiveRma(gains, p);
  const al = naiveRma(losses, p);

  const out = nan(v.length);
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(ag[i]) || !Number.isFinite(al[i])) continue;
    if (al[i] === 0) {
      out[i] = ag[i] === 0 ? 50 : 100;
      continue;
    }
    out[i] = 100 - 100 / (1 + ag[i] / al[i]);
  }
  return out;
}

export function naiveMacd(v: readonly number[], fast = 12, slow = 26, sig = 9) {
  const f = naiveEma(v, fast);
  const s = naiveEma(v, slow);
  const line = nan(v.length);
  for (let i = 0; i < v.length; i++) {
    if (Number.isFinite(f[i]) && Number.isFinite(s[i])) line[i] = f[i] - s[i];
  }
  const signal = naiveEma(line, sig);
  const hist = nan(v.length);
  for (let i = 0; i < v.length; i++) {
    if (Number.isFinite(line[i]) && Number.isFinite(signal[i])) hist[i] = line[i] - signal[i];
  }
  return { macd: line, signal, histogram: hist };
}

/** Population standard deviation, recomputed per window. */
export function naiveStdev(v: readonly number[], p: number): number[] {
  const out = nan(v.length);
  for (let i = p - 1; i < v.length; i++) {
    const w = v.slice(i - p + 1, i + 1);
    if (w.some((x) => !Number.isFinite(x))) continue;
    const mean = w.reduce((a, b) => a + b, 0) / p;
    out[i] = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / p);
  }
  return out;
}

export function naiveBollinger(v: readonly number[], p = 20, mult = 2) {
  const mid = naiveSma(v, p);
  const sd = naiveStdev(v, p);
  const upper = nan(v.length);
  const lower = nan(v.length);
  const bandwidth = nan(v.length);
  const percentB = nan(v.length);
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(mid[i]) || !Number.isFinite(sd[i])) continue;
    upper[i] = mid[i] + mult * sd[i];
    lower[i] = mid[i] - mult * sd[i];
    if (mid[i] !== 0) bandwidth[i] = (upper[i] - lower[i]) / mid[i];
    const span = upper[i] - lower[i];
    percentB[i] = span === 0 ? 0.5 : (v[i] - lower[i]) / span;
  }
  return { upper, middle: mid, lower, bandwidth, percentB };
}

export function naiveTrueRange(c: readonly RefCandle[]): number[] {
  const out = nan(c.length);
  for (let i = 0; i < c.length; i++) {
    if (i === 0) {
      out[i] = c[i].high - c[i].low;
      continue;
    }
    const pc = c[i - 1].close;
    out[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - pc), Math.abs(c[i].low - pc));
  }
  return out;
}

export function naiveAtr(c: readonly RefCandle[], p = 14): number[] {
  return naiveRma(naiveTrueRange(c), p);
}

export function naiveStochastic(c: readonly RefCandle[], p = 14, sk = 3, sd = 3) {
  const raw = nan(c.length);
  for (let i = p - 1; i < c.length; i++) {
    const w = c.slice(i - p + 1, i + 1);
    const hh = Math.max(...w.map((x) => x.high));
    const ll = Math.min(...w.map((x) => x.low));
    raw[i] = hh === ll ? 50 : ((c[i].close - ll) / (hh - ll)) * 100;
  }
  const k = sk > 1 ? naiveSma(raw, sk) : raw;
  return { k, d: naiveSma(k, sd) };
}

export function naiveObv(c: readonly RefCandle[]): number[] {
  const out = nan(c.length);
  if (c.length === 0) return out;
  out[0] = 0;
  let acc = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i].close - c[i - 1].close;
    acc += d > 0 ? c[i].volume : d < 0 ? -c[i].volume : 0;
    out[i] = acc;
  }
  return out;
}

/** Session VWAP, resetting whenever the UTC day changes. */
export function naiveVwap(c: readonly RefCandle[], intraday: boolean): number[] {
  const out = nan(c.length);
  let day = NaN;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < c.length; i++) {
    const d = intraday ? Math.floor(c[i].openTime / 86_400_000) : 0;
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const tp = (c[i].high + c[i].low + c[i].close) / 3;
    pv += tp * c[i].volume;
    vol += c[i].volume;
    out[i] = vol > 0 ? pv / vol : tp;
  }
  return out;
}

export function naiveAdx(c: readonly RefCandle[], p = 14) {
  const plusDm = nan(c.length);
  const minusDm = nan(c.length);
  for (let i = 1; i < c.length; i++) {
    const up = c[i].high - c[i - 1].high;
    const dn = c[i - 1].low - c[i].low;
    plusDm[i] = up > dn && up > 0 ? up : 0;
    minusDm[i] = dn > up && dn > 0 ? dn : 0;
  }
  const tr = naiveTrueRange(c);
  const trFrom1 = nan(c.length);
  for (let i = 1; i < c.length; i++) trFrom1[i] = tr[i];

  const str = naiveRma(trFrom1, p);
  const sp = naiveRma(plusDm, p);
  const sm = naiveRma(minusDm, p);

  const plusDi = nan(c.length);
  const minusDi = nan(c.length);
  const dx = nan(c.length);
  for (let i = 0; i < c.length; i++) {
    if (!Number.isFinite(str[i]) || str[i] === 0) continue;
    if (!Number.isFinite(sp[i]) || !Number.isFinite(sm[i])) continue;
    plusDi[i] = (100 * sp[i]) / str[i];
    minusDi[i] = (100 * sm[i]) / str[i];
    const s = plusDi[i] + minusDi[i];
    dx[i] = s === 0 ? 0 : (100 * Math.abs(plusDi[i] - minusDi[i])) / s;
  }
  return { adx: naiveRma(dx, p), plusDi, minusDi };
}

export function naiveIchimoku(c: readonly RefCandle[], cp = 9, bp = 26, sp = 52, disp = 26) {
  const mid = (p: number): number[] => {
    const out = nan(c.length);
    for (let i = p - 1; i < c.length; i++) {
      const w = c.slice(i - p + 1, i + 1);
      out[i] = (Math.max(...w.map((x) => x.high)) + Math.min(...w.map((x) => x.low))) / 2;
    }
    return out;
  };
  const conversion = mid(cp);
  const base = mid(bp);
  const rawA = nan(c.length);
  for (let i = 0; i < c.length; i++) {
    if (Number.isFinite(conversion[i]) && Number.isFinite(base[i])) {
      rawA[i] = (conversion[i] + base[i]) / 2;
    }
  }
  const rawB = mid(sp);

  const shiftFwd = (v: number[], by: number): number[] => {
    const out = nan(v.length);
    for (let i = 0; i < v.length; i++) {
      const s = i - by;
      if (s >= 0 && s < v.length) out[i] = v[s];
    }
    return out;
  };

  const leadingSpanA = shiftFwd(rawA, disp);
  const leadingSpanB = shiftFwd(rawB, disp);
  const laggingSpan = shiftFwd(c.map((x) => x.close), -disp);

  const cloudTop = nan(c.length);
  const cloudBottom = nan(c.length);
  for (let i = 0; i < c.length; i++) {
    if (Number.isFinite(leadingSpanA[i]) && Number.isFinite(leadingSpanB[i])) {
      cloudTop[i] = Math.max(leadingSpanA[i], leadingSpanB[i]);
      cloudBottom[i] = Math.min(leadingSpanA[i], leadingSpanB[i]);
    }
  }
  return { conversion, base, leadingSpanA, leadingSpanB, laggingSpan, cloudTop, cloudBottom };
}

export function naiveMfi(c: readonly RefCandle[], p = 14): number[] {
  const out = nan(c.length);
  const tp = c.map((x) => (x.high + x.low + x.close) / 3);
  for (let i = p; i < c.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const flow = tp[j] * c[j].volume;
      if (tp[j] > tp[j - 1]) pos += flow;
      else if (tp[j] < tp[j - 1]) neg += flow;
    }
    out[i] = neg === 0 ? (pos === 0 ? 50 : 100) : 100 - 100 / (1 + pos / neg);
  }
  return out;
}
