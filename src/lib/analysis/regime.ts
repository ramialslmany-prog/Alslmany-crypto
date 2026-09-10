import type { Candle } from "@/lib/market/types";
import { adx, atrPercent, closes, ema, last, median, percentRank, realizedVolatility } from "./indicators";
import { readStructure, type StructureRead } from "./structure";

/**
 * Market regime.
 *
 * Regime is the gate every other decision passes through: the same setup that
 * is worth taking in a trending market is worth skipping in chop, and worth
 * refusing outright in a shock. We classify the asset and, separately, the
 * market as a whole — an altcoin in a personal uptrend during a Bitcoin
 * collapse is not in an uptrend in any way that will pay you.
 */

export type RegimeLabel = "bull" | "bear" | "range" | "volatile";
export type VolatilityLabel = "low" | "normal" | "high" | "extreme";

export type Evidence = {
  /** Stable identifier, so the UI can localise the wording. */
  key: string;
  /** Which side this observation argues for. */
  direction: "bullish" | "bearish" | "neutral";
  /** Contribution to the regime score, already signed. */
  weight: number;
  /** Concrete numbers behind the claim — this is what makes it auditable. */
  detail: string;
};

export type VolatilityRead = {
  atrPct: number | null;
  percentile: number | null;
  annualized: number | null;
  label: VolatilityLabel;
};

export type RegimeRead = {
  label: RegimeLabel;
  /** −100 (fully bearish) to +100 (fully bullish). */
  score: number;
  /** 0–100 trend strength, independent of direction. */
  strength: number;
  volatility: VolatilityRead;
  structure: StructureRead;
  evidence: Evidence[];
};

function classifyVolatility(candles: Candle[]): VolatilityRead {
  const atrLine = atrPercent(candles, 14);
  const atrPct = last(atrLine);
  const percentile = percentRank(atrLine, 120);
  const typical = median(atrLine, 120);
  const annualized = realizedVolatility(closes(candles), 30);

  // A label needs rank *and* magnitude to agree. Rank alone says only "the
  // highest reading lately", which in a quiet market is still a quiet market —
  // and calling that a shock would shrink every position for no reason.
  const ratio = atrPct !== null && typical !== null && typical > 0 ? atrPct / typical : null;

  let label: VolatilityLabel = "normal";
  if (percentile !== null && ratio !== null) {
    if (percentile >= 92 && ratio >= 1.5) label = "extreme";
    else if (percentile >= 72 && ratio >= 1.15) label = "high";
    else if (percentile <= 22 && ratio <= 0.9) label = "low";
  }

  return { atrPct, percentile, annualized, label };
}

/**
 * Classify one asset's regime from its own candles.
 * Expects a higher-timeframe series (4h or 1d) — regime read off a 15-minute
 * chart is just noise wearing a label.
 */
export function classifyRegime(candles: Candle[]): RegimeRead {
  const price = candles[candles.length - 1]?.c ?? 0;
  const c = closes(candles);
  const ema50 = last(ema(c, 50));
  const ema200 = last(ema(c, 200));
  const ema20 = last(ema(c, 20));
  const adxRead = adx(candles, 14);
  const adxValue = last(adxRead.adx) ?? 0;
  const plusDi = last(adxRead.plusDi) ?? 0;
  const minusDi = last(adxRead.minusDi) ?? 0;
  const structure = readStructure(candles);
  const volatility = classifyVolatility(candles);

  const evidence: Evidence[] = [];
  let score = 0;

  const add = (key: string, weight: number, detail: string) => {
    evidence.push({
      key,
      direction: weight > 0 ? "bullish" : weight < 0 ? "bearish" : "neutral",
      weight,
      detail,
    });
    score += weight;
  };

  // 1 — Position relative to the long-term mean. The single most durable
  //     divider between a bull and a bear tape.
  if (ema200 !== null) {
    const distance = ((price - ema200) / ema200) * 100;
    if (price > ema200) add("above-200ema", Math.min(22, 10 + distance / 3), `price ${distance.toFixed(1)}% above the 200 EMA`);
    else add("below-200ema", Math.max(-22, -10 + distance / 3), `price ${Math.abs(distance).toFixed(1)}% below the 200 EMA`);
  }

  // 2 — Moving-average stack: are the horizons agreeing?
  if (ema50 !== null && ema200 !== null) {
    if (ema50 > ema200) add("ma-stack-bull", 14, "50 EMA above the 200 EMA");
    else add("ma-stack-bear", -14, "50 EMA below the 200 EMA");
  }
  if (ema20 !== null && ema50 !== null) {
    if (ema20 > ema50) add("short-ma-bull", 8, "20 EMA above the 50 EMA");
    else add("short-ma-bear", -8, "20 EMA below the 50 EMA");
  }

  // 3 — Structure: what price actually did at its turning points.
  if (structure.trend === "up") add("structure-up", 18, `structure: ${structure.trendBasis}`);
  else if (structure.trend === "down") add("structure-down", -18, `structure: ${structure.trendBasis}`);
  else add("structure-range", 0, `structure: ${structure.trendBasis}`);

  // 4 — Directional strength. ADX below 20 means whatever direction we just
  //     measured is not being pressed, so we damp the whole read.
  const directional = plusDi - minusDi;
  if (adxValue >= 25) {
    add(
      directional > 0 ? "adx-trending-up" : "adx-trending-down",
      Math.sign(directional) * Math.min(16, adxValue / 3),
      `ADX ${adxValue.toFixed(0)} with ${directional > 0 ? "+DI" : "−DI"} leading`,
    );
  } else {
    add("adx-weak", 0, `ADX ${adxValue.toFixed(0)} — no dominant direction`);
  }

  // 5 — Recent character change carries more information than an old one.
  const lastBreak = structure.lastBreak;
  if (lastBreak && candles.length - lastBreak.index <= 20) {
    const w = lastBreak.kind === "CHoCH" ? 12 : 8;
    add(
      `${lastBreak.kind.toLowerCase()}-${lastBreak.direction}`,
      lastBreak.direction === "bullish" ? w : -w,
      `${lastBreak.kind} ${lastBreak.direction} ${candles.length - lastBreak.index} bars ago`,
    );
  }

  score = Math.max(-100, Math.min(100, score));

  // Volatility overrides direction. In a shock the honest label is "volatile",
  // because position sizing and patience matter more than which way the last
  // few bars pointed.
  let label: RegimeLabel;
  if (volatility.label === "extreme") {
    label = "volatile";
  } else if (adxValue < 20 || Math.abs(score) < 18) {
    label = "range";
  } else {
    label = score > 0 ? "bull" : "bear";
  }

  return {
    label,
    score: Math.round(score),
    strength: Math.round(Math.min(100, adxValue * 2)),
    volatility,
    structure,
    evidence,
  };
}

export type MarketRegime = {
  /** Regime of Bitcoin itself — the tide every altcoin swims in. */
  leader: RegimeRead;
  label: RegimeLabel;
  score: number;
  /** Share of tracked assets above their own 50 EMA, 0–100. */
  breadth: number | null;
  fearGreed: number | null;
  btcDominance: number | null;
  /** Written summary keys the UI turns into localised prose. */
  notes: string[];
  /**
   * Risk budget multiplier, 0–1. The bot multiplies its per-trade risk by this,
   * so a hostile tape shrinks every position automatically instead of relying
   * on anyone to remember to be careful.
   */
  riskBudget: number;
};

/**
 * Market-wide regime. Bitcoin sets the tone; breadth says whether the rest of
 * the market is following it; sentiment is used as a contrarian temper, not as
 * a direction.
 */
export function classifyMarket(input: {
  btcCandles: Candle[];
  breadth?: number | null;
  fearGreed?: number | null;
  btcDominance?: number | null;
}): MarketRegime {
  const leader = classifyRegime(input.btcCandles);
  const notes: string[] = [];
  let score = leader.score;

  const breadth = input.breadth ?? null;
  if (breadth !== null) {
    // Breadth confirms or contradicts the leader. A rally only Bitcoin is
    // joining is a narrow rally, and narrow rallies fail more often.
    if (breadth >= 65) {
      score += 10;
      notes.push("breadth-broad");
    } else if (breadth <= 30) {
      score -= 12;
      notes.push("breadth-narrow");
    } else {
      notes.push("breadth-mixed");
    }
  }

  const fearGreed = input.fearGreed ?? null;
  if (fearGreed !== null) {
    // Sentiment is used against the crowd at the extremes only. In the middle
    // of the range it carries no information worth acting on.
    if (fearGreed <= 20) {
      score += 8;
      notes.push("sentiment-capitulation");
    } else if (fearGreed >= 80) {
      score -= 8;
      notes.push("sentiment-euphoria");
    }
  }

  score = Math.max(-100, Math.min(100, score));

  let label: RegimeLabel;
  if (leader.volatility.label === "extreme") label = "volatile";
  else if (Math.abs(score) < 18) label = "range";
  else label = score > 0 ? "bull" : "bear";

  // Risk budget: full size only in a confirmed, calm uptrend.
  let riskBudget = 1;
  if (label === "bear") riskBudget = 0.35;
  else if (label === "volatile") riskBudget = 0.3;
  else if (label === "range") riskBudget = 0.65;
  if (leader.volatility.label === "high") riskBudget *= 0.8;
  if (breadth !== null && breadth <= 30) riskBudget *= 0.85;
  riskBudget = Math.max(0.2, Math.min(1, riskBudget));

  return {
    leader,
    label,
    score: Math.round(score),
    breadth,
    fearGreed,
    btcDominance: input.btcDominance ?? null,
    notes,
    riskBudget: Number(riskBudget.toFixed(2)),
  };
}

/** Share of a set of series trading above their own 50 EMA. */
export function computeBreadth(seriesList: Candle[][]): number | null {
  const usable = seriesList.filter((c) => c.length >= 60);
  if (usable.length < 5) return null;
  const above = usable.filter((c) => {
    const e = last(ema(closes(c), 50));
    return e !== null && c[c.length - 1].c > e;
  }).length;
  return (above / usable.length) * 100;
}
