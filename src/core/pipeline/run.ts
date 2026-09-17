/**
 * The eight-stage run.
 *
 * Stages execute IN ORDER and the run STOPS at the first failure. That is the
 * governing principle of the project made executable: the bot does not score
 * everything and then decide — it must survive eight sequential gates, and
 * where it died is recorded as plainly as where it succeeded.
 *
 * Pure with respect to time: `now` is an input, never `Date.now()`. That is
 * what lets the backtester run this exact function over historical bars
 * instead of a simplified copy — the single biggest source of backtests that
 * do not reproduce live.
 */
import {
  stagePass, stageUnavailable,
  type PipelineRun, type StageId, type StageResult,
} from "@/core/pipeline/types";
import { runEligibility, type EligibilityInput, type EligibilityThresholds } from "@/core/pipeline/stage1-eligibility";
import { runMacro, type MacroInput } from "@/core/pipeline/stage2-macro";
import { runCouncil, type CouncilThresholds, type PortfolioState, type SetupHistoryLookup } from "@/core/pipeline/stage8-council";
import { runFlows, type FlowsInput } from "@/core/pipeline/stage5-flows";
import { runSentiment, type SentimentInput } from "@/core/pipeline/stage7-sentiment";
import { analyzeTechnical } from "@/core/analysis/technical";
import { analyzeStructureStage } from "@/core/analysis/structure-stage";
import {
  buildInvalidation, buildPlan, computeIntegrityHash, recommendationId,
  buildConfidenceComponents, __testing as builderTesting,
} from "@/core/recommendation/builder";
import type { Recommendation } from "@/core/recommendation/types";
import type { Candle } from "@/core/types";
import type { Timeframe } from "@/shared/time";

export interface RunInput {
  readonly symbol: string;
  readonly tradingTimeframe: Timeframe;
  readonly exchange: string;
  readonly candles: Partial<Record<Timeframe, readonly Candle[]>>;
  readonly hasTakerBreakdown: boolean;
  readonly eligibility: EligibilityInput;
  readonly eligibilityThresholds: EligibilityThresholds;
  readonly macro: Omit<MacroInput, "symbol" | "assetDaily" | "now" | "correlationCeiling">;
  readonly correlationCeiling: number;
  /**
   * Stage 5 inputs. When present the pipeline runs the flows stage itself;
   * `flows` may still be passed directly (the backtester supplies a
   * pre-computed result rather than re-reading books it does not have).
   */
  readonly flowsInput?: Omit<FlowsInput, "symbol" | "candles" | "hasTakerBreakdown" | "direction" | "now">;
  readonly flows?: StageResult;
  /** Stage 7 inputs. When present the pipeline runs the sentiment stage. */
  readonly sentimentInput?: Omit<SentimentInput, "asset" | "direction" | "now">;
  readonly sentiment?: StageResult;
  readonly onchain?: StageResult;
  readonly council: CouncilThresholds;
  readonly portfolio: PortfolioState;
  readonly setupHistory: SetupHistoryLookup | null;
  readonly equity: number;
  readonly riskPercent: number;
  readonly pricePrecision: number;
  readonly quantityPrecision: number;
  readonly minNotional: number;
  readonly now: number;
}

export interface RunOutput {
  readonly run: PipelineRun;
  readonly recommendation: Recommendation | null;
}

/**
 * Penalties for stages that are not wired yet or have no provider.
 *
 * These are DECLARED, not hidden: the confidence score is reduced by exactly
 * this much and the site shows the number. Stage 6 costs more than stage 7
 * because on-chain flows carry real information a technical read cannot
 * substitute for.
 */
const UNAVAILABLE_PENALTY: Record<string, number> = {
  flows: 0.20,
  onchain: 0.15,
  sentiment: 0.10,
};

export function runPipeline(input: RunInput): RunOutput {
  const startedAt = input.now;
  const stages: StageResult[] = [];
  let failedAt: StageId | null = null;

  const finish = (arabic: string, extra: Partial<PipelineRun> = {}): RunOutput => ({
    run: {
      symbol: input.symbol,
      tradingTimeframe: input.tradingTimeframe,
      startedAt,
      finishedAt: input.now,
      stages,
      failedAt,
      regime: null,
      setup: null,
      vetoes: [],
      finalScore: 0,
      confidence: 0,
      recommendationId: null,
      arabic,
      ...extra,
    },
    recommendation: null,
  });

  // ── Stage 1: eligibility ─────────────────────────────────────────────────
  const eligibility = runEligibility(input.eligibility, input.eligibilityThresholds);
  stages.push(eligibility);
  if (eligibility.status === "fail") {
    failedAt = "eligibility";
    return finish(summarize(input.symbol, stages, eligibility));
  }

  // ── Stage 2: macro ───────────────────────────────────────────────────────
  const assetDaily = input.candles["1d"] ?? [];
  const macro = runMacro({
    ...input.macro,
    symbol: input.symbol,
    assetDaily,
    now: input.now,
    correlationCeiling: input.correlationCeiling,
  });
  stages.push(macro);
  if (macro.status === "fail") {
    failedAt = "macro";
    return finish(summarize(input.symbol, stages, macro));
  }

  // "none" is emitted by ONE path only: a macro stage that could not read
  // enough Bitcoin history to judge. No direction is permitted without the
  // macro context, so the run STOPS HERE — at stage 2, naming stage 2.
  //
  // It used to fall through instead: stage 3 received the raw "none",
  // rejected every direction, and the whole run was recorded as a TECHNICAL
  // failure. The bot was equally dead either way, but the rejected-analyses
  // page blamed the wrong stage, which is the harder failure to notice.
  if (macro.allowedDirection === "none") {
    failedAt = "macro";
    return finish(
      summarize(input.symbol, stages, {
        ...macro,
        arabic:
          "السياق الكلي غير قابل للقراءة، ولا يُسمح باتجاه دون سياق كلي. " +
          `${macro.arabic || macro.unavailableReason || ""}`.trim(),
      }),
    );
  }
  const allowedDirection: "long" | "short" | "both" = macro.allowedDirection;

  // ── Stage 3: technical ───────────────────────────────────────────────────
  const tradingCandles = input.candles[input.tradingTimeframe] ?? [];

  const technical = analyzeTechnical({
    symbol: input.symbol,
    candles: input.candles,
    tradingTimeframe: input.tradingTimeframe,
    hasTakerBreakdown: input.hasTakerBreakdown,
    macroAllowed: allowedDirection,
    now: input.now,
  });

  const tradingTf = technical.timeframes.find((t) => t.timeframe === input.tradingTimeframe);
  const technicalStage: StageResult =
    technical.verdict === "fail"
      ? {
          ...stagePass("technical", {
            score: tradingTf?.score ?? 0,
            bias: tradingTf?.bias ?? "neutral",
            factors: [],
            confidencePenalty: 0,
            warnings: technical.timeframes.flatMap((t) => t.warnings),
            arabic: technical.arabic,
            dataAgeMs: null,
            durationMs: 0,
          }),
          status: "fail",
          failReason: technical.confluence.verdict === "fail"
            ? technical.confluence.arabic
            : "التحليل الفني سقط",
        }
      : stagePass("technical", {
          score: tradingTf?.score ?? 0,
          bias: tradingTf?.bias ?? "neutral",
          factors: tradingTf
            ? [
                ...tradingTf.layers.trend.factors,
                ...tradingTf.layers.momentum.factors,
                ...tradingTf.layers.volume.factors,
                ...tradingTf.layers.volatility.factors,
              ]
            : [],
          confidencePenalty: 0,
          warnings: technical.timeframes.flatMap((t) => t.warnings),
          arabic: technical.arabic,
          dataAgeMs: tradingTf ? input.now - (tradingTf.asOf + 0) : null,
          durationMs: 0,
        });

  stages.push(technicalStage);
  if (technicalStage.status === "fail") {
    failedAt = "technical";
    return finish(summarize(input.symbol, stages, technicalStage));
  }

  // ── Stage 4: structure ───────────────────────────────────────────────────
  const structure = analyzeStructureStage(tradingCandles, input.tradingTimeframe);
  const structureStage: StageResult =
    structure.verdict === "fail"
      ? { ...stagePass("structure", {
            score: structure.score, bias: structure.bias, factors: structure.factors,
            confidencePenalty: 0, warnings: structure.warnings, arabic: structure.arabic,
            dataAgeMs: null, durationMs: 0,
          }), status: "fail", failReason: "لا مستويات قابلة للاعتماد — لا يمكن تحديد وقف ولا هدف" }
      : stagePass("structure", {
          score: structure.score, bias: structure.bias, factors: structure.factors,
          confidencePenalty: 0, warnings: structure.warnings, arabic: structure.arabic,
          dataAgeMs: null, durationMs: 0,
        });

  stages.push(structureStage);
  if (structureStage.status === "fail") {
    failedAt = "structure";
    return finish(summarize(input.symbol, stages, structureStage));
  }

  // ── Stage 5: flows and derivatives ───────────────────────────────────────
  // The direction under consideration is not known until the council picks a
  // setup, but the crowding veto needs one. We evaluate against the technical
  // bias, which is what the setup will follow: a stage that guessed the
  // opposite direction would apply the veto backwards.
  const flowsDirection: "long" | "short" =
    (tradingTf?.score ?? 0) >= 0 ? "long" : "short";

  const flowsStage: StageResult =
    input.flows ??
    (input.flowsInput
      ? runFlows({
          ...input.flowsInput,
          symbol: input.symbol,
          candles: tradingCandles,
          hasTakerBreakdown: input.hasTakerBreakdown,
          direction: flowsDirection,
          now: input.now,
        })
      : stageUnavailable("flows", "لم تُمرَّر مُدخلات التدفّقات لهذه الدورة", UNAVAILABLE_PENALTY.flows));

  stages.push(flowsStage);
  stages.push(
    input.onchain ??
      stageUnavailable("onchain", "لا مزوّد لبيانات السلسلة — ضع CRYPTOQUANT_API_KEY", UNAVAILABLE_PENALTY.onchain),
  );
  // ── Stage 7: sentiment, news and risk ────────────────────────────────────
  const ticker = input.symbol.replace(/USDT$|USD$|BUSD$/i, "").toUpperCase();
  stages.push(
    input.sentiment ??
      (input.sentimentInput
        ? runSentiment({
            ...input.sentimentInput,
            asset: { symbol: input.symbol, ticker },
            direction: flowsDirection,
            now: input.now,
          })
        : stageUnavailable("sentiment", "لم تُمرَّر مُدخلات المشاعر لهذه الدورة", UNAVAILABLE_PENALTY.sentiment)),
  );

  for (const s of [stages[4], stages[5], stages[6]]) {
    if (s.status === "fail") {
      failedAt = s.id;
      return finish(summarize(input.symbol, stages, s));
    }
  }

  // ── Stage 8: the council ─────────────────────────────────────────────────
  const council = runCouncil({
    symbol: input.symbol,
    timeframe: input.tradingTimeframe,
    candles: tradingCandles,
    technical,
    structure,
    priorStages: stages,
    allowedDirection,
    now: input.now,
    thresholds: input.council,
    portfolio: input.portfolio,
    setupHistory: input.setupHistory,
  });
  stages.push(council.stage);

  const baseRun: PipelineRun = {
    symbol: input.symbol,
    tradingTimeframe: input.tradingTimeframe,
    startedAt,
    finishedAt: input.now,
    stages,
    failedAt: council.stage.status === "fail" ? "council" : null,
    regime: council.regime,
    setup: council.setup,
    vetoes: council.vetoes,
    finalScore: council.finalScore,
    confidence: council.confidence,
    recommendationId: null,
    arabic: "",
  };

  if (council.stage.status === "fail" || !council.setup || !council.direction) {
    failedAt = "council";
    return {
      run: { ...baseRun, failedAt: "council", arabic: summarize(input.symbol, stages, council.stage) },
      recommendation: null,
    };
  }

  // ── build the plan ───────────────────────────────────────────────────────
  const plan = buildPlan({
    symbol: input.symbol,
    direction: council.direction,
    setup: council.setup.kind,
    regime: council.regime,
    timeframe: input.tradingTimeframe,
    structure,
    price: structure.price,
    atr: structure.atr,
    equity: input.equity,
    riskPercent: input.riskPercent,
    pricePrecision: input.pricePrecision,
    quantityPrecision: input.quantityPrecision,
    minNotional: input.minNotional,
    generatedAt: input.now,
    asOfCandle: tradingCandles[tradingCandles.length - 1].openTime,
    exchange: input.exchange,
  });

  if (!plan.ok) {
    const veto = { id: plan.reason === "no_valid_stop" ? "no_valid_stop" as const : "no_valid_target" as const,
      arabic: plan.arabic, actual: "—", threshold: "—" };
    const vetoes = [...council.vetoes, veto];
    failedAt = "council";
    return {
      run: {
        ...baseRun, failedAt: "council", vetoes,
        arabic: `${summarize(input.symbol, stages, council.stage)} ${plan.arabic}`,
      },
      recommendation: null,
    };
  }

  // The risk/reward veto can only be checked once the plan exists.
  if (plan.riskReward < input.council.minRiskReward) {
    const veto = {
      id: "risk_reward_too_low" as const,
      arabic:
        `العائد للمخاطرة ${plan.riskReward.toFixed(2)} دون الحد الأدنى ${input.council.minRiskReward}. ` +
        "الأهداف عند المستويات الفعلية لا تبرّر مسافة الوقف الحقيقية.",
      actual: plan.riskReward.toFixed(2),
      threshold: String(input.council.minRiskReward),
    };
    failedAt = "council";
    return {
      run: {
        ...baseRun, failedAt: "council", vetoes: [...council.vetoes, veto],
        arabic: `${summarize(input.symbol, stages, council.stage)} ${veto.arabic}`,
      },
      recommendation: null,
    };
  }

  // ── the recommendation ───────────────────────────────────────────────────
  const asOfCandle = tradingCandles[tradingCandles.length - 1].openTime;
  const id = recommendationId(input.symbol, input.tradingTimeframe, asOfCandle);

  const invalidation = buildInvalidation({
    direction: council.direction,
    stop: plan.stop,
    entry: plan.entry,
    structureState: structure.structure.state,
    timeframe: input.tradingTimeframe,
    expiryBars: builderTesting.EXPIRY_BARS,
    pricePrecision: input.pricePrecision,
  });

  const report = buildReport(input.symbol, stages, council, plan);

  const draft: Omit<Recommendation, "integrityHash"> = {
    id,
    symbol: input.symbol,
    direction: council.direction,
    setup: council.setup.kind,
    regime: council.regime,
    timeframe: input.tradingTimeframe,
    generatedAt: input.now,
    asOfCandle,
    exchange: input.exchange,
    entry: plan.entry,
    stop: plan.stop,
    stopBasis: plan.stopBasis,
    targets: plan.targets,
    riskReward: plan.riskReward,
    positionSize: plan.positionSize,
    positionNotional: plan.positionNotional,
    riskAmount: plan.riskAmount,
    riskPercent: input.riskPercent,
    confidence: council.confidence,
    confidenceComponents: buildConfidenceComponents(
      stages.map((s) => ({ id: s.id, name: s.name, score: s.score, status: s.status, arabic: s.arabic })),
      council.weights as unknown as Record<string, number>,
    ),
    finalScore: council.finalScore,
    invalidation,
    expiresAt: plan.expiresAt,
    report,
  };

  const recommendation: Recommendation = { ...draft, integrityHash: computeIntegrityHash(draft) };

  return {
    run: { ...baseRun, recommendationId: id, arabic: report },
    recommendation,
  };
}

/** One line per attempted stage, ending with where it stopped. */
function summarize(symbol: string, stages: readonly StageResult[], failed: StageResult): string {
  const passed = stages.filter((s) => s.status === "pass").length;
  const unavailable = stages.filter((s) => s.status === "unavailable");
  return (
    `${symbol}: اجتاز ${passed} مرحلة ثم سقط في المرحلة ${failed.number} — ${failed.name}. ` +
    `السبب: ${failed.failReason ?? failed.arabic}` +
    (unavailable.length > 0
      ? ` (مراحل غير متاحة: ${unavailable.map((s) => s.name).join("، ")})`
      : "")
  );
}

/**
 * The eight stages woven into one connected Arabic narrative.
 *
 * Not a bullet list: the spec asks for a single coherent report, so each stage
 * is introduced by its number and name and the whole reads as one argument
 * from eligibility through to the plan.
 */
function buildReport(
  symbol: string,
  stages: readonly StageResult[],
  council: { regime: string; setup: { arabic: string } | null; finalScore: number; confidence: number; nullified: readonly string[] },
  plan: { entry: { low: number; high: number; mid: number }; stop: number; stopBasis: string; targets: readonly { index: number; price: number; closeFraction: number; rMultiple: number; basis: string }[]; riskReward: number; positionSize: number; riskAmount: number },
): string {
  const lines: string[] = [];

  lines.push(`تقرير التحليل الكامل — ${symbol}`);
  lines.push("");

  for (const s of stages) {
    const status =
      s.status === "pass" ? "اجتازت" : s.status === "unavailable" ? "غير متاحة" : "سقطت";
    lines.push(`المرحلة ${s.number} — ${s.name} (${status}): ${s.arabic}`);
  }

  lines.push("");
  lines.push("خطة الصفقة:");
  lines.push(
    `منطقة الدخول بين ${plan.entry.low} و${plan.entry.high}. ` +
      "وهي نطاق مأخوذ من مستوى فعلي، لا سعر واحد، لأن السعر لا ينعكس عند نقطة بعينها.",
  );
  lines.push(`الوقف عند ${plan.stop} — ${plan.stopBasis}.`);
  for (const t of plan.targets) {
    lines.push(
      `الهدف ${t.index} عند ${t.price} (${Math.round(t.closeFraction * 100)}% من المركز، ` +
        `${t.rMultiple.toFixed(2)}R) — ${t.basis}.`,
    );
  }
  lines.push(
    `العائد للمخاطرة المرجّح ${plan.riskReward.toFixed(2)}، ` +
      `وحجم المركز ${plan.positionSize} محسوباً من مسافة الوقف ومخاطرة ${plan.riskAmount.toFixed(2)}.`,
  );
  lines.push("");
  lines.push(
    `الخلاصة: النتيجة النهائية ${council.finalScore.toFixed(0)} والثقة ${council.confidence} من 100.` +
      (council.nullified.length > 0
        ? ` وقد أُلغيت مؤشرات ${council.nullified.join("، ")} تماماً بحكم النظام السوقي.`
        : ""),
  );

  return lines.join("\n");
}
