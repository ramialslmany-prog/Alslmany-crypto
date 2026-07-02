/**
 * Rule-based (NON-AI) trading recommendation engine.
 *
 * Deterministic technical analysis only — no model, no black box. Every
 * recommendation is the sum of explicit, weighted confluences (trend, momentum,
 * structure, volume, volatility) and ships with the exact reasons that produced
 * it. A higher-timeframe analysis gates the lower-timeframe trigger so we don't
 * fight the dominant trend. This is intentionally auditable.
 */
import type { Candle, Interval } from "@/lib/candles";
import { sma, ema, rsi, macd, bollinger, atr, vwap, swings, findFVG, last } from "@/lib/indicators";

export type Direction = "LONG" | "SHORT" | "NEUTRAL";
export type Style = "scalp" | "day" | "swing";
export type Market = "spot" | "futures";
export type RiskLevel = "Low" | "Medium" | "High";

/**
 * Translation key for a signal label, by market.
 * Spot traders don't short, so LONG→BUY, SHORT→SELL (exit/avoid), NEUTRAL→WAIT.
 */
export function signalLabelKey(signal: Direction, market: Market): string {
  if (market === "futures") return `dir.${signal}`;
  return signal === "LONG" ? "dir.BUY" : signal === "SHORT" ? "dir.SELL" : "dir.WAIT";
}

export interface TFAnalysis {
  interval: Interval;
  close: number;
  trend: "up" | "down" | "range";
  rsi: number;
  macdHist: number;
  macdCross: "bull" | "bear" | null;
  bbPctB: number;
  atr: number;
  atrPct: number;
  volPctile: number; // current ATR's percentile within THIS coin's own history (0..1)
  vwap: number;
  volRatio: number;
  volConfirmed: boolean;
  structure: "BOS up" | "BOS down" | "CHoCH bull" | "CHoCH bear" | "ranging";
  fvg: "bull" | "bear" | null;
  bias: number;
  bull: string[];
  bear: string[];
  swingHighs: number[]; // recent fractal resistance levels (price)
  swingLows: number[]; // recent fractal support levels (price)
}

export interface Recommendation {
  symbol: string;
  style: Style;
  market: Market;
  signal: Direction;
  confidence: number;
  entry: number;
  stop: number;
  targets: number[];
  riskReward: number;
  riskLevel: RiskLevel;
  trend: "up" | "down" | "range";
  leverage: string;
  ltf: Interval;
  htf: Interval;
  candleSource: string;
  reasons: string[];
  indicators: { rsi: number; macdHist: number; atrPct: number; volRatio: number; bbPctB: number };
  generatedAt: number;
}

/**
 * Quality score for ranking best→worst. Actionable setups always outrank
 * no-trade ones; among actionable, higher confidence and reward:risk win.
 */
export function qualityScore(rec: { signal: Direction; confidence: number; riskReward: number }): number {
  if (rec.signal === "NEUTRAL") return rec.confidence * 0.2;
  return 1000 + rec.confidence + Math.min(25, rec.riskReward * 5);
}

export const STYLE_TF: Record<Style, { ltf: Interval; htf: Interval }> = {
  scalp: { ltf: "15m", htf: "1h" },
  day: { ltf: "1h", htf: "4h" },
  swing: { ltf: "4h", htf: "1d" },
};

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

/** Analyze one timeframe into a signed confluence bias + reasons. */
export function analyzeTimeframe(interval: Interval, c: Candle[]): TFAnalysis {
  const closes = c.map((x) => x.c);
  const vols = c.map((x) => x.v);
  const close = last(closes);

  const e20 = last(ema(closes, 20));
  const e50 = last(ema(closes, 50));
  const e200 = ema(closes, 200);
  const e200v = last(e200);
  const r = last(rsi(closes, 14));
  const m = macd(closes);
  const mHist = last(m.hist);
  const mLine = last(m.line);
  const mSignal = last(m.signal);
  const mPrevLine = m.line[m.line.length - 2];
  const mPrevSignal = m.signal[m.signal.length - 2];
  const macdCross: "bull" | "bear" | null =
    Number.isFinite(mPrevLine) && Number.isFinite(mPrevSignal)
      ? mPrevLine <= mPrevSignal && mLine > mSignal
        ? "bull"
        : mPrevLine >= mPrevSignal && mLine < mSignal
          ? "bear"
          : null
      : null;

  const bb = bollinger(closes, 20, 2);
  const bbUpper = last(bb.upper);
  const bbLower = last(bb.lower);
  const bbPctB = bbUpper > bbLower ? (close - bbLower) / (bbUpper - bbLower) : 0.5;

  // Volatility measured against the coin's OWN history (percentile), not a
  // universal cutoff — a 4% day is calm for a high-beta alt, chaos for BTC.
  const atrSeries = atr(c, 14).filter((v) => Number.isFinite(v) && v > 0);
  const a = atrSeries.length ? atrSeries[atrSeries.length - 1] : 0;
  const atrPct = close > 0 ? (a / close) * 100 : 1;
  const volPctile = atrSeries.length > 20 ? atrSeries.filter((v) => v <= a).length / atrSeries.length : 0.5;
  const vw = last(vwap(c));

  const volAvg = last(sma(vols, 20)) || vols[vols.length - 1];
  const volRatio = volAvg > 0 ? last(vols) / volAvg : 1;
  const volConfirmed = volRatio >= 1.2;

  // Market structure (SMC): break of the most recent opposing swing.
  const sw = swings(c, 2);
  const lastHigh = sw.highs.length ? last(sw.highs).price : Math.max(...c.slice(-20).map((x) => x.h));
  const lastLow = sw.lows.length ? last(sw.lows).price : Math.min(...c.slice(-20).map((x) => x.l));
  // Recent fractal levels → real support/resistance for the trade plan.
  const swingHighs = sw.highs.slice(-10).map((h) => h.price);
  const swingLows = sw.lows.slice(-10).map((l) => l.price);
  const emaTrend: "up" | "down" | "range" =
    Number.isFinite(e200v) && e20 > e50 && e50 > e200v && close > e50
      ? "up"
      : Number.isFinite(e200v) && e20 < e50 && e50 < e200v && close < e50
        ? "down"
        : "range";

  let structure: TFAnalysis["structure"] = "ranging";
  if (close > lastHigh) structure = emaTrend === "down" ? "CHoCH bull" : "BOS up";
  else if (close < lastLow) structure = emaTrend === "up" ? "CHoCH bear" : "BOS down";

  const fvgObj = findFVG(c, 12);
  const fvg = fvgObj?.type ?? null;

  // ---- Confluence scoring ----
  let bias = 0;
  const bull: string[] = [];
  const bear: string[] = [];

  // Trend (EMA stack)
  if (emaTrend === "up") {
    bias += 2;
    bull.push("EMA 20>50>200 — uptrend stack");
  } else if (emaTrend === "down") {
    bias -= 2;
    bear.push("EMA 20<50<200 — downtrend stack");
  }

  // Momentum (RSI)
  if (r >= 55 && r < 70) {
    bias += 1;
    bull.push(`RSI ${r.toFixed(0)} — bullish momentum`);
  } else if (r > 70) {
    bias -= 0.5;
    bear.push(`RSI ${r.toFixed(0)} — overbought`);
  } else if (r <= 45 && r > 30) {
    bias -= 1;
    bear.push(`RSI ${r.toFixed(0)} — bearish momentum`);
  } else if (r <= 30) {
    bias += 0.5;
    bull.push(`RSI ${r.toFixed(0)} — oversold bounce risk`);
  }

  // MACD
  if (macdCross === "bull" || mHist > 0) {
    bias += 1;
    bull.push(macdCross === "bull" ? "MACD bullish cross" : "MACD histogram positive");
  } else if (macdCross === "bear" || mHist < 0) {
    bias -= 1;
    bear.push(macdCross === "bear" ? "MACD bearish cross" : "MACD histogram negative");
  }

  // VWAP
  if (close > vw) {
    bias += 0.5;
    bull.push("Price above VWAP");
  } else {
    bias -= 0.5;
    bear.push("Price below VWAP");
  }

  // Bollinger position
  if (bbPctB > 0.5) bias += 0.5;
  else bias -= 0.5;

  // Structure
  if (structure === "BOS up") {
    bias += 1.5;
    bull.push("Break of structure (up)");
  } else if (structure === "CHoCH bull") {
    bias += 1;
    bull.push("Change of character — bullish reversal");
  } else if (structure === "BOS down") {
    bias -= 1.5;
    bear.push("Break of structure (down)");
  } else if (structure === "CHoCH bear") {
    bias -= 1;
    bear.push("Change of character — bearish reversal");
  }

  // Fair value gap
  if (fvg === "bull") {
    bias += 0.5;
    bull.push("Bullish fair-value gap below");
  } else if (fvg === "bear") {
    bias -= 0.5;
    bear.push("Bearish fair-value gap above");
  }

  // Volume confirmation amplifies the dominant side
  if (volConfirmed) {
    bias *= 1.12;
    (bias >= 0 ? bull : bear).push(`Volume +${((volRatio - 1) * 100).toFixed(0)}% vs 20-avg — confirmed`);
  }

  return {
    interval, close, trend: emaTrend, rsi: r, macdHist: mHist, macdCross,
    bbPctB, atr: a, atrPct, volPctile, vwap: vw, volRatio, volConfirmed,
    structure, fvg, bias, bull, bear, swingHighs, swingLows,
  };
}

/**
 * Practical spot model. Spot traders can only buy and sell (no shorting), so:
 *  • BUY  → buy the dip inside a confirmed uptrend (good entry, not the top), or
 *           an early entry on a clean bullish reversal.
 *  • SELL → take profit / exit when overbought & momentum fades, or on a breakdown.
 *  • WAIT → uptrend but extended (don't chase), or no clean setup.
 */
function spotDecision(ltf: TFAnalysis, htf: TFAnalysis, combined: number): Direction {
  const uptrend = htf.trend === "up" || ltf.trend === "up";
  const overbought = ltf.rsi >= 70;
  const extended = ltf.bbPctB >= 0.8;
  const fading = ltf.macdHist < 0;
  // Per-asset dip zone: high-beta coins routinely dip deeper inside healthy
  // uptrends; calm majors don't — the buy zone breathes with THIS coin's ATR.
  const dipLo = ltf.atrPct >= 2.5 ? 35 : ltf.atrPct <= 0.8 ? 42 : 40;
  const healthyDip = ltf.rsi >= dipLo && ltf.rsi <= 64 && ltf.bbPctB <= 0.7;

  if (uptrend && overbought && fading) return "SHORT"; // take profit at the top
  if (uptrend && extended) return "NEUTRAL"; // don't chase — hold / wait for a dip
  if (uptrend && healthyDip && combined > 0.5) return "LONG"; // buy the dip
  if (!uptrend && ltf.structure === "CHoCH bull" && combined > 1.5) return "LONG"; // early reversal
  if (ltf.trend === "down" && combined <= -2.2) return "SHORT"; // breakdown — exit / avoid
  return "NEUTRAL";
}

/**
 * Structure-aware trade plan. The stop sits just beyond the nearest real swing
 * (support for longs / resistance for shorts), bounded by ATR and a hard risk
 * cap. Targets are anchored to ACTUAL swing levels in the trade's direction
 * (each must clear 1R and be spaced so they aren't clustered) — so the distances
 * VARY per coin instead of a fixed R-multiple ladder. Only when price is in clear
 * air ahead does it fall back to measured extensions. A stable 3-level ladder is
 * kept (TP1→breakeven, TP2→trail, TP3→exit), but each level is whatever the chart
 * actually offers — which is the whole point. R:R is computed from the real TP1.
 */
export function tradePlan(
  dir: "long" | "short",
  entry: number,
  atr: number,
  swingHighs: number[],
  swingLows: number[],
  market: Market
): { stop: number; targets: number[] } {
  const atrAbs = Math.max(atr, entry * 0.003);
  // Per-asset calibration: the stop bounds breathe with THIS coin's own
  // volatility instead of one fixed % for every coin. A calm major gets tight
  // discipline; a high-beta alt gets the room its normal swings demand.
  const atrPct = atrAbs / entry;
  const minStop = entry * Math.min(Math.max(atrPct * 1.0, market === "spot" ? 0.01 : 0.006), market === "spot" ? 0.05 : 0.035);
  const maxStop = entry * Math.min(Math.max(atrPct * 5.0, market === "spot" ? 0.05 : 0.035), market === "spot" ? 0.13 : 0.09);
  const buf = atrAbs * 0.3;
  const clampR = (r: number) => Math.min(Math.max(r, minStop), maxStop);

  if (dir === "long") {
    const supports = swingLows.filter((p) => p < entry).sort((a, b) => b - a); // nearest below first
    const R = clampR(supports.length ? entry - (supports[0] - buf) : atrAbs * 1.4);
    const stop = entry - R;
    const targets: number[] = [];
    for (const r of swingHighs.filter((p) => p > entry).sort((a, b) => a - b)) {
      if (targets.length >= 3) break;
      if ((r - entry) / R < 1) continue; // worthwhile target ≥ 1R
      if (targets.length && r < targets[targets.length - 1] + R * 0.6) continue; // not clustered
      targets.push(r);
    }
    // Keep a 3-level ladder: extend beyond the furthest structural target with a
    // measured move when the chart doesn't offer 3 clean resistances ahead.
    while (targets.length < 3) {
      if (!targets.length) { targets.push(entry + R * 1.6); continue; }
      const m = (targets[targets.length - 1] - entry) / R;
      targets.push(entry + R * (m + 1.4));
    }
    return { stop, targets };
  }

  const resist = swingHighs.filter((p) => p > entry).sort((a, b) => a - b); // nearest above first
  const R = clampR(resist.length ? resist[0] + buf - entry : atrAbs * 1.4);
  const stop = entry + R;
  const targets: number[] = [];
  for (const s of swingLows.filter((p) => p < entry).sort((a, b) => b - a)) {
    if (targets.length >= 3) break;
    if ((entry - s) / R < 1) continue;
    if (targets.length && s > targets[targets.length - 1] - R * 0.6) continue;
    targets.push(s);
  }
  while (targets.length < 3) {
    if (!targets.length) { targets.push(entry - R * 1.6); continue; }
    const m = (entry - targets[targets.length - 1]) / R;
    targets.push(entry - R * (m + 1.4));
  }
  return { stop, targets };
}

/** Combine a lower- and higher-timeframe analysis into a gated recommendation. */
export function buildRecommendation(
  symbol: string,
  style: Style,
  ltf: TFAnalysis,
  htf: TFAnalysis,
  candleSource: string,
  market: Market = "futures"
): Recommendation {
  // HTF gate: align the trigger with the dominant trend.
  const htfDir = htf.bias > 0.5 ? 1 : htf.bias < -0.5 ? -1 : 0;
  const ltfDir = ltf.bias > 0 ? 1 : ltf.bias < 0 ? -1 : 0;
  const aligned = htfDir !== 0 && htfDir === ltfDir;
  const conflict = htfDir !== 0 && ltfDir !== 0 && htfDir !== ltfDir;

  let combined = ltf.bias + (aligned ? Math.sign(ltf.bias) * 1.5 : 0);
  if (conflict) combined *= 0.4; // fighting the HTF trend — heavily discount

  // Futures: symmetric long/short. Spot: a practical buy-the-dip / take-profit model.
  const TH = 2.2;
  let signal: Direction =
    market === "spot"
      ? spotDecision(ltf, htf, combined)
      : combined >= TH
        ? "LONG"
        : combined <= -TH
          ? "SHORT"
          : "NEUTRAL";

  // Confidence from |combined|, alignment, and volume — calibrated to 0-100.
  let confidence = clamp(38 + Math.abs(combined) * 11);
  if (aligned) confidence += 8;
  if (conflict) confidence -= 14;
  if (ltf.volConfirmed) confidence += 5;
  // Volatility regime vs the coin's OWN norm: chaotic conditions cut edge;
  // unusually quiet, orderly conditions add a touch.
  if (ltf.volPctile >= 0.85) confidence -= 6;
  else if (ltf.volPctile <= 0.35) confidence += 3;
  confidence = Math.round(clamp(confidence));

  const entry = ltf.close;
  // Structure-aware plan: stop beyond real swings; targets at actual swing levels
  // (a variable 1–3, not a fixed R-multiple ladder). Combine LTF + HTF swings so
  // bigger higher-timeframe levels count too. NEUTRAL ("watch") is planned as a
  // long — these are the levels to watch for a dip entry.
  const sHighs = [...ltf.swingHighs, ...htf.swingHighs];
  const sLows = [...ltf.swingLows, ...htf.swingLows];
  const plan = tradePlan(signal === "SHORT" ? "short" : "long", entry, ltf.atr, sHighs, sLows, market);
  const stop = plan.stop;
  const targets = plan.targets;
  const reasons: string[] = [];
  if (signal === "LONG") reasons.push(...ltf.bull);
  else if (signal === "SHORT") reasons.push(...ltf.bear);
  else reasons.push("No high-confluence setup — confirmations are mixed");

  reasons.push(
    aligned
      ? `Higher timeframe (${htf.interval}) trend ${htf.trend} — aligned`
      : conflict
        ? `Higher timeframe (${htf.interval}) trend ${htf.trend} — conflicts, discounted`
        : `Higher timeframe (${htf.interval}) neutral`
  );

  if (market === "spot") {
    reasons.push(
      signal === "LONG"
        ? "Spot: buy-the-dip entry inside an uptrend (not chasing the top)"
        : signal === "SHORT"
          ? "Spot: take profit / exit — overbought or breaking down"
          : "Spot: wait — uptrend extended or no clean dip entry yet"
    );
  }

  const riskReward = Math.abs(targets[0] - entry) / Math.abs(entry - stop);

  // Risk graded RELATIVE to the coin's own volatility norm (percentile), plus an
  // absolute sanity bound — a 4% day is calm for a high-beta alt, chaos for BTC.
  const riskLevel: RiskLevel =
    ltf.volPctile >= 0.8 || ltf.atrPct > 4 || confidence < 55 ? "High" : ltf.atrPct > 1.6 || confidence < 72 ? "Medium" : "Low";
  if (ltf.volPctile >= 0.85) reasons.push("Volatility elevated vs this coin's own norm — wider stop, smaller size");

  // Leverage only applies to futures; spot is unleveraged buy/sell.
  const lev = Math.max(1, Math.min(10, Math.round(6 / Math.max(0.5, ltf.atrPct))));
  const leverage = market === "spot" || signal === "NEUTRAL" ? "—" : `${lev}x max`;

  return {
    symbol, style, market, signal, confidence,
    entry, stop, targets, riskReward,
    riskLevel, trend: ltf.trend, leverage,
    ltf: ltf.interval, htf: htf.interval, candleSource,
    reasons,
    indicators: { rsi: ltf.rsi, macdHist: ltf.macdHist, atrPct: ltf.atrPct, volRatio: ltf.volRatio, bbPctB: ltf.bbPctB },
    generatedAt: Date.now(),
  };
}
