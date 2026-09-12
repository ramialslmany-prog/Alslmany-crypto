import type { Candle, Series, Timeframe } from "@/lib/market/types";
import type { Sector, UniverseEntry } from "@/lib/market/universe";
import {
  adx, atrPercent, closes, ema, last, at, macd, obv, rsi, stochRsi, volumes,
} from "@/lib/analysis/indicators";
import { readStructure, type StructureRead, type TrendLabel } from "@/lib/analysis/structure";
import { classifyRegime, type MarketRegime, type RegimeRead } from "@/lib/analysis/regime";
import { analyzeDerivatives, type DerivativesAnalysis } from "@/lib/analysis/derivatives";
import { readDivergences, type DivergenceRead } from "@/lib/analysis/divergence";
import { readVolumeProfile, type VolumeProfileRead } from "@/lib/analysis/volume-profile";
import { readTokenomics, type SupplyInput, type TokenomicsRead } from "@/lib/analysis/tokenomics";
import { macroFor, type MacroRead } from "@/lib/analysis/macro";
import type { DerivativesRead } from "@/lib/market/derivatives";
import type { LiquidityRead } from "@/lib/analysis/liquidity";
import { computeRealisticLoss, measureGapRisk, sizeForRealisticLoss, type RealisticLoss } from "./loss-model";
import {
  DEFAULT_RISK, buildPlan, effectiveRisk, type TradePlan,
} from "./risk";

/**
 * The recommendation engine.
 *
 * Deterministic and auditable by design: the same candles always produce the
 * same call, and every call ships the exact factors that produced it. Nothing
 * here is a black box, because a recommendation you cannot interrogate is
 * indistinguishable from a guess.
 *
 * Two deliberate constraints:
 *
 *  1. Spot long only. The engine never publishes a short or suggests leverage.
 *     Its bearish reads come out as "reduce" or "avoid", which is the useful
 *     half of a bearish view for anyone not running a derivatives book.
 *  2. Probabilities, never certainty. Output is scenarios with relative
 *     likelihoods and an explicit invalidation level, and the bearish evidence
 *     is published beside the bullish evidence even when the call is positive.
 *     Showing only the side that agrees with the verdict is how confirmation
 *     bias gets automated.
 */

export type Horizon = "scalp" | "swing" | "position";
export type Verdict = "enter" | "accumulate" | "watch" | "reduce" | "avoid";
export type Grade = "A" | "B" | "C";
export type FactorGroup = "trend" | "momentum" | "structure" | "volume" | "location" | "context";

export type Factor = {
  /** Stable identifier so the UI can localise without parsing prose. */
  key: string;
  group: FactorGroup;
  timeframe: Timeframe | "multi";
  direction: "bullish" | "bearish" | "neutral";
  /** Signed contribution to that timeframe's score. */
  weight: number;
  /** The numbers behind the claim. */
  detail: string;
};

export type TimeframeRead = {
  timeframe: Timeframe;
  /** −100 (bearish) … +100 (bullish). */
  score: number;
  trend: TrendLabel;
  rsi: number | null;
  adx: number | null;
  macdHistogram: number | null;
  atrPct: number | null;
  factors: Factor[];
};

export type Scenario = {
  kind: "bullish" | "bearish" | "neutral";
  /** Relative likelihood in percent; the three sum to 100. */
  probability: number;
  triggerKey: string;
  detailKey: string;
  levels: number[];
};

export type Recommendation = {
  symbol: string;
  name: string;
  nameAr: string;
  sector: Sector;
  tier: 1 | 2 | 3;
  generatedAt: number;
  price: number;

  verdict: Verdict;
  grade: Grade;
  /** 0–100, the directional conviction of the confluence. */
  score: number;
  /** 0–100, how much the evidence agrees with itself. */
  confidence: number;
  horizon: Horizon;

  plan: TradePlan | null;
  timeframes: TimeframeRead[];
  bullish: Factor[];
  bearish: Factor[];
  scenarios: Scenario[];
  /** Stable keys for conditions the user should know about before acting. */
  warnings: string[];

  regime: RegimeRead;
  structure: StructureRead;
  /** Leverage positioning — null when the asset has no perpetual market. */
  derivatives: DerivativesAnalysis;
  /** Price/momentum disagreement, the earliest reversal warning available. */
  divergence: DivergenceRead;
  /** Where the market agreed on value. */
  volumeProfile: VolumeProfileRead;
  /** What being wrong actually costs, once the book and tail risk are counted. */
  realisticLoss: RealisticLoss | null;
  /** Depth behind the stop, when an order book was supplied. */
  liquidity: LiquidityRead | null;
  /** Supply structure and dilution pressure. */
  tokenomics: TokenomicsRead;
  /** Where capital is rotating between Bitcoin and the rest of the market. */
  macro: MacroRead;
  /** Provenance of the candles this was computed from. */
  dataSource: string;
  degraded: boolean;
};

// ── Per-timeframe analysis ───────────────────────────────────────────────

const slope = (a: number | null, b: number | null) =>
  a !== null && b !== null && b !== 0 ? (a - b) / Math.abs(b) : null;

/**
 * Score one timeframe from five independent angles. Independence matters:
 * three momentum oscillators agreeing is one observation wearing three hats,
 * and stacking them would manufacture false confluence.
 */
export function analyzeTimeframe(candles: Candle[], timeframe: Timeframe): TimeframeRead {
  const c = closes(candles);
  const price = c[c.length - 1] ?? 0;
  const factors: Factor[] = [];
  let score = 0;

  const add = (
    key: string,
    group: FactorGroup,
    weight: number,
    detail: string,
  ) => {
    factors.push({
      key,
      group,
      timeframe,
      direction: weight > 0 ? "bullish" : weight < 0 ? "bearish" : "neutral",
      weight: Number(weight.toFixed(1)),
      detail,
    });
    score += weight;
  };

  // ── 1. Trend: where price sits against its own means ──
  const ema20 = last(ema(c, 20));
  const ema50 = last(ema(c, 50));
  const ema200 = last(ema(c, 200));

  if (ema200 !== null) {
    const d = ((price - ema200) / ema200) * 100;
    add(
      d > 0 ? "trend.above200" : "trend.below200",
      "trend",
      Math.max(-16, Math.min(16, d / 2.5)),
      `${d >= 0 ? "+" : ""}${d.toFixed(1)}% vs 200 EMA`,
    );
  }
  if (ema20 !== null && ema50 !== null) {
    add(
      ema20 > ema50 ? "trend.stackShort" : "trend.stackShortBear",
      "trend",
      ema20 > ema50 ? 9 : -9,
      `20 EMA ${ema20 > ema50 ? "above" : "below"} 50 EMA`,
    );
  }
  if (ema50 !== null && ema200 !== null) {
    add(
      ema50 > ema200 ? "trend.stackLong" : "trend.stackLongBear",
      "trend",
      ema50 > ema200 ? 10 : -10,
      `50 EMA ${ema50 > ema200 ? "above" : "below"} 200 EMA`,
    );
  }

  // ── 2. Momentum: one reading, cross-checked ──
  const rsiLine = rsi(c, 14);
  const rsiValue = last(rsiLine);
  const rsiPrev = at(rsiLine, 3);
  if (rsiValue !== null) {
    // The middle of the RSI range carries almost no information. The edges do,
    // and they mean opposite things depending on what the trend is doing.
    if (rsiValue >= 70) {
      add("momentum.overbought", "momentum", -6, `RSI ${rsiValue.toFixed(0)} — stretched`);
    } else if (rsiValue <= 30) {
      add("momentum.oversold", "momentum", 7, `RSI ${rsiValue.toFixed(0)} — washed out`);
    } else if (rsiValue >= 55) {
      add("momentum.firm", "momentum", 6, `RSI ${rsiValue.toFixed(0)}`);
    } else if (rsiValue <= 45) {
      add("momentum.soft", "momentum", -6, `RSI ${rsiValue.toFixed(0)}`);
    }
    const delta = rsiPrev !== null ? rsiValue - rsiPrev : null;
    if (delta !== null && Math.abs(delta) >= 4) {
      add(
        delta > 0 ? "momentum.rising" : "momentum.falling",
        "momentum",
        Math.max(-7, Math.min(7, delta / 2)),
        `RSI ${delta > 0 ? "+" : ""}${delta.toFixed(0)} over 3 bars`,
      );
    }
  }

  const m = macd(c);
  const hist = last(m.histogram);
  const histPrev = at(m.histogram, 2);
  if (hist !== null) {
    add(
      hist > 0 ? "momentum.macdPositive" : "momentum.macdNegative",
      "momentum",
      hist > 0 ? 7 : -7,
      `MACD histogram ${hist > 0 ? "above" : "below"} zero`,
    );
    if (histPrev !== null) {
      const expanding = Math.abs(hist) > Math.abs(histPrev);
      if (expanding) {
        add(
          hist > 0 ? "momentum.macdExpanding" : "momentum.macdExpandingBear",
          "momentum",
          hist > 0 ? 5 : -5,
          `histogram ${hist > 0 ? "expanding" : "deepening"}`,
        );
      }
    }
  }

  const stoch = last(stochRsi(c));
  if (stoch !== null) {
    if (stoch <= 10) add("momentum.stochTrough", "momentum", 5, `StochRSI ${stoch.toFixed(0)}`);
    else if (stoch >= 90) add("momentum.stochPeak", "momentum", -5, `StochRSI ${stoch.toFixed(0)}`);
  }

  // ── 3. Structure ──
  const structure = readStructure(candles);
  if (structure.trend === "up") add("structure.uptrend", "structure", 13, structure.trendBasis);
  else if (structure.trend === "down") add("structure.downtrend", "structure", -13, structure.trendBasis);
  else add("structure.range", "structure", 0, structure.trendBasis);

  const brk = structure.lastBreak;
  if (brk && candles.length - brk.index <= 12) {
    const w = brk.kind === "CHoCH" ? 11 : 7;
    add(
      `structure.${brk.kind.toLowerCase()}.${brk.direction}`,
      "structure",
      brk.direction === "bullish" ? w : -w,
      `${brk.kind} ${brk.direction}, ${candles.length - brk.index} bars ago`,
    );
  }

  const unfilledBull = structure.fvgs.filter((f) => f.direction === "bullish").length;
  if (unfilledBull > 0) {
    add("structure.fvgBelow", "structure", 3, `${unfilledBull} unfilled bullish imbalance(s)`);
  }

  // ── 4. Volume: is the move being paid for? ──
  const obvLine = obv(candles);
  const obvSlope = slope(last(obvLine), at(obvLine, 10));
  const priceSlope = slope(price, c[c.length - 11] ?? null);
  if (obvSlope !== null && priceSlope !== null) {
    const agree = Math.sign(obvSlope) === Math.sign(priceSlope);
    if (!agree && Math.abs(priceSlope) > 0.01) {
      // Divergence: price is moving without the volume to support it.
      add(
        priceSlope > 0 ? "volume.bearishDivergence" : "volume.bullishDivergence",
        "volume",
        priceSlope > 0 ? -8 : 8,
        `price and OBV disagree over 10 bars`,
      );
    } else if (agree && Math.abs(priceSlope) > 0.005) {
      add(
        priceSlope > 0 ? "volume.confirmsUp" : "volume.confirmsDown",
        "volume",
        priceSlope > 0 ? 6 : -6,
        `OBV confirms the move`,
      );
    }
  }

  const vols = volumes(candles);
  const recentVol = vols[vols.length - 1] ?? 0;
  const avgVol = vols.slice(-21, -1).reduce((s, v) => s + v, 0) / 20;
  if (avgVol > 0) {
    const ratio = recentVol / avgVol;
    if (ratio >= 1.8) {
      const up = (candles[candles.length - 1]?.c ?? 0) >= (candles[candles.length - 1]?.o ?? 0);
      add(
        up ? "volume.surgeUp" : "volume.surgeDown",
        "volume",
        up ? 6 : -6,
        `volume ${ratio.toFixed(1)}× the 20-bar average`,
      );
    } else if (ratio <= 0.5) {
      add("volume.thin", "volume", -3, `volume ${ratio.toFixed(1)}× average — thin participation`);
    }
  }

  // ── 5. Location: buying low in the range beats buying the top of it ──
  if (structure.rangePosition !== null) {
    const p = structure.rangePosition;
    if (p <= 25) add("location.lowInRange", "location", 8, `${p.toFixed(0)}% of the 60-bar range`);
    else if (p >= 85) add("location.highInRange", "location", -9, `${p.toFixed(0)}% of the 60-bar range`);
    else if (p >= 70) add("location.upperRange", "location", -4, `${p.toFixed(0)}% of the 60-bar range`);
  }

  const support = structure.nearestSupport;
  const resistance = structure.nearestResistance;
  if (support && price > 0) {
    const gap = ((price - support.price) / price) * 100;
    if (gap <= 2.5) add("location.atSupport", "location", 7, `${gap.toFixed(1)}% above a defended level`);
  }
  if (resistance && price > 0) {
    const gap = ((resistance.price - price) / price) * 100;
    if (gap <= 1.5) add("location.underResistance", "location", -7, `${gap.toFixed(1)}% below resistance`);
  }

  const adxRead = adx(candles, 14);

  return {
    timeframe,
    score: Math.max(-100, Math.min(100, Math.round(score))),
    trend: structure.trend,
    rsi: rsiValue,
    adx: last(adxRead.adx),
    macdHistogram: hist,
    atrPct: last(atrPercent(candles, 14)),
    factors,
  };
}

// ── Horizon weighting ────────────────────────────────────────────────────

const HORIZON_WEIGHTS: Record<Horizon, Partial<Record<Timeframe, number>>> = {
  // A scalp lives on the fast charts but still respects the daily.
  scalp: { "15m": 26, "1h": 36, "4h": 26, "1d": 12 },
  // The default: the 4h carries the decision, the daily has the veto.
  swing: { "15m": 8, "1h": 22, "4h": 40, "1d": 30 },
  // A position is a daily-chart idea; the fast charts only time the entry.
  position: { "15m": 3, "1h": 12, "4h": 35, "1d": 50 },
};

function weightedScore(reads: TimeframeRead[], horizon: Horizon): number {
  const weights = HORIZON_WEIGHTS[horizon];
  let total = 0;
  let sum = 0;
  for (const read of reads) {
    const w = weights[read.timeframe];
    if (!w) continue;
    sum += read.score * w;
    total += w;
  }
  return total > 0 ? sum / total : 0;
}

/**
 * Agreement across timeframes. Four charts saying +40 is a far better trade
 * than one saying +90 and three saying zero, even though the averages match,
 * so dispersion drives confidence rather than magnitude.
 */
function agreement(reads: TimeframeRead[]): number {
  if (reads.length < 2) return 40;
  const scores = reads.map((r) => r.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
  const sd = Math.sqrt(variance);
  const sameSign = scores.filter((s) => Math.sign(s) === Math.sign(mean) && s !== 0).length;
  const signAgreement = (sameSign / scores.length) * 100;
  // A standard deviation of 40+ across timeframes means they are telling
  // different stories.
  const dispersionScore = Math.max(0, 100 - sd * 2.2);
  return Math.round(signAgreement * 0.55 + dispersionScore * 0.45);
}

function scenarios(
  composite: number,
  structure: StructureRead,
  plan: TradePlan | null,
): Scenario[] {
  // Map conviction onto a probability split. The neutral case keeps a floor
  // because ranging is the market's most common state and pretending
  // otherwise is how a model talks itself into every setup.
  const bullBias = Math.max(0, composite) / 100;
  const bearBias = Math.max(0, -composite) / 100;
  const neutral = Math.max(22, 42 - Math.abs(composite) * 0.28);
  const remaining = 100 - neutral;
  const bull = remaining * (0.5 + (bullBias - bearBias) * 0.42);
  const bear = remaining - bull;

  const resistances = structure.levels
    .filter((l) => l.kind === "resistance")
    .sort((a, b) => a.price - b.price)
    .slice(0, 2)
    .map((l) => l.price);
  const supports = structure.levels
    .filter((l) => l.kind === "support")
    .sort((a, b) => b.price - a.price)
    .slice(0, 2)
    .map((l) => l.price);

  return [
    {
      kind: "bullish",
      probability: Math.round(bull),
      triggerKey: "scenario.trigger.reclaim",
      detailKey: "scenario.detail.bullish",
      levels: plan ? plan.targets.map((t) => t.price) : resistances,
    },
    {
      kind: "neutral",
      probability: Math.round(neutral),
      triggerKey: "scenario.trigger.range",
      detailKey: "scenario.detail.neutral",
      levels: [...supports.slice(0, 1), ...resistances.slice(0, 1)],
    },
    {
      kind: "bearish",
      probability: Math.round(bear),
      triggerKey: "scenario.trigger.lose",
      detailKey: "scenario.detail.bearish",
      levels: plan ? [plan.stop, ...supports.slice(0, 1)] : supports,
    },
  ];
}

export type EngineSettings = {
  riskPerTradePct: number;
  minRewardRisk: number;
  maxPositionPct: number;
};

export const DEFAULT_SETTINGS: EngineSettings = {
  riskPerTradePct: DEFAULT_RISK.riskPerTradePct,
  minRewardRisk: DEFAULT_RISK.minRewardRisk,
  maxPositionPct: DEFAULT_RISK.maxPositionPct,
};

/**
 * Produce one recommendation from a multi-timeframe stack.
 * `stack` should carry 1d, 4h, 1h and optionally 15m. Missing timeframes are
 * tolerated but cost confidence, because a call made on less evidence deserves
 * to be held less firmly.
 */
export function recommend(input: {
  entry: UniverseEntry;
  stack: Partial<Record<Timeframe, Series | null>>;
  market: MarketRegime;
  settings?: Partial<EngineSettings>;
  /** Correlation of this asset's returns against Bitcoin, if known. */
  btcCorrelation?: number | null;
  /** Perpetual-market positioning, when the asset has one. */
  derivatives?: DerivativesRead | null;
  /** Order-book depth, used to price the real cost of being stopped out. */
  liquidity?: LiquidityRead | null;
  /** Supply figures, when the market list carries them. */
  supply?: SupplyInput | null;
  /** Market-wide rotation between Bitcoin and alts. */
  macro?: MacroRead | null;
}): Recommendation | null {
  const settings = { ...DEFAULT_SETTINGS, ...input.settings };
  const { entry, stack, market } = input;

  const order: Timeframe[] = ["1d", "4h", "1h", "15m"];
  const reads: TimeframeRead[] = [];
  let anchor: Series | null = null;

  for (const tf of order) {
    const series = stack[tf];
    if (!series || series.candles.length < 60) continue;
    reads.push(analyzeTimeframe(series.candles, tf));
    if (tf === "4h" || (!anchor && (tf === "1d" || tf === "1h"))) anchor = series;
  }

  // Without the 4h or the daily there is no higher-timeframe context, and a
  // call made purely off fast charts is noise with a price attached.
  const hasHtf = reads.some((r) => r.timeframe === "4h" || r.timeframe === "1d");
  if (!anchor || reads.length < 2 || !hasHtf) return null;

  const candles = anchor.candles;
  const price = candles[candles.length - 1].c;
  const structure = readStructure(candles);
  const regime = classifyRegime(candles);

  // ── Professional dimensions ──
  // Each is independently optional. A missing one contributes nothing rather
  // than a neutral value, because "unknown" and "balanced" are different
  // claims and only one of them is true.
  const derivatives = analyzeDerivatives(input.derivatives ?? null);
  const divergence = readDivergences(candles);
  const volumeProfile = readVolumeProfile(candles);
  const liquidity = input.liquidity ?? null;
  const tokenomics = readTokenomics(input.supply ?? null);
  // Rotation is a fact about alts relative to Bitcoin; it does not apply to
  // Bitcoin itself without double-counting.
  const macro = input.macro
    ? macroFor(entry.symbol, input.macro)
    : { available: false, altStrengthPct: null, btcDominance: null, dominanceChange: null,
        phase: "neutral" as const, score: 0, evidence: [], warnings: [] };

  // Pick the horizon the evidence actually supports, rather than forcing every
  // setup into one house style.
  const horizons: Horizon[] = ["scalp", "swing", "position"];
  const scored = horizons.map((h) => ({ horizon: h, value: weightedScore(reads, h) }));
  const best = scored.reduce((a, b) => (b.value > a.value ? b : a));
  const swing = scored.find((s) => s.horizon === "swing")!;
  // Prefer swing unless another horizon is clearly better — stability beats
  // relabelling the same setup every refresh.
  const chosen = best.value - swing.value > 8 ? best : swing;

  // The technical confluence is the base; the professional dimensions adjust
  // it. They are capped so that positioning and profile can temper a technical
  // read but never manufacture one on their own.
  const adjustment = Math.max(
    -35,
    Math.min(
      25,
      derivatives.score * 0.5 +
        divergence.score * 0.6 +
        volumeProfile.score * 0.5 +
        tokenomics.score * 0.5 +
        macro.score * 0.5,
    ),
  );
  const composite = Math.max(-100, Math.min(100, chosen.value + adjustment));

  const daily = reads.find((r) => r.timeframe === "1d");
  const fourHour = reads.find((r) => r.timeframe === "4h");

  // ── Confidence ──
  let confidence = agreement(reads);
  if (reads.length < 4) confidence -= (4 - reads.length) * 7;
  if (regime.volatility.label === "extreme") confidence -= 18;
  else if (regime.volatility.label === "high") confidence -= 8;
  // Alignment with the wider market is worth real confidence.
  if (market.label === "bull" && composite > 0) confidence += 6;
  if (market.label === "bear" && composite > 0) confidence -= 12;
  // Ceilings are applied last, after every bonus. Clamping mid-calculation
  // lets a later adjustment add straight back on top of the cap, which would
  // quietly restore confidence in a number we know is not a real market.
  if (anchor.source === "synthetic") confidence = Math.min(confidence, 25);
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  const score = Math.round((composite + 100) / 2);

  // ── Warnings — stated before the verdict, not buried under it ──
  const warnings: string[] = [];
  if (regime.volatility.label === "extreme") warnings.push("warn.extremeVolatility");
  if (market.label === "bear") warnings.push("warn.bearMarket");
  if (entry.sector === "meme") warnings.push("warn.memeAsset");
  if (entry.tier === 3) warnings.push("warn.smallCap");
  if (anchor.source === "synthetic") warnings.push("warn.syntheticData");
  if (daily && daily.rsi !== null && daily.rsi >= 75) warnings.push("warn.dailyOverbought");
  if (input.btcCorrelation !== null && input.btcCorrelation !== undefined && input.btcCorrelation >= 0.8) {
    warnings.push("warn.btcCorrelated");
  }
  if (market.breadth !== null && market.breadth <= 30) warnings.push("warn.narrowBreadth");
  warnings.push(...derivatives.warnings, ...divergence.warnings);
  warnings.push(...tokenomics.warnings, ...macro.warnings);
  if (liquidity && liquidity.score < 40) warnings.push("warn.thinLiquidity");

  // ── Plan ──
  // Crowded leverage shrinks the risk budget mechanically. A reader who has
  // just been told the trade is crowded will still take full size otherwise.
  const risk =
    effectiveRisk(settings.riskPerTradePct, market.riskBudget, entry.tier, confidence) *
    derivatives.sizeMultiplier *
    // Supply still to arrive is future selling pressure; it shrinks the
    // position the same way crowded leverage does.
    tokenomics.sizeMultiplier;

  let plan = buildPlan({
    price,
    candles,
    structure,
    riskPerTradePct: risk,
    minRewardRisk: settings.minRewardRisk,
    maxPositionPct: settings.maxPositionPct,
  });

  // ── What being wrong actually costs ──
  // Standard sizing divides the risk budget by the stop distance, which
  // assumes a perfect fill. Re-sizing against the realistic loss means the
  // stated risk survives contact with a real order book and a real tail.
  const gapRisk = measureGapRisk(candles);
  let realisticLoss: RealisticLoss | null = null;

  if (plan) {
    realisticLoss = computeRealisticLoss({
      entry: plan.reference,
      stop: plan.stop,
      positionSizePct: plan.positionSizePct,
      intendedAccountRiskPct: plan.riskPerTradePct,
      liquidity,
      gapRisk,
    });

    const honestSize = sizeForRealisticLoss(
      realisticLoss.realisticPct,
      plan.riskPerTradePct,
      settings.maxPositionPct,
    );
    if (honestSize > 0 && honestSize < plan.positionSizePct) {
      plan = { ...plan, positionSizePct: honestSize };
      realisticLoss = computeRealisticLoss({
        entry: plan.reference,
        stop: plan.stop,
        positionSizePct: honestSize,
        intendedAccountRiskPct: plan.riskPerTradePct,
        liquidity,
        gapRisk,
      });
    }
  }

  // ── Verdict ──
  // The higher timeframe holds a veto. A strong 1h setup inside a broken daily
  // is the most reliable way to lose money slowly.
  const htfHostile =
    (daily?.trend === "down" && (daily?.score ?? 0) < -15) ||
    (fourHour?.trend === "down" && (fourHour?.score ?? 0) < -30);
  const rewardOk = plan !== null && plan.rewardRisk >= settings.minRewardRisk;

  let verdict: Verdict;
  if (composite <= -35) verdict = "avoid";
  else if (composite <= -12) verdict = "reduce";
  else if (!rewardOk) verdict = composite >= 20 ? "watch" : "avoid";
  else if (htfHostile) {
    // Not a refusal, a demotion: a countertrend bounce can be worth
    // accumulating into, but never at full conviction.
    verdict = composite >= 30 ? "accumulate" : "watch";
  } else if (composite >= 30 && confidence >= 55 && market.label !== "volatile") verdict = "enter";
  else if (composite >= 18) verdict = "accumulate";
  else if (composite >= 2) verdict = "watch";
  else verdict = "avoid";

  // Nothing is worth full size in a shock.
  if (market.label === "volatile" && verdict === "enter") verdict = "accumulate";

  // Buying into an extreme funding squeeze is the single most reliable way
  // retail gets liquidated. Demote it regardless of how good the chart looks.
  if (derivatives.squeezeRisk === "extreme" && verdict === "enter") verdict = "accumulate";

  // A confirmed reversal divergence across two independent oscillators is a
  // warning the technical score has not caught up with yet.
  if (divergence.confirmed && divergence.score < 0 && verdict === "enter") verdict = "accumulate";

  let grade: Grade = "C";
  if (verdict === "enter" && score >= 68 && confidence >= 65 && (plan?.rewardRisk ?? 0) >= 2.4) {
    grade = "A";
  } else if ((verdict === "enter" || verdict === "accumulate") && score >= 56 && confidence >= 50) {
    grade = "B";
  }

  const allFactors = reads.flatMap((r) => r.factors);

  return {
    symbol: entry.symbol,
    name: entry.name,
    nameAr: entry.nameAr,
    sector: entry.sector,
    tier: entry.tier,
    generatedAt: Date.now(),
    price,
    verdict,
    grade,
    score,
    confidence,
    horizon: chosen.horizon,
    plan: verdict === "avoid" || verdict === "reduce" ? null : plan,
    timeframes: reads,
    // Both sides are published, always. The bearish column does not disappear
    // because the verdict came out positive.
    bullish: allFactors.filter((f) => f.direction === "bullish").sort((a, b) => b.weight - a.weight),
    bearish: allFactors.filter((f) => f.direction === "bearish").sort((a, b) => a.weight - b.weight),
    scenarios: scenarios(composite, structure, plan),
    warnings: [...new Set(warnings)],
    regime,
    structure,
    derivatives,
    divergence,
    volumeProfile,
    realisticLoss,
    liquidity,
    tokenomics,
    macro,
    dataSource: anchor.source,
    degraded: anchor.source === "synthetic",
  };
}

/** Rank a set of recommendations the way a desk would read them. */
export function rankRecommendations(list: Recommendation[]): Recommendation[] {
  const verdictRank: Record<Verdict, number> = {
    enter: 0, accumulate: 1, watch: 2, reduce: 3, avoid: 4,
  };
  return [...list].sort((a, b) => {
    if (verdictRank[a.verdict] !== verdictRank[b.verdict]) {
      return verdictRank[a.verdict] - verdictRank[b.verdict];
    }
    const gradeRank = { A: 0, B: 1, C: 2 };
    if (gradeRank[a.grade] !== gradeRank[b.grade]) return gradeRank[a.grade] - gradeRank[b.grade];
    // Conviction and agreement together, not score alone.
    return b.score * (b.confidence / 100) - a.score * (a.confidence / 100);
  });
}
