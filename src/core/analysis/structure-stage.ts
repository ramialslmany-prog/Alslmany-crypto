/**
 * Stage 4 of the pipeline: structure, levels and patterns.
 *
 * This stage exists to answer one question the later stages depend on
 * absolutely: WHERE are the real prices that matter? Entry, stop and targets
 * are read off these levels in Stage 8. They are never derived from a
 * percentage, because a 2% stop is a statement about the trader's wallet, not
 * about where the trade idea stops being true.
 *
 * Pure, like every analysis stage: candles in, analysis out.
 */
import { analyzeStructure, STRUCTURE_AR, type MarketStructure } from "@/core/structure/market-structure";
import {
  findLevels, nearestResistance, nearestSupport, resistancesAbove, supportsBelow,
  zoneContaining, type LevelZone,
} from "@/core/structure/levels";
import {
  fibonacci, findGaps, periodExtremes, volumeProfile,
  type FibonacciResult, type PeriodExtreme, type PriceGap, type VolumeProfile,
} from "@/core/structure/reference-levels";
import { findPatterns, PATTERN_AR, type ChartPattern } from "@/core/structure/patterns";
import {
  detectCandlePatterns, qualifyAtLevels, significantPatterns, type CandlePattern,
} from "@/core/structure/candlesticks";
import { atr } from "@/core/indicators/volatility";
import type { Bias, Factor, Verdict } from "@/core/analysis/types";
import type { Candle } from "@/core/types";
import type { Timeframe } from "@/shared/time";

export interface StructureAnalysis {
  readonly timeframe: Timeframe;
  readonly price: number;
  readonly atr: number;
  readonly structure: MarketStructure;
  readonly levels: readonly LevelZone[];
  readonly nearestSupport: LevelZone | null;
  readonly nearestResistance: LevelZone | null;
  /** Ordered ladders, nearest first — Stage 8's target and stop candidates. */
  readonly resistanceLadder: readonly LevelZone[];
  readonly supportLadder: readonly LevelZone[];
  /** The zone price is currently sitting in, if any. */
  readonly currentZone: LevelZone | null;
  readonly fibonacci: FibonacciResult | null;
  readonly periodLevels: readonly PeriodExtreme[];
  readonly gaps: readonly PriceGap[];
  readonly volumeProfile: VolumeProfile | null;
  readonly chartPatterns: readonly ChartPattern[];
  readonly candlePatterns: readonly CandlePattern[];
  /** −100..100 directional read from structure alone. */
  readonly score: number;
  readonly bias: Bias;
  readonly factors: readonly Factor[];
  readonly verdict: Verdict;
  readonly warnings: readonly string[];
  readonly arabic: string;
}

const WEIGHTS = {
  structureState: 35,
  lastBreak: 25,
  levelRoom: 20,
  chartPattern: 20,
} as const;

const clamp = (n: number, lo = -100, hi = 100): number => Math.max(lo, Math.min(hi, n));

const fmt = (n: number, d = 2): string =>
  Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";

export interface StructureOptions {
  readonly lookback?: number;
  readonly maxZones?: number;
}

export function analyzeStructureStage(
  candles: readonly Candle[],
  timeframe: Timeframe,
  opts: StructureOptions = {},
): StructureAnalysis {
  const endIndex = candles.length - 1;
  const price = candles[endIndex].close;
  const atrSeries = atr(candles, 14);
  const atrValue =
    Number.isFinite(atrSeries[endIndex]) && atrSeries[endIndex] > 0
      ? atrSeries[endIndex]
      : price * 0.01;

  const structure = analyzeStructure(candles, { lookback: opts.lookback ?? 250 });
  const levels = findLevels(candles, { lookback: opts.lookback ?? 400, maxZones: opts.maxZones ?? 12 });
  const fib = fibonacci(candles);
  const periodLevels = periodExtremes(candles, timeframe);
  const gaps = findGaps(candles).filter((g) => !g.filled);
  const profile = volumeProfile(candles);
  const chartPatterns = findPatterns(candles);
  const candlePatterns = qualifyAtLevels(detectCandlePatterns(candles, 5), candles, levels);

  const factors: Factor[] = [];
  const warnings: string[] = [];

  // 1. The structure itself.
  const structureNormalized =
    structure.state === "uptrend" ? Math.min(1, 0.5 + structure.consistency * 0.15)
      : structure.state === "downtrend" ? -Math.min(1, 0.5 + structure.consistency * 0.15)
        : 0;
  factors.push({
    id: "structure_state",
    label: "تصنيف الهيكل",
    value: structureNormalized,
    display: STRUCTURE_AR[structure.state],
    contribution: structureNormalized * WEIGHTS.structureState,
    note: structure.arabic,
  });

  // 2. The last structural break. A CHoCH against the structure is the single
  //    most informative event here, so it is read with its own sign.
  const lastBreak = structure.lastBreak;
  if (lastBreak) {
    const bullish = lastBreak.direction === "up";
    // A wick-only break is a sweep — it argues the OPPOSITE way.
    const sign = lastBreak.closedBeyond ? (bullish ? 1 : -1) : (bullish ? -0.5 : 0.5);
    const displacement = Math.min(1, lastBreak.displacementAtr / 1.5);
    const age = endIndex - lastBreak.index;
    const freshness = Math.max(0, 1 - age / 40);
    const normalized = sign * Math.max(0.3, displacement) * Math.max(0.25, freshness);
    factors.push({
      id: "last_break",
      label: "آخر حدث هيكلي",
      value: normalized,
      display: `${lastBreak.kind === "bos" ? "كسر هيكلي" : "تغيّر طابع"} ${bullish ? "صعودي" : "هبوطي"} قبل ${age} شمعة`,
      contribution: normalized * WEIGHTS.lastBreak,
      note: lastBreak.arabic,
    });
    if (!lastBreak.closedBeyond) {
      warnings.push("آخر كسر كان بالظل دون إغلاق — كنس سيولة، والتعامل معه كاختراق خطأ شائع ومكلف");
    }
    if (lastBreak.kind === "choch") {
      warnings.push("آخر حدث هيكلي تغيّر في الطابع — الاتجاه القائم مهدّد");
    }
  } else {
    factors.push({
      id: "last_break", label: "آخر حدث هيكلي", value: 0, display: "لا يوجد",
      contribution: 0, note: "لم يُكسر أي تأرجح مؤكّد داخل نافذة التحليل",
    });
  }

  // 3. Room to move: how far to the next barrier in each direction. A setup
  //    with resistance 0.3 ATR overhead has nowhere to go, however good it
  //    looks — this is what stops a "perfect" signal into a wall.
  const support = nearestSupport(levels, price);
  const resistance = nearestResistance(levels, price);
  const roomUp = resistance ? (resistance.low - price) / atrValue : Infinity;
  const roomDown = support ? (price - support.high) / atrValue : Infinity;

  if (Number.isFinite(roomUp) || Number.isFinite(roomDown)) {
    const up = Number.isFinite(roomUp) ? roomUp : 10;
    const down = Number.isFinite(roomDown) ? roomDown : 10;
    // Positive when there is more room above than below.
    const normalized = clamp((up - down) / 6, -1, 1);
    factors.push({
      id: "level_room",
      label: "المساحة حتى أقرب حاجز",
      value: normalized,
      display: `${fmt(up, 1)} ATR للأعلى · ${fmt(down, 1)} ATR للأسفل`,
      contribution: normalized * WEIGHTS.levelRoom,
      note:
        `أقرب مقاومة ${resistance ? fmt(resistance.price, 4) : "غير محدّدة"} ` +
        `وأقرب دعم ${support ? fmt(support.price, 4) : "غير محدّد"}. ` +
        (up < 1 ? "المقاومة قريبة جداً — أي شراء هنا يصطدم بحاجز قبل أن يتنفّس. " : "") +
        (down < 1 ? "الدعم قريب جداً — أي بيع هنا يصطدم بحاجز سريعاً." : ""),
    });
    if (up < 1) warnings.push(`المقاومة على بُعد ${fmt(up, 2)} ATR فقط — لا مساحة كافية لهدف معقول`);
    if (down < 1) warnings.push(`الدعم على بُعد ${fmt(down, 2)} ATR فقط`);
  }

  // 4. The freshest confirmed chart pattern.
  const confirmed = chartPatterns.filter((p) => p.confirmed);
  const topPattern = confirmed[0] ?? chartPatterns[0] ?? null;
  if (topPattern) {
    const sign = topPattern.direction === "bullish" ? 1 : -1;
    // An unconfirmed pattern contributes proportionally to its completion, so
    // a half-formed head and shoulders cannot vote like a finished one.
    const normalized = sign * (topPattern.quality / 100) * topPattern.completion;
    factors.push({
      id: "chart_pattern",
      label: "النمط السعري",
      value: normalized,
      display: `${PATTERN_AR[topPattern.kind]} · اكتمال ${Math.round(topPattern.completion * 100)}% · جودة ${topPattern.quality}`,
      contribution: normalized * WEIGHTS.chartPattern,
      note: topPattern.arabic,
    });
    if (!topPattern.confirmed) {
      warnings.push(`${PATTERN_AR[topPattern.kind]} لم يُفعّل بعد — النمط غير المكتمل ليس فرصة`);
    }
  } else {
    factors.push({
      id: "chart_pattern", label: "النمط السعري", value: 0, display: "لا نمط واضح",
      contribution: 0,
      note: "لا نمط سعري يمكن تسميته على هذا الإطار. نتيجة عالية بلا نمط واضح ليست فرصة.",
    });
  }

  const score = clamp(factors.reduce((s, f) => s + f.contribution, 0));
  const bias: Bias = score > 15 ? "bullish" : score < -15 ? "bearish" : "neutral";

  // Structure fails outright only when there is nothing to trade against: no
  // levels means no stop placement and no target, whatever the score says.
  const verdict: Verdict = levels.length === 0 ? "fail" : "pass";
  if (levels.length === 0) {
    warnings.push("لم تُكتشف أي مستويات — لا يمكن تحديد وقف ولا هدف، والتحليل يسقط هنا");
  }

  return {
    timeframe,
    price,
    atr: atrValue,
    structure,
    levels,
    nearestSupport: support,
    nearestResistance: resistance,
    resistanceLadder: resistancesAbove(levels, price),
    supportLadder: supportsBelow(levels, price),
    currentZone: zoneContaining(levels, price),
    fibonacci: fib,
    periodLevels,
    gaps,
    volumeProfile: profile,
    chartPatterns,
    candlePatterns,
    score,
    bias,
    factors,
    verdict,
    warnings,
    arabic: narrate({
      timeframe, price, score, bias, structure, levels, support, resistance,
      fib, profile, topPattern, candlePatterns, gaps, verdict,
    }),
  };
}

function narrate(x: {
  timeframe: Timeframe;
  price: number;
  score: number;
  bias: Bias;
  structure: MarketStructure;
  levels: readonly LevelZone[];
  support: LevelZone | null;
  resistance: LevelZone | null;
  fib: FibonacciResult | null;
  profile: VolumeProfile | null;
  topPattern: ChartPattern | null;
  candlePatterns: readonly CandlePattern[];
  gaps: readonly PriceGap[];
  verdict: Verdict;
}): string {
  const parts: string[] = [];

  parts.push(`الهيكل والمستويات على ${x.timeframe} — النتيجة ${fmt(x.score, 0)}.`);
  parts.push(x.structure.arabic);

  if (x.levels.length === 0) {
    parts.push("لم تُكتشف مستويات قابلة للاعتماد — لا أساس لتحديد وقف أو هدف.");
    return parts.join(" ");
  }

  parts.push(`اكتُشف ${x.levels.length} مستوى مرتّبة بقوّتها.`);
  if (x.resistance) parts.push(`أقرب مقاومة: ${x.resistance.arabic}`);
  if (x.support) parts.push(`أقرب دعم: ${x.support.arabic}`);

  if (x.fib) parts.push(x.fib.arabic);
  if (x.profile) parts.push(x.profile.arabic);

  if (x.topPattern) {
    parts.push(x.topPattern.arabic);
  } else {
    parts.push("لا نمط سعري واضح على هذا الإطار.");
  }

  const significant = significantPatterns(x.candlePatterns);
  if (significant.length > 0) {
    parts.push(significant[0].arabic);
  } else {
    const ignored = x.candlePatterns.filter((p) => p.weight === 0);
    if (ignored.length > 0) {
      parts.push(`رُصدت ${ignored.length} أنماط شموع لكنها تشكّلت بعيداً عن أي مستوى، فأُهملت كلها.`);
    }
  }

  const openGaps = x.gaps.filter((g) => !g.filled);
  if (openGaps.length > 0) {
    parts.push(`توجد ${openGaps.length} فجوة سعرية غير مملوءة، وهي أهداف محتملة.`);
  }

  return parts.join(" ");
}
