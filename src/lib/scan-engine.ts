/**
 * Lightweight market scanner.
 *
 * Computes a full recommendation for EVERY coin from the 7-day hourly sparkline
 * we already fetched in /api/markets — zero extra network calls, so it scales to
 * hundreds of coins instantly. It reuses the same spot/futures philosophy as the
 * detailed klines engine (buy-the-dip in uptrends, take profit at extremes), but
 * on close-only data (ATR is approximated from close-to-close volatility).
 */
import type { Coin } from "@/lib/mock-data";
import { ema, rsi, macd, bollinger, last } from "@/lib/indicators";
import { isStable } from "@/lib/coin-meta";
import { tradePlan } from "@/lib/signal-engine";
import type { Recommendation, Style, Market, Direction, RiskLevel } from "@/lib/signal-engine";

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

function neutral(coin: Coin, style: Style, market: Market): Recommendation {
  const p = coin.price;
  const u = p * 0.02;
  return {
    symbol: coin.symbol, style, market, signal: "NEUTRAL", confidence: 0,
    entry: p, stop: p - u, targets: [p + u, p + u * 2, p + u * 3], riskReward: 1,
    riskLevel: "Medium", trend: "range", leverage: "—", ltf: "1h", htf: "1d",
    candleSource: "coingecko-7d", reasons: ["Insufficient data to scan"],
    indicators: { rsi: 50, macdHist: 0, atrPct: 1, volRatio: 1, bbPctB: 0.5 },
    generatedAt: Date.now(),
  };
}

/** Fractal swing levels from a close-only series — real structure for plans. */
export function closeSwings(closes: number[]): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 2; i < closes.length - 2; i++) {
    let isHi = true;
    let isLo = true;
    for (let j = i - 2; j <= i + 2; j++) {
      if (j === i) continue;
      if (closes[j] >= closes[i]) isHi = false;
      if (closes[j] <= closes[i]) isLo = false;
    }
    if (isHi) highs.push(closes[i]);
    if (isLo) lows.push(closes[i]);
  }
  return { highs, lows };
}

/**
 * Long-framed structure plan straight from the 7-day sparkline. Used by the
 * counter-trend BOUNCE cards, where the trend engine's own plan may be
 * short-framed: stop under the nearest real swing low, targets at actual
 * resistance levels above.
 */
export function longPlanFromSpark(coin: Coin): { stop: number; targets: number[] } | null {
  const closes = coin.spark ?? [];
  const price = coin.price;
  if (closes.length < 30 || !(price > 0)) return null;
  let vSum = 0;
  let vN = 0;
  for (let i = Math.max(1, closes.length - 14); i < closes.length; i++) {
    vSum += Math.abs(closes[i] - closes[i - 1]) / closes[i - 1];
    vN++;
  }
  const atrAbs = (vN ? vSum / vN : 0.01) * price;
  const sw = closeSwings(closes);
  return tradePlan("long", price, atrAbs, sw.highs.slice(-10), sw.lows.slice(-10), "spot");
}

export function scanCoin(coin: Coin, style: Style, market: Market): Recommendation {
  const closes = coin.spark ?? [];
  const price = coin.price;
  // Stablecoins don't trend — never a trade signal.
  if (isStable(coin.symbol) || closes.length < 30 || !(price > 0)) return neutral(coin, style, market);

  const e9 = last(ema(closes, 9));
  const e21 = last(ema(closes, 21));
  const e50 = last(ema(closes, 50));
  const r = last(rsi(closes, 14));
  const mHist = last(macd(closes).hist);
  const bb = bollinger(closes, 20, 2);
  const bbU = last(bb.upper);
  const bbL = last(bb.lower);
  const bbPctB = bbU > bbL ? (price - bbL) / (bbU - bbL) : 0.5;

  // ATR% proxy from close-to-close moves, plus the current volatility's
  // percentile within THIS coin's own rolling history (per-asset regime).
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.abs(closes[i] - closes[i - 1]) / closes[i - 1]);
  const W = 14;
  const vols: number[] = [];
  let acc = 0;
  for (let i = 0; i < rets.length; i++) {
    acc += rets[i];
    if (i >= W) acc -= rets[i - W];
    if (i >= W - 1) vols.push(acc / W);
  }
  const curVol = vols.length ? vols[vols.length - 1] : 0.01;
  const atrPct = curVol * 100;
  const volPctile = vols.length > 10 ? vols.filter((v) => v <= curVol).length / vols.length : 0.5;

  const change7d = coin.change7d ?? 0;
  const trend: "up" | "down" | "range" =
    Number.isFinite(e50) && e9 > e21 && e21 > e50 ? "up" : Number.isFinite(e50) && e9 < e21 && e21 < e50 ? "down" : "range";

  // ---- confluence ----
  let bias = 0;
  const bull: string[] = [];
  const bear: string[] = [];
  if (trend === "up") { bias += 2; bull.push("Uptrend — EMA 9>21>50"); }
  else if (trend === "down") { bias -= 2; bear.push("Downtrend — EMA 9<21<50"); }

  if (r >= 55 && r < 70) { bias += 1; bull.push(`RSI ${r.toFixed(0)} — bullish momentum`); }
  else if (r >= 70) { bias -= 0.5; bear.push(`RSI ${r.toFixed(0)} — overbought`); }
  else if (r <= 45 && r > 30) { bias -= 1; bear.push(`RSI ${r.toFixed(0)} — weak`); }
  else if (r <= 30) { bias += 0.5; bull.push(`RSI ${r.toFixed(0)} — oversold`); }

  if (mHist > 0) { bias += 1; bull.push("MACD histogram positive"); }
  else { bias -= 1; bear.push("MACD histogram negative"); }

  if (bbPctB > 0.5) bias += 0.5; else bias -= 0.5;
  if (change7d > 5) { bias += 0.5; bull.push(`+${change7d.toFixed(1)}% over 7d`); }
  else if (change7d < -5) { bias -= 0.5; bear.push(`${change7d.toFixed(1)}% over 7d`); }

  const htfUp = change7d > 2;

  // ---- decide ----
  let signal: Direction;
  if (market === "spot") {
    const uptrend = trend === "up" || htfUp;
    const overbought = r >= 70;
    const extended = bbPctB >= 0.82;
    const fading = mHist < 0;
    // Per-asset dip zone — breathes with THIS coin's volatility (see signal-engine).
    const dipLo = atrPct >= 2.5 ? 35 : atrPct <= 0.8 ? 42 : 40;
    const healthyDip = r >= dipLo && r <= 64 && bbPctB <= 0.7;
    if (uptrend && overbought && fading) signal = "SHORT";
    else if (uptrend && extended) signal = "NEUTRAL";
    else if (uptrend && healthyDip && bias > 0.5) signal = "LONG";
    else if (trend === "down" && bias <= -2) signal = "SHORT";
    else signal = "NEUTRAL";
  } else {
    signal = bias >= 2 ? "LONG" : bias <= -2 ? "SHORT" : "NEUTRAL";
  }

  // Confidence reflects confluence + trend strength (EMA separation) + the
  // agreement between the 24h and 7d momentum — better-calibrated than before.
  const emaSpread = Number.isFinite(e50) ? (Math.abs(e9 - e50) / price) * 100 : 0;
  const trendStrength = Math.min(emaSpread / 3, 1); // 0..1
  let confidence = clamp(38 + Math.abs(bias) * 10 + trendStrength * 10);
  if ((signal === "LONG" && htfUp) || (signal === "SHORT" && !htfUp)) confidence += 6;
  if (Math.sign(coin.change24h ?? 0) === Math.sign(change7d) && Math.abs(change7d) > 2) confidence += 4; // momentum consistency
  // Volatility regime vs the coin's own norm (mirrors the deep engine).
  if (volPctile >= 0.85) confidence -= 6;
  else if (volPctile <= 0.35) confidence += 3;
  confidence = Math.round(clamp(confidence));

  // Structure-aware plan: detect swing highs/lows on the close series and place
  // the stop beyond real structure with targets at actual levels (same tradePlan
  // engine as the deep analysis) — no more identical R-multiple ladders.
  const sw = closeSwings(closes);
  const plan = tradePlan(signal === "SHORT" ? "short" : "long", price, (atrPct / 100) * price, sw.highs.slice(-10), sw.lows.slice(-10), market);
  const stop = plan.stop;
  const targets = plan.targets;
  const reasons: string[] = signal === "LONG" ? [...bull] : signal === "SHORT" ? [...bear] : ["No clean setup — mixed confirmations"];
  if (market === "spot") {
    reasons.push(
      signal === "LONG" ? "Spot: buy-the-dip within an uptrend"
        : signal === "SHORT" ? "Spot: take profit / exit"
          : "Spot: wait for a clean dip entry"
    );
  }
  reasons.push("Scanned from 7-day data · open the coin for deeper analysis");

  const riskReward = Math.abs(targets[0] - price) / Math.abs(price - stop);
  // Risk graded relative to the coin's OWN volatility norm + absolute sanity bound.
  const riskLevel: RiskLevel = volPctile >= 0.8 || atrPct > 4 || confidence < 55 ? "High" : atrPct > 1.6 || confidence < 72 ? "Medium" : "Low";
  const lev = Math.max(1, Math.min(10, Math.round(6 / Math.max(0.5, atrPct))));
  const leverage = market === "spot" || signal === "NEUTRAL" ? "—" : `${lev}x max`;

  return {
    symbol: coin.symbol, style, market, signal, confidence,
    entry: price, stop, targets, riskReward, riskLevel, trend, leverage,
    ltf: "1h", htf: "1d", candleSource: "coingecko-7d", reasons,
    indicators: { rsi: r, macdHist: mHist, atrPct, volRatio: 1, bbPctB },
    generatedAt: Date.now(),
  };
}
