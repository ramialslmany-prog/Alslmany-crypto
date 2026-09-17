/**
 * The eight-stage contract.
 *
 * The governing principle of the whole project: the bot does not emit a
 * signal. It walks eight mandatory stages IN ORDER, and every stage can stop
 * it. If a stage fails, the pipeline halts immediately and records exactly
 * where and why — and that record is as visible on the site as a passing one.
 *
 * Every stage returns the same shape so the site renders all eight
 * identically, and so a rejected analysis is as auditable as an accepted one.
 * A bot that only shows its wins is worthless.
 */
import type { Factor, Bias } from "@/core/analysis/types";
import type { Timeframe } from "@/shared/time";

export const STAGE_IDS = [
  "eligibility",
  "macro",
  "technical",
  "structure",
  "flows",
  "onchain",
  "sentiment",
  "council",
] as const;

export type StageId = (typeof STAGE_IDS)[number];

export const STAGE_NAMES_AR: Record<StageId, string> = {
  eligibility: "فلتر الأهلية",
  macro: "السياق الكلي",
  technical: "التحليل الفني",
  structure: "الهيكل والمستويات والأنماط",
  flows: "التدفّقات والمشتقّات",
  onchain: "بيانات السلسلة",
  sentiment: "المشاعر والأخبار والمخاطر",
  council: "المجلس النهائي",
};

export const STAGE_NUMBER: Record<StageId, number> = {
  eligibility: 1, macro: 2, technical: 3, structure: 4,
  flows: 5, onchain: 6, sentiment: 7, council: 8,
};

/**
 * `unavailable` is NOT a failure. It means the stage could not read its
 * inputs — no API key, a dead provider — so it declines to vote and the
 * confidence score takes a declared, visible penalty. Treating "I don't know"
 * as "no objection" is how a bot ends up confident about nothing.
 */
export type StageStatus = "pass" | "fail" | "unavailable";

export interface StageResult {
  readonly id: StageId;
  readonly number: number;
  readonly name: string;
  readonly status: StageStatus;
  /** −100..100 directional, or 0..100 for non-directional stages. */
  readonly score: number;
  readonly bias: Bias;
  readonly factors: readonly Factor[];
  /** Populated when status is "fail" — the exact reason, in Arabic. */
  readonly failReason: string | null;
  /** Populated when status is "unavailable". */
  readonly unavailableReason: string | null;
  /** How much this stage's absence should cost the confidence score, 0..1. */
  readonly confidencePenalty: number;
  readonly warnings: readonly string[];
  readonly arabic: string;
  /** Age of the oldest input this stage relied on, in ms. Drives freshness. */
  readonly dataAgeMs: number | null;
  readonly durationMs: number;
}

export function stagePass(
  id: StageId,
  x: Omit<StageResult, "id" | "number" | "name" | "status" | "failReason" | "unavailableReason">,
): StageResult {
  return {
    id, number: STAGE_NUMBER[id], name: STAGE_NAMES_AR[id],
    status: "pass", failReason: null, unavailableReason: null, ...x,
  };
}

export function stageFail(
  id: StageId,
  reason: string,
  x: Partial<Omit<StageResult, "id" | "number" | "name" | "status" | "failReason">> = {},
): StageResult {
  return {
    id, number: STAGE_NUMBER[id], name: STAGE_NAMES_AR[id],
    status: "fail",
    score: x.score ?? 0,
    bias: x.bias ?? "neutral",
    factors: x.factors ?? [],
    failReason: reason,
    unavailableReason: null,
    confidencePenalty: x.confidencePenalty ?? 0,
    warnings: x.warnings ?? [],
    arabic: x.arabic ?? reason,
    dataAgeMs: x.dataAgeMs ?? null,
    durationMs: x.durationMs ?? 0,
  };
}

export function stageUnavailable(
  id: StageId,
  reason: string,
  confidencePenalty: number,
  x: Partial<StageResult> = {},
): StageResult {
  return {
    id, number: STAGE_NUMBER[id], name: STAGE_NAMES_AR[id],
    status: "unavailable",
    score: 0,
    bias: "neutral",
    factors: x.factors ?? [],
    failReason: null,
    unavailableReason: reason,
    confidencePenalty,
    warnings: x.warnings ?? [],
    arabic: `${STAGE_NAMES_AR[id]}: غير متاحة — ${reason}. خُفضت الثقة الكلية بنسبة ${Math.round(confidencePenalty * 100)}%.`,
    dataAgeMs: null,
    durationMs: x.durationMs ?? 0,
  };
}

// ── market regime ────────────────────────────────────────────────────────────

export type MarketRegime = "trending_up" | "trending_down" | "ranging" | "high_volatility";

export const REGIME_AR: Record<MarketRegime, string> = {
  trending_up: "اتجاه صاعد",
  trending_down: "اتجاه هابط",
  ranging: "سوق عرضي",
  high_volatility: "تقلّب عالٍ",
};

// ── setup classification ─────────────────────────────────────────────────────

/**
 * The six setups the spec names. A high score with NO recognisable setup is
 * explicitly not an opportunity — the council refuses to trade a number it
 * cannot name a reason for.
 */
export type SetupKind =
  | "trend_continuation"
  | "breakout_retest"
  | "range_reversal"
  | "momentum_ignition"
  | "divergence_reversal"
  | "liquidity_sweep"
  // ── the families most crypto traders and signal channels actually post ──
  //
  // Added because the six above are a systematic trader's taxonomy, and the
  // market talks in a different one. These are not endorsed by being here:
  // popularity is not evidence, and `--compare-setups` ranks them against the
  // others on real data precisely so the question can be settled by
  // measurement rather than by how often a strategy is posted.
  | "order_block"
  | "fvg_fill"
  | "ema_pullback"
  | "rsi_reversal";

/**
 * Every setup, as a list.
 *
 * Exported so a study can iterate them: "which strategy is best" is only
 * answerable by running each one alone over the same prices, and that needs
 * the set to exist somewhere other than in a type.
 */
export const SETUP_KINDS: readonly SetupKind[] = [
  "trend_continuation",
  "breakout_retest",
  "range_reversal",
  "momentum_ignition",
  "divergence_reversal",
  "liquidity_sweep",
  "order_block",
  "fvg_fill",
  "ema_pullback",
  "rsi_reversal",
];

export const SETUP_AR: Record<SetupKind, string> = {
  trend_continuation: "استمرار اتجاه بعد ارتداد",
  breakout_retest: "اختراق وإعادة اختبار",
  range_reversal: "انعكاس نطاق",
  momentum_ignition: "اشتعال زخم",
  divergence_reversal: "انعكاس بانحراف",
  liquidity_sweep: "كنس سيولة واسترداد",
  order_block: "كتلة أوامر (Order Block)",
  fvg_fill: "ملء فجوة قيمة عادلة (FVG)",
  ema_pullback: "ارتداد إلى المتوسط المتحرّك",
  rsi_reversal: "انعكاس تشبّع RSI عند مستوى",
};

/**
 * Which setups each regime permits.
 *
 * This is the spec's rule made structural: reversal setups are struck out
 * entirely in a trending market, and breakout setups are struck out entirely
 * in a range. Not down-weighted — REMOVED. A mean-reversion trade in a strong
 * trend and a breakout trade in a chop are the two ways traders lose money
 * most reliably, and neither is a matter of degree.
 */
export const REGIME_ALLOWED_SETUPS: Record<MarketRegime, readonly SetupKind[]> = {
  trending_up: [
    "trend_continuation", "breakout_retest", "momentum_ignition", "liquidity_sweep",
    "order_block", "fvg_fill", "ema_pullback",
  ],
  trending_down: [
    "trend_continuation", "breakout_retest", "momentum_ignition", "liquidity_sweep",
    "order_block", "fvg_fill", "ema_pullback",
  ],
  // Reversal families only. An order block or an FVG is a continuation idea:
  // both assume an impulsive move worth returning to, and a range has none.
  ranging: ["range_reversal", "divergence_reversal", "liquidity_sweep", "rsi_reversal"],
  high_volatility: ["liquidity_sweep", "trend_continuation"],
};

export interface SetupMatch {
  readonly kind: SetupKind;
  readonly direction: "long" | "short";
  /** 0..1 — how cleanly the conditions fit. */
  readonly fit: number;
  /** Each condition and whether it held, so the site can show the reasoning. */
  readonly conditions: readonly { label: string; met: boolean; detail: string }[];
  readonly arabic: string;
}

// ── veto filters ─────────────────────────────────────────────────────────────

export type VetoId =
  | "score_below_minimum"
  | "risk_reward_too_low"
  | "direction_not_allowed"
  | "correlated_exposure"
  | "exposure_limit"
  | "stale_data"
  | "no_setup_match"
  | "no_valid_stop"
  | "no_valid_target"
  | "circuit_breaker";

export interface Veto {
  readonly id: VetoId;
  readonly arabic: string;
  /** The value that tripped it and the threshold it failed. */
  readonly actual: string;
  readonly threshold: string;
}

// ── the full run ─────────────────────────────────────────────────────────────

export interface PipelineRun {
  readonly symbol: string;
  readonly tradingTimeframe: Timeframe;
  readonly startedAt: number;
  readonly finishedAt: number;
  /** Every stage attempted, in order. Stops at the first failure. */
  readonly stages: readonly StageResult[];
  /** Where it stopped, or null if all eight completed. */
  readonly failedAt: StageId | null;
  readonly regime: MarketRegime | null;
  readonly setup: SetupMatch | null;
  readonly vetoes: readonly Veto[];
  readonly finalScore: number;
  readonly confidence: number;
  /** Null when no recommendation was produced — the usual outcome. */
  readonly recommendationId: string | null;
  readonly arabic: string;
}
