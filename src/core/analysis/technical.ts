/**
 * Stage 3 of the pipeline: the full technical read.
 *
 * Runs the four layers on each of the six timeframes, then applies the flow
 * rule across them. Pure: it takes candles in and returns an analysis out —
 * no clock, no network, no database. That is what lets the backtester run the
 * EXACT same code path as the live bot instead of a simplified copy of it,
 * which is the single biggest source of backtests that do not reproduce.
 */
import {
  analyzeMomentum, analyzeTrend, analyzeVolatility, analyzeVolume,
} from "@/core/analysis/layers";
import { analyzeConfluence } from "@/core/analysis/confluence";
import {
  BIAS_AR, type Bias, type TechnicalAnalysis, type TimeframeAnalysis,
} from "@/core/analysis/types";
import type { Candle } from "@/core/types";
import { TIMEFRAMES, type Timeframe, dropUnclosed, tfIndex } from "@/shared/time";

/**
 * Minimum closed bars per timeframe.
 *
 * 220 is not arbitrary: SMA(200) needs 200 bars to produce its first value and
 * another 20 before its slope means anything. Below this the trend layer is
 * reporting on a average that barely exists, so we decline the timeframe
 * rather than emit a confident number from thin history.
 */
const MIN_BARS_FULL = 220;
/** Absolute floor — below this not even momentum is meaningful. */
const MIN_BARS_ANY = 60;

/** How the four layers combine into one directional score per timeframe. */
const LAYER_WEIGHTS = {
  trend: 0.40,
  momentum: 0.30,
  volume: 0.30,
} as const;

const fmt = (n: number, d = 0): string =>
  Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";

export interface TechnicalInput {
  readonly symbol: string;
  /** Closed candles per timeframe. Missing keys are reported, not guessed. */
  readonly candles: Partial<Record<Timeframe, readonly Candle[]>>;
  /** Which timeframe a trade would execute on. Drives the flow rule anchor. */
  readonly tradingTimeframe: Timeframe;
  /** Whether the venue reports the taker-buy split. */
  readonly hasTakerBreakdown: boolean;
  /** Direction the macro stage permits this cycle. */
  readonly macroAllowed?: "long" | "short" | "both" | "none";
  /** Analysis timestamp; defaults to now. Backtests pass the simulated bar. */
  readonly now?: number;
}

export function analyzeTimeframe(
  candles: readonly Candle[],
  timeframe: Timeframe,
  hasTakerBreakdown: boolean,
): TimeframeAnalysis {
  const i = candles.length - 1;
  const last = candles[i];

  const trend = analyzeTrend(candles);
  const momentum = analyzeMomentum(candles, timeframe);
  const volatility = analyzeVolatility(candles);
  const volume = analyzeVolume(candles, timeframe, hasTakerBreakdown);

  const score =
    trend.score * LAYER_WEIGHTS.trend +
    momentum.score * LAYER_WEIGHTS.momentum +
    volume.score * LAYER_WEIGHTS.volume;

  const bias: Bias = score > 15 ? "bullish" : score < -15 ? "bearish" : "neutral";

  // Conviction is about AGREEMENT, not magnitude. Three layers all saying +40
  // is a far better setup than one saying +100 while another says −60.
  const directional = [trend.score, momentum.score, volume.score];
  const spread = Math.max(...directional) - Math.min(...directional);
  const agreementFactor = Math.max(0, 1 - spread / 200);
  const strength = Math.round(Math.min(100, Math.abs(score) * agreementFactor * 1.4));

  const warnings: string[] = [];
  if (candles.length < MIN_BARS_FULL) {
    warnings.push(`التاريخ ${candles.length} شمعة فقط — أقل من ${MIN_BARS_FULL}، وبعض المؤشرات غير مكتملة`);
  }
  for (const layer of [trend, momentum, volatility, volume]) {
    for (const u of layer.unavailable) warnings.push(u);
  }
  if (volatility.score <= 35) {
    warnings.push("بيئة التقلّب غير مواتية — الدخول هنا يضع الوقف داخل الضجيج");
  }
  if (spread > 120) {
    warnings.push(`الطبقات متعارضة بشدّة (تشتّت ${fmt(spread)}) — الثقة منخفضة رغم النتيجة`);
  }

  return {
    timeframe,
    bars: candles.length,
    asOf: last.openTime,
    price: last.close,
    layers: { trend, momentum, volatility, volume },
    score,
    bias,
    strength,
    warnings,
    arabic: narrateTimeframe(timeframe, score, bias, strength, { trend, momentum, volatility, volume }),
  };
}

function narrateTimeframe(
  tf: Timeframe,
  score: number,
  bias: Bias,
  strength: number,
  layers: { trend: { arabic: string; score: number }; momentum: { arabic: string; score: number }; volatility: { arabic: string; score: number }; volume: { arabic: string; score: number } },
): string {
  return [
    `على إطار ${tf}: الميل ${BIAS_AR[bias]} بنتيجة ${fmt(score)} وقوة قناعة ${strength} من 100.`,
    layers.trend.arabic,
    layers.momentum.arabic,
    layers.volume.arabic,
    layers.volatility.arabic,
  ].join(" ");
}

export function analyzeTechnical(input: TechnicalInput): TechnicalAnalysis {
  const now = input.now ?? Date.now();
  const analyses: TimeframeAnalysis[] = [];
  const missing: { timeframe: Timeframe; reason: string }[] = [];

  for (const tf of TIMEFRAMES) {
    const raw = input.candles[tf];
    if (!raw || raw.length === 0) {
      missing.push({ timeframe: tf, reason: "لا توجد شموع مخزّنة لهذا الإطار" });
      continue;
    }

    // Defence in depth: the caller should already have dropped the forming
    // bar, but an analysis engine must never trust that it did.
    const closed = dropUnclosed(raw as Candle[], tf, now);

    if (closed.length < MIN_BARS_ANY) {
      missing.push({
        timeframe: tf,
        reason: `${closed.length} شمعة مغلقة فقط — الحد الأدنى ${MIN_BARS_ANY}`,
      });
      continue;
    }
    analyses.push(analyzeTimeframe(closed, tf, input.hasTakerBreakdown));
  }

  if (analyses.length === 0) {
    return {
      symbol: input.symbol,
      generatedAt: now,
      timeframes: [],
      missing,
      verdict: "fail",
      confluence: {
        agreement: 0,
        dominantBias: "neutral",
        tradingTimeframe: input.tradingTimeframe,
        anchorTimeframe: input.tradingTimeframe,
        anchorBias: "neutral",
        perTimeframe: [],
        conflicts: [],
        allowedDirection: "none",
        verdict: "fail",
        arabic: "لا يوجد أي إطار زمني بتاريخ كافٍ — التحليل الفني غير ممكن.",
      },
      arabic: `${input.symbol}: تعذّر التحليل الفني — لا إطار واحد بتاريخ كافٍ.`,
    };
  }

  analyses.sort((a, b) => tfIndex(a.timeframe) - tfIndex(b.timeframe));

  const confluence = analyzeConfluence(analyses, {
    tradingTimeframe: input.tradingTimeframe,
    macroAllowed: input.macroAllowed,
  });

  // The trading timeframe itself must be present — we cannot time an entry on
  // a timeframe we have no data for.
  const hasTradingTf = analyses.some((a) => a.timeframe === input.tradingTimeframe);
  const verdict = !hasTradingTf ? "fail" : confluence.verdict;

  const arabic = [
    `${input.symbol} — التحليل الفني على ${analyses.length} من ${TIMEFRAMES.length} أطر زمنية.`,
    !hasTradingTf ? `إطار التداول ${input.tradingTimeframe} غير متاح، والتحليل يسقط.` : "",
    confluence.arabic,
    missing.length > 0
      ? `أطر غير متاحة: ${missing.map((m) => `${m.timeframe} (${m.reason})`).join("، ")}.`
      : "",
  ].filter(Boolean).join(" ");

  return {
    symbol: input.symbol,
    generatedAt: now,
    timeframes: analyses,
    confluence,
    missing,
    verdict,
    arabic,
  };
}

export const __testing = { MIN_BARS_FULL, MIN_BARS_ANY, LAYER_WEIGHTS };
