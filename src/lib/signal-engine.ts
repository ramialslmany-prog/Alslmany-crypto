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
  vwap: number;
  volRatio: number;
  volConfirmed: boolean;
  structure: "BOS up" | "BOS down" | "CHoCH bull" | "CHoCH bear" | "ranging";
  fvg: "bull" | "bear" | null;
  bias: number;
  bull: string[];
  bear: string[];
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

  const a = last(atr(c, 14));
  const atrPct = (a / close) * 100;
  const vw = last(vwap(c));

  const volAvg = last(sma(vols, 20)) || vols[vols.length - 1];
  const volRatio = volAvg > 0 ? last(vols) / volAvg : 1;
  const volConfirmed = volRatio >= 1.2;

  // Market structure (SMC): break of the most recent opposing swing.
  const sw = swings(c, 2);
  const lastHigh = sw.highs.length ? last(sw.highs).price : Math.max(...c.slice(-20).map((x) => x.h));
  const lastLow = sw.lows.length ? last(sw.lows).price : Math.min(...c.slice(-20).map((x) => x.l));
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
    bbPctB, atr: a, atrPct, vwap: vw, volRatio, volConfirmed,
    structure, fvg, bias, bull, bear,
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
  const healthyDip = ltf.rsi >= 40 && ltf.rsi <= 64 && ltf.bbPctB <= 0.7;

  if (uptrend && overbought && fading) return "SHORT"; // take profit at the top
  if (uptrend && extended) return "NEUTRAL"; // don't chase — hold / wait for a dip
  if (uptrend && healthyDip && combined > 0.5) return "LONG"; // buy the dip
  if (!uptrend && ltf.structure === "CHoCH bull" && combined > 1.5) return "LONG"; // early reversal
  if (ltf.trend === "down" && combined <= -2.2) return "SHORT"; // breakdown — exit / avoid
  return "NEUTRAL";
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
  confidence = Math.round(clamp(confidence));

  const entry = ltf.close;
  // Bounded, logical risk: cap volatility → sensible stop % → clean R-multiples.
  const atrPctLtf = (ltf.atr / entry) * 100;
  const volPct = Math.min(Math.max(atrPctLtf, 0.5), 5);
  const stopPct = market === "spot" ? Math.min(Math.max(volPct * 1.5, 2), 6) : Math.min(Math.max(volPct * 1.2, 1), 4);
  const riskUnit = (stopPct / 100) * entry;
  const tp = [1.5, 2.5, 4]; // reward:risk multiples
  const reasons: string[] = [];
  let stop: number;
  let targets: number[];

  if (signal === "LONG") {
    stop = entry - riskUnit;
    targets = [entry + riskUnit * tp[0], entry + riskUnit * tp[1], entry + riskUnit * tp[2]];
    reasons.push(...ltf.bull);
  } else if (signal === "SHORT") {
    stop = entry + riskUnit;
    targets = [entry - riskUnit * tp[0], entry - riskUnit * tp[1], entry - riskUnit * tp[2]];
    reasons.push(...ltf.bear);
  } else {
    stop = entry - riskUnit;
    targets = [entry + riskUnit, entry + riskUnit * 2, entry + riskUnit * 3];
    reasons.push("No high-confluence setup — confirmations are mixed");
  }

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

  const riskLevel: RiskLevel =
    ltf.atrPct > 3 || confidence < 55 ? "High" : ltf.atrPct > 1.4 || confidence < 72 ? "Medium" : "Low";

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
