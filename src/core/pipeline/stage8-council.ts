/**
 * Stage 8 — the final council.
 *
 * Five steps, in this order, each able to stop everything:
 *   1. classify the market regime
 *   2. classify the trade setup — no nameable setup means no trade
 *   3. combine the stages with regime-dependent weights, NULLIFYING the
 *      indicators the regime says are meaningless
 *   4. compute confidence from stage agreement, data freshness, how many
 *      stages were unavailable, and this setup's history in this regime
 *   5. apply the veto filters — any one of which discards everything
 *
 * The ordering is deliberate: the cheap structural rejections run before the
 * arithmetic, so the rejected-analyses page can say "no setup matched" rather
 * than "score 58".
 */
import {
  REGIME_ALLOWED_SETUPS, SETUP_AR, REGIME_AR, stageFail, stagePass,
  type MarketRegime, type SetupKind, type SetupMatch, type StageId, type StageResult, type Veto,
} from "@/core/pipeline/types";
import { classifyRegime, classifySetup, nullifiedFactors, weightsFor, type StageWeights } from "@/core/pipeline/regime";
import type { StructureAnalysis } from "@/core/analysis/structure-stage";
import type { Factor, TechnicalAnalysis } from "@/core/analysis/types";
import type { Candle, Direction } from "@/core/types";
import type { Timeframe } from "@/shared/time";
import { tfMillis } from "@/shared/time";

export interface CouncilInput {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly candles: readonly Candle[];
  readonly technical: TechnicalAnalysis;
  readonly structure: StructureAnalysis;
  /** Results of stages 1–7, in order. */
  readonly priorStages: readonly StageResult[];
  readonly allowedDirection: "long" | "short" | "both";
  readonly now: number;
  readonly thresholds: CouncilThresholds;
  /** Portfolio state, for the exposure vetoes. */
  readonly portfolio: PortfolioState;
  /** Lookup for a setup's record in this regime, when known. */
  readonly setupHistory: SetupHistoryLookup | null;
}

export interface CouncilThresholds {
  readonly minFinalScore: number;
  readonly minRiskReward: number;
  readonly maxOpenPositions: number;
  readonly maxCorrelatedPositions: number;
  readonly correlationThreshold: number;
  /** Data older than this many bars of the trading timeframe is stale. */
  readonly maxDataAgeBars: number;
}

export interface PortfolioState {
  readonly openPositions: number;
  /** Open positions correlated above the threshold, in the same direction. */
  readonly correlatedSameDirection: number;
  readonly circuitBreakerActive: boolean;
  readonly circuitBreakerReason: string | null;
}

export interface SetupHistory {
  readonly trades: number;
  readonly winRate: number;
  readonly expectancyR: number;
}

/**
 * How the caller supplies a setup's record.
 *
 * A LOOKUP rather than a value, because the setup is not known until this
 * stage has picked one. A caller that had to pass the record up front could
 * only guess which setup would win — and would then be feeding the confidence
 * adjustment the history of a setup that was never chosen.
 */
export type SetupHistoryLookup = (setup: SetupKind) => SetupHistory | null;

export interface CouncilResult {
  readonly stage: StageResult;
  readonly regime: MarketRegime;
  readonly setup: SetupMatch | null;
  readonly direction: Direction | null;
  readonly finalScore: number;
  readonly confidence: number;
  readonly weights: StageWeights;
  readonly nullified: readonly string[];
  readonly vetoes: readonly Veto[];
  /** Vetoes that can only be checked once a plan exists. */
  readonly pendingPlanChecks: { minRiskReward: number };
}

const fmt = (n: number, d = 1): string =>
  Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";

export function runCouncil(input: CouncilInput): CouncilResult {
  const started = Date.now();
  const factors: Factor[] = [];
  const warnings: string[] = [];
  const vetoes: Veto[] = [];

  // ── step 1: regime ───────────────────────────────────────────────────────
  const regimeResult = classifyRegime(input.candles, input.structure);
  const regime = regimeResult.regime;
  factors.push({
    id: "regime", label: "النظام السوقي", value: regimeResult.confidence,
    display: `${REGIME_AR[regime]} (ثقة التصنيف ${regimeResult.confidence}%)`,
    contribution: 0,
    note: regimeResult.arabic,
  });

  // ── circuit breakers come before anything else ───────────────────────────
  if (input.portfolio.circuitBreakerActive) {
    vetoes.push({
      id: "circuit_breaker",
      arabic: `قاطع الحماية مفعّل: ${input.portfolio.circuitBreakerReason ?? "غير محدّد"}`,
      actual: "مفعّل",
      threshold: "يجب أن يكون معطّلاً",
    });
  }

  // ── step 2: setup ────────────────────────────────────────────────────────
  const setup = classifySetup({
    candles: input.candles,
    regime,
    structure: input.structure,
    technical: input.technical,
    allowedDirection: input.allowedDirection,
  });

  if (!setup) {
    const allowed = REGIME_ALLOWED_SETUPS[regime].map((s) => SETUP_AR[s]).join("، ");
    vetoes.push({
      id: "no_setup_match",
      arabic:
        `لا ينطبق أي نمط صفقة بوضوح. الأنماط المسموحة في نظام «${REGIME_AR[regime]}» هي: ${allowed}. ` +
        "نتيجة عالية بلا نمط واضح ليست فرصة.",
      actual: "لا مطابقة فوق 60%",
      threshold: "مطابقة نمط واحد على الأقل بنسبة 60%",
    });
    factors.push({
      id: "setup", label: "نمط الصفقة", value: null, display: "لا مطابقة",
      contribution: 0,
      note: `لم ينطبق أي من الأنماط المسموحة في هذا النظام: ${allowed}`,
    });
  } else {
    factors.push({
      id: "setup", label: "نمط الصفقة", value: setup.fit,
      display: `${SETUP_AR[setup.kind]} · ${setup.direction === "long" ? "شراء" : "بيع"} · مطابقة ${Math.round(setup.fit * 100)}%`,
      contribution: 0,
      note: setup.arabic,
    });
  }

  // ── step 3: weighted combination, with regime nullification ──────────────
  const weights = weightsFor(regime, input.timeframe);
  const nullified = nullifiedFactors(regime);

  let weightedScore = 0;
  let availableWeight = 0;
  let unavailableCount = 0;

  for (const stage of input.priorStages) {
    if (stage.id === "eligibility") continue; // a gate, not a vote
    const weight = (weights as unknown as Record<string, number>)[stage.id] ?? 0;
    if (weight === 0) continue;

    if (stage.status !== "pass") {
      unavailableCount++;
      continue;
    }

    // Remove the contributions of factors the regime says do not apply.
    const nullifiedHere = stage.factors.filter((f) => nullified.includes(f.id));
    const removed = nullifiedHere.reduce((s, f) => s + f.contribution, 0);
    const adjusted = Math.max(-100, Math.min(100, stage.score - removed));

    weightedScore += adjusted * weight;
    availableWeight += weight;

    factors.push({
      id: `stage_${stage.id}`,
      label: stage.name,
      value: adjusted,
      display: `${fmt(adjusted, 0)} × وزن ${fmt(weight * 100, 0)}%`,
      contribution: adjusted * weight,
      note:
        nullifiedHere.length > 0
          ? `النتيجة الأصلية ${fmt(stage.score, 0)}، وأُلغيت مساهمة ${nullifiedHere.map((f) => f.label).join("، ")} ` +
            `لأن نظام «${REGIME_AR[regime]}» يُلغي هذه المؤشرات تماماً. النتيجة بعد الإلغاء ${fmt(adjusted, 0)}.`
          : `النتيجة ${fmt(adjusted, 0)} بوزن ${fmt(weight * 100, 0)}% في هذا النظام.`,
    });
  }

  if (nullified.length > 0) {
    factors.push({
      id: "nullified", label: "مؤشرات مُلغاة بحكم النظام", value: nullified.length,
      display: nullified.join("، "),
      contribution: 0,
      note:
        regime === "ranging"
          ? "السوق عرضي — أُلغيت مؤشرات الاختراق تماماً، لأن معظم اختراقات السوق العرضي كاذبة."
          : "السوق اتجاهي — أُلغيت مؤشرات الانعكاس تماماً، لأن مصارعة اتجاه قوي أسرع طرق الخسارة.",
    });
  }

  // Renormalize by the weight that was actually available, so missing stages
  // do not silently drag the score toward zero.
  const directionalScore = availableWeight > 0 ? weightedScore / availableWeight : 0;
  // The final score is the STRENGTH of the case in the setup's own direction.
  const direction: Direction | null = setup?.direction ?? null;
  const finalScore =
    direction === null
      ? Math.abs(directionalScore)
      : direction === "long"
        ? directionalScore
        : -directionalScore;

  // ── step 4: confidence ───────────────────────────────────────────────────
  const confidence = computeConfidence({
    stages: input.priorStages,
    finalScore,
    unavailableCount,
    setup,
    setupHistory: input.setupHistory,
    now: input.now,
    timeframe: input.timeframe,
    maxDataAgeBars: input.thresholds.maxDataAgeBars,
    factors,
  });

  // ── step 5: veto filters ─────────────────────────────────────────────────
  if (finalScore < input.thresholds.minFinalScore) {
    vetoes.push({
      id: "score_below_minimum",
      arabic: `النتيجة النهائية ${fmt(finalScore, 0)} دون الحد الأدنى ${input.thresholds.minFinalScore}`,
      actual: fmt(finalScore, 1),
      threshold: String(input.thresholds.minFinalScore),
    });
  }

  if (direction && input.allowedDirection !== "both" && input.allowedDirection !== direction) {
    vetoes.push({
      id: "direction_not_allowed",
      arabic: `اتجاه الصفقة (${direction === "long" ? "شراء" : "بيع"}) مخالف للمسموح من السياق الكلي (${input.allowedDirection === "long" ? "شراء فقط" : "بيع فقط"})`,
      actual: direction,
      threshold: input.allowedDirection,
    });
  }

  if (input.portfolio.openPositions >= input.thresholds.maxOpenPositions) {
    vetoes.push({
      id: "exposure_limit",
      arabic: `عدد المراكز المفتوحة ${input.portfolio.openPositions} بلغ الحد الأقصى ${input.thresholds.maxOpenPositions}`,
      actual: String(input.portfolio.openPositions),
      threshold: String(input.thresholds.maxOpenPositions),
    });
  }

  if (input.portfolio.correlatedSameDirection >= input.thresholds.maxCorrelatedPositions) {
    vetoes.push({
      id: "correlated_exposure",
      arabic:
        `${input.portfolio.correlatedSameDirection} مراكز مترابطة بأكثر من ${input.thresholds.correlationThreshold} ` +
        `في نفس الاتجاه — الحد ${input.thresholds.maxCorrelatedPositions}. هذه ليست مراكز مستقلة، بل مركز واحد مضاعف.`,
      actual: String(input.portfolio.correlatedSameDirection),
      threshold: String(input.thresholds.maxCorrelatedPositions),
    });
  }

  // Stale data: the analysis is only as current as its oldest input.
  const barMs = tfMillis(input.timeframe);
  const staleStages = input.priorStages.filter(
    (s) => s.status === "pass" && s.dataAgeMs !== null && s.dataAgeMs > barMs * input.thresholds.maxDataAgeBars,
  );
  if (staleStages.length > 0) {
    vetoes.push({
      id: "stale_data",
      arabic:
        `بيانات متأخرة في: ${staleStages.map((s) => `${s.name} (${Math.round((s.dataAgeMs ?? 0) / 60000)} دقيقة)`).join("، ")}. ` +
        `الحد المسموح ${input.thresholds.maxDataAgeBars} شمعة.`,
      actual: `${staleStages.length} مرحلة`,
      threshold: `${input.thresholds.maxDataAgeBars} شمعة`,
    });
  }

  const arabic = narrate({
    symbol: input.symbol, regime: regimeResult, setup, finalScore, confidence,
    weights, nullified, vetoes, unavailableCount, direction,
  });

  const stage: StageResult =
    vetoes.length > 0
      ? stageFail("council", vetoes.map((v) => v.arabic).join(" · "), {
          score: finalScore, bias: direction === "long" ? "bullish" : direction === "short" ? "bearish" : "neutral",
          factors, warnings, arabic, durationMs: Date.now() - started,
        })
      : stagePass("council", {
          score: finalScore,
          bias: direction === "long" ? "bullish" : direction === "short" ? "bearish" : "neutral",
          factors, confidencePenalty: 0, warnings, arabic,
          dataAgeMs: null, durationMs: Date.now() - started,
        });

  return {
    stage,
    regime,
    setup,
    direction,
    finalScore,
    confidence,
    weights,
    nullified,
    vetoes,
    pendingPlanChecks: { minRiskReward: input.thresholds.minRiskReward },
  };
}

/**
 * Confidence, from the four sources the spec names.
 *
 * It starts from the strength of the case and is REDUCED by disagreement,
 * staleness, missing stages and a poor historical record. It is never raised
 * above what the evidence supports — an unknown history leaves it where it is
 * rather than flattering it.
 */
function computeConfidence(x: {
  stages: readonly StageResult[];
  finalScore: number;
  unavailableCount: number;
  setup: SetupMatch | null;
  setupHistory: SetupHistoryLookup | null;
  now: number;
  timeframe: Timeframe;
  maxDataAgeBars: number;
  factors: Factor[];
}): number {
  let confidence = Math.min(100, Math.abs(x.finalScore));

  // 1. Agreement between stages. Disagreement cuts hard, as instructed.
  const directional = x.stages.filter((s) => s.status === "pass" && s.bias !== "neutral");
  if (directional.length >= 2) {
    const bullish = directional.filter((s) => s.bias === "bullish").length;
    const bearish = directional.length - bullish;
    const majority = Math.max(bullish, bearish);
    const agreement = majority / directional.length;
    // Unanimous keeps it; a 50/50 split roughly halves it.
    const multiplier = 0.4 + agreement * 0.6;
    const before = confidence;
    confidence *= multiplier;
    x.factors.push({
      id: "confidence_agreement", label: "اتفاق المراحل", value: agreement,
      display: `${bullish} صاعد مقابل ${bearish} هابط`,
      contribution: confidence - before,
      note:
        agreement >= 0.99
          ? "كل المراحل الاتجاهية متفقة."
          : `تعارض بين المراحل — خُفضت الثقة من ${fmt(before, 0)} إلى ${fmt(confidence, 0)}.`,
    });
  }

  // 2. Data freshness.
  const barMs = tfMillis(x.timeframe);
  const ages = x.stages.map((s) => s.dataAgeMs).filter((a): a is number => a !== null);
  if (ages.length > 0) {
    const oldestBars = Math.max(...ages) / barMs;
    if (oldestBars > 1) {
      const penalty = Math.min(0.3, (oldestBars - 1) * 0.1);
      const before = confidence;
      confidence *= 1 - penalty;
      x.factors.push({
        id: "confidence_freshness", label: "طزاجة البيانات", value: oldestBars,
        display: `أقدم مُدخل عمره ${fmt(oldestBars, 1)} شمعة`,
        contribution: confidence - before,
        note: `خُفضت الثقة ${Math.round(penalty * 100)}% بسبب تأخّر البيانات.`,
      });
    }
  }

  // 3. Unavailable stages — the declared, visible penalty.
  const declaredPenalty = x.stages
    .filter((s) => s.status === "unavailable")
    .reduce((s, st) => s + st.confidencePenalty, 0);
  if (declaredPenalty > 0) {
    const before = confidence;
    confidence *= Math.max(0.3, 1 - declaredPenalty);
    x.factors.push({
      id: "confidence_unavailable", label: "مراحل غير متاحة", value: x.unavailableCount,
      display: `${x.unavailableCount} مرحلة`,
      contribution: confidence - before,
      note:
        `مراحل غير متاحة خفضت الثقة بنسبة معلومة ${Math.round(declaredPenalty * 100)}%: ` +
        x.stages.filter((s) => s.status === "unavailable").map((s) => s.name).join("، "),
    });
  }

  // 4. This setup's record in this regime.
  const history = x.setup && x.setupHistory ? x.setupHistory(x.setup.kind) : null;
  if (x.setup && history && history.trades >= 20) {
    const h = history;
    // Centred on a 50% win rate: a proven setup adds, a poor one subtracts.
    const multiplier = 0.7 + Math.min(0.6, Math.max(0, h.winRate) * 0.6);
    const before = confidence;
    confidence *= multiplier;
    x.factors.push({
      id: "confidence_history", label: "السجل التاريخي لهذا النمط", value: h.winRate,
      display: `${fmt(h.winRate * 100, 0)}% نجاح على ${h.trades} صفقة · التوقّع ${fmt(h.expectancyR, 2)}R`,
      contribution: confidence - before,
      note: `سجل هذا النمط في هذا النظام عدّل الثقة من ${fmt(before, 0)} إلى ${fmt(confidence, 0)}.`,
    });
  } else if (x.setup) {
    x.factors.push({
      id: "confidence_history", label: "السجل التاريخي لهذا النمط", value: null,
      display: history ? `${history.trades} صفقة فقط` : "لا سجل",
      contribution: 0,
      note:
        "لا يوجد سجل كافٍ (20 صفقة على الأقل) لهذا النمط في هذا النظام. " +
        "الثقة تُترك كما هي ولا تُرفع بسجل غير موجود.",
    });
  }

  // The setup's own fit caps confidence: a 62% match cannot yield 95% certainty.
  if (x.setup) confidence *= 0.6 + x.setup.fit * 0.4;

  return Math.max(0, Math.min(100, Math.round(confidence)));
}

function narrate(x: {
  symbol: string;
  regime: { regime: MarketRegime; arabic: string };
  setup: SetupMatch | null;
  finalScore: number;
  confidence: number;
  weights: StageWeights;
  nullified: readonly string[];
  vetoes: readonly Veto[];
  unavailableCount: number;
  direction: Direction | null;
}): string {
  const parts: string[] = [];

  parts.push(`المجلس النهائي على ${x.symbol}.`);
  parts.push(x.regime.arabic);

  if (x.setup) {
    parts.push(`نمط الصفقة: ${x.setup.arabic}`);
  } else {
    parts.push("لم ينطبق أي نمط صفقة بوضوح — ولا توصية بلا نمط.");
  }

  parts.push(
    `الأوزان في هذا النظام: فني ${Math.round(x.weights.technical * 100)}% · ` +
      `هيكل ${Math.round(x.weights.structure * 100)}% · ` +
      `تدفّقات ${Math.round(x.weights.flows * 100)}% · ` +
      `سلسلة ${Math.round(x.weights.onchain * 100)}% · ` +
      `مشاعر ${Math.round(x.weights.sentiment * 100)}%.`,
  );

  if (x.nullified.length > 0) {
    parts.push(`مؤشرات أُلغيت تماماً بحكم النظام السوقي: ${x.nullified.join("، ")}.`);
  }

  parts.push(`النتيجة النهائية ${fmt(x.finalScore, 0)} والثقة ${x.confidence} من 100.`);

  if (x.unavailableCount > 0) {
    parts.push(`${x.unavailableCount} مرحلة غير متاحة، وقد خُفضت الثقة بنسبة معلومة بسببها.`);
  }

  if (x.vetoes.length > 0) {
    parts.push(`فلاتر النقض المُفعَّلة (${x.vetoes.length}): ${x.vetoes.map((v) => v.arabic).join(" · ")}. لا توصية.`);
  } else {
    parts.push("لم يُفعَّل أي فلتر نقض — تُبنى خطة الصفقة الآن.");
  }

  return parts.join(" ");
}

export const __testing = { computeConfidence };
export type { StageId };
