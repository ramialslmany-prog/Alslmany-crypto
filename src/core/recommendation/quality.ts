/**
 * The quality score, 0–100.
 *
 * Ten independent factors with FIXED weights, unlike the council's confidence
 * which shifts its weights by regime. Both numbers are kept because they
 * answer different questions: confidence asks "how much do I trust this
 * reading given what was available", and quality asks "how good is this
 * opportunity on a fixed, comparable scale".
 *
 * A fixed scale is what makes two signals from different weeks and different
 * regimes comparable at all — a regime-weighted number cannot be compared
 * across regimes, which is precisely when you most want to compare.
 *
 * THE SCORE IS NOT A PROBABILITY. 80/100 does not mean an 80% chance of
 * profit and nothing here should ever be phrased that way. It is a rating of
 * how much independent evidence lined up, and evidence lining up is not the
 * same as the trade working.
 *
 * Correlated factors are NOT counted twice. Moving averages and MACD mostly
 * restate the same momentum, so momentum is scored once from the stage's own
 * combined read rather than once per indicator that happens to agree.
 */
import type { StageResult } from "@/core/pipeline/types";

/** The spec's weights. They sum to 100 and a test pins that. */
export const QUALITY_WEIGHTS = {
  marketRegime: 15,
  htfStructure: 15,
  setupQuality: 15,
  entryQuality: 15,
  volume: 10,
  momentum: 10,
  btcAlignment: 10,
  liquidity: 5,
  riskReward: 5,
} as const;

export type QualityFactorId = keyof typeof QUALITY_WEIGHTS;

export type FactorGrade = "strong" | "moderate" | "weak" | "conflicting";

export interface QualityFactor {
  readonly id: QualityFactorId;
  readonly label: string;
  readonly grade: FactorGrade;
  /** 0..1 — what fraction of this factor's weight was earned. */
  readonly earned: number;
  readonly points: number;
  readonly note: string;
}

export interface QualityResult {
  readonly score: number;
  readonly factors: readonly QualityFactor[];
  /** Factors graded `conflicting` — the reasons NOT to take the trade. */
  readonly conflicts: readonly QualityFactor[];
  readonly arabic: string;
}

const LABELS: Record<QualityFactorId, string> = {
  marketRegime: "النظام السوقي",
  htfStructure: "هيكل الإطار الأعلى",
  setupQuality: "جودة النمط",
  entryQuality: "جودة الدخول",
  volume: "الحجم",
  momentum: "الزخم",
  btcAlignment: "توافق البيتكوين",
  liquidity: "السيولة",
  riskReward: "العائد للمخاطرة",
};

/**
 * Grade a factor from a −100..100 directional score.
 *
 * `conflicting` is reserved for a factor pointing the OTHER way, not merely a
 * weak one. The distinction matters: three weak factors are a thin case, and
 * one conflicting factor is a reason to walk away.
 */
export function gradeFromScore(score: number, direction: "long" | "short"): FactorGrade {
  const aligned = direction === "long" ? score : -score;
  if (aligned <= -20) return "conflicting";
  if (aligned >= 55) return "strong";
  if (aligned >= 25) return "moderate";
  return "weak";
}

const EARNED: Record<FactorGrade, number> = {
  strong: 1,
  moderate: 0.6,
  weak: 0.25,
  // A conflicting factor earns NOTHING. It does not subtract either — the
  // subtraction is that it is named in `conflicts`, where a reader cannot
  // miss it behind a total that still looks respectable.
  conflicting: 0,
};

export interface QualityInput {
  readonly direction: "long" | "short";
  readonly stages: readonly StageResult[];
  /** 0..1 — how cleanly the setup's conditions were met. */
  readonly setupFit: number;
  /** Distance from price to the entry zone, in ATR. Negative = already past. */
  readonly entryDistanceAtr: number;
  /** R to the final target. */
  readonly riskReward: number;
  readonly minRiskReward: number;
  /** −100..100 — BTC's own directional read. Null when unknown. */
  readonly btcScore: number | null;
  /** 24h quote volume, for the liquidity grade. */
  readonly quoteVolume24h: number | null;
  readonly minQuoteVolume: number;
  /** Regime classification confidence, 0..100. */
  readonly regimeConfidence: number;
  readonly regimeAgreesWithDirection: boolean;
}

export function computeQuality(x: QualityInput): QualityResult {
  const stage = (id: string): StageResult | undefined => x.stages.find((s) => s.id === id);
  const factors: QualityFactor[] = [];

  const push = (id: QualityFactorId, grade: FactorGrade, note: string): void => {
    const earned = EARNED[grade];
    factors.push({
      id, label: LABELS[id], grade, earned,
      points: earned * QUALITY_WEIGHTS[id], note,
    });
  };

  // 1. Market regime — does it agree with the direction, and how cleanly.
  push(
    "marketRegime",
    !x.regimeAgreesWithDirection ? "conflicting"
      : x.regimeConfidence >= 65 ? "strong"
        : x.regimeConfidence >= 40 ? "moderate" : "weak",
    `ثقة تصنيف النظام ${Math.round(x.regimeConfidence)}%` +
    (x.regimeAgreesWithDirection ? "" : " — النظام يعاكس اتجاه الصفقة"),
  );

  // 2. Higher-timeframe structure.
  const structure = stage("structure");
  push(
    "htfStructure",
    structure && structure.status === "pass"
      ? gradeFromScore(structure.score, x.direction)
      : "weak",
    structure ? `نتيجة الهيكل ${Math.round(structure.score)}` : "المرحلة غير متاحة",
  );

  // 3. Setup quality, straight from how cleanly its conditions were met.
  push(
    "setupQuality",
    x.setupFit >= 0.85 ? "strong" : x.setupFit >= 0.7 ? "moderate" : "weak",
    `مطابقة شروط النمط ${Math.round(x.setupFit * 100)}%`,
  );

  // 4. Entry quality — how far price is from the zone.
  //
  // Price already PAST the zone is the "chasing" case the spec forbids, and
  // it is graded conflicting rather than weak: an extended entry does not
  // weaken the case, it changes which trade you are taking.
  push(
    "entryQuality",
    x.entryDistanceAtr < -0.5 ? "conflicting"
      : Math.abs(x.entryDistanceAtr) <= 0.4 ? "strong"
        : Math.abs(x.entryDistanceAtr) <= 1.0 ? "moderate" : "weak",
    `المسافة إلى منطقة الدخول ${x.entryDistanceAtr.toFixed(2)} ATR` +
    (x.entryDistanceAtr < -0.5 ? " — السعر تجاوزها، وهذه مطاردة" : ""),
  );

  // 5 & 6. Volume and momentum, each read ONCE from the technical stage's own
  // combined factors rather than once per agreeing indicator.
  const technical = stage("technical");
  const factorScore = (prefix: string): number | null => {
    const hits = technical?.factors.filter((f) => f.id.includes(prefix)) ?? [];
    if (hits.length === 0) return null;
    return hits.reduce((s, f) => s + f.contribution, 0);
  };

  const volumeScore = factorScore("volume");
  push(
    "volume",
    volumeScore === null ? "weak" : gradeFromScore(volumeScore * 4, x.direction),
    volumeScore === null ? "لا قراءة حجم" : `مساهمة الحجم ${volumeScore.toFixed(1)}`,
  );

  const momentumScore = factorScore("momentum") ?? factorScore("rsi");
  push(
    "momentum",
    momentumScore === null ? "weak" : gradeFromScore(momentumScore * 4, x.direction),
    momentumScore === null ? "لا قراءة زخم" : `مساهمة الزخم ${momentumScore.toFixed(1)}`,
  );

  // 7. BTC alignment.
  push(
    "btcAlignment",
    x.btcScore === null ? "weak" : gradeFromScore(x.btcScore, x.direction),
    x.btcScore === null ? "قراءة البيتكوين غير متاحة" : `نتيجة البيتكوين ${Math.round(x.btcScore)}`,
  );

  // 8. Liquidity — a multiple of the minimum, not an absolute number.
  const ratio = x.quoteVolume24h !== null && x.minQuoteVolume > 0
    ? x.quoteVolume24h / x.minQuoteVolume
    : null;
  push(
    "liquidity",
    ratio === null ? "weak" : ratio >= 10 ? "strong" : ratio >= 3 ? "moderate" : "weak",
    ratio === null ? "حجم 24 ساعة غير معروف" : `${ratio.toFixed(1)}× الحد الأدنى`,
  );

  // 9. Risk/reward against the configured floor.
  const rrRatio = x.minRiskReward > 0 ? x.riskReward / x.minRiskReward : 0;
  push(
    "riskReward",
    x.riskReward < x.minRiskReward ? "conflicting"
      : rrRatio >= 1.8 ? "strong" : rrRatio >= 1.3 ? "moderate" : "weak",
    `${x.riskReward.toFixed(2)} مقابل حد أدنى ${x.minRiskReward}`,
  );

  const score = Math.round(factors.reduce((s, f) => s + f.points, 0));
  const conflicts = factors.filter((f) => f.grade === "conflicting");

  const arabic =
    `درجة الجودة ${score}/100. ` +
    (conflicts.length > 0
      ? `⚠️ ${conflicts.length} عامل يعارض: ${conflicts.map((c) => c.label).join("، ")}. ` +
        "الدرجة وحدها لا تكفي حين يتعارض عامل جوهري."
      : "لا عامل معارض.") +
    " هذه الدرجة ليست احتمال ربح — إنها قياس لمقدار الأدلّة المستقلّة التي اصطفّت.";

  return { score, factors, conflicts, arabic };
}
