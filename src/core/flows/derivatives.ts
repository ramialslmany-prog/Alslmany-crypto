/**
 * Derivatives: funding, open interest, positioning, liquidation clusters.
 *
 * The single most important idea here: A FUNDING RATE MEANS NOTHING IN
 * ISOLATION. 0.01% is neutral on one asset and extreme on another, and the
 * same asset's normal changes across regimes. Every reading below is placed
 * inside its OWN trailing distribution, which is what makes "extreme"
 * a measurable claim rather than a feeling.
 */
import { percentileRank } from "@/core/indicators/series";
import type { FundingRate, LongShortRatio, OpenInterest } from "@/core/types";

export interface FundingRead {
  readonly current: number;
  /** Annualised, so it is comparable to any other yield. */
  readonly annualizedPct: number;
  /** 0..1 — where this rate sits in its own trailing history. */
  readonly percentile: number | null;
  readonly extreme: "none" | "high" | "low";
  readonly samples: number;
  readonly arabic: string;
}

/** Above/below these percentiles of its own history, funding is crowded. */
const FUNDING_HIGH_PERCENTILE = 0.9;
const FUNDING_LOW_PERCENTILE = 0.1;
/** Below this many samples, a percentile is not a claim worth making. */
const MIN_FUNDING_SAMPLES = 30;

export function analyzeFunding(
  current: FundingRate,
  history: readonly FundingRate[],
): FundingRead {
  const rates = history.map((f) => f.rate).filter(Number.isFinite);
  const intervalsPerYear = (24 / (current.intervalHours || 8)) * 365;
  const annualizedPct = current.rate * intervalsPerYear * 100;

  if (rates.length < MIN_FUNDING_SAMPLES) {
    return {
      current: current.rate,
      annualizedPct,
      percentile: null,
      extreme: "none",
      samples: rates.length,
      arabic:
        `معدّل التمويل ${(current.rate * 100).toFixed(4)}% كل ${current.intervalHours} ساعات ` +
        `(${annualizedPct.toFixed(1)}% سنوياً). ` +
        `التاريخ ${rates.length} قراءة فقط — أقل من ${MIN_FUNDING_SAMPLES}، ` +
        `فلا يمكن القول إن هذا المعدّل متطرّف أو عادي. الرقم وحده لا يعني شيئاً.`,
    };
  }

  const percentile = percentileRank(rates, current.rate);
  const extreme: FundingRead["extreme"] =
    percentile >= FUNDING_HIGH_PERCENTILE ? "high" :
    percentile <= FUNDING_LOW_PERCENTILE ? "low" : "none";

  return {
    current: current.rate,
    annualizedPct,
    percentile,
    extreme,
    samples: rates.length,
    arabic:
      `معدّل التمويل ${(current.rate * 100).toFixed(4)}% (${annualizedPct.toFixed(1)}% سنوياً)، ` +
      `وهو في المئوي ${(percentile * 100).toFixed(0)} من تاريخه على ${rates.length} قراءة. ` +
      (extreme === "high"
        ? "تمويل مرتفع بشدّة مقارنة بنفسه — المضاربون على الصعود يدفعون ثمناً باهظاً للبقاء، والسوق مزدحم في جانب الشراء."
        : extreme === "low"
          ? "تمويل منخفض بشدّة مقارنة بنفسه — السوق مزدحم في جانب البيع."
          : "ضمن مداه الطبيعي."),
  };
}

export interface OpenInterestRead {
  readonly current: number;
  readonly changePct: number | null;
  readonly samples: number;
  readonly arabic: string;
}

export function analyzeOpenInterest(history: readonly OpenInterest[]): OpenInterestRead {
  const values = history.map((o) => o.openInterest).filter((v) => Number.isFinite(v) && v > 0);
  if (values.length < 2) {
    return { current: NaN, changePct: null, samples: values.length, arabic: "تاريخ العقود المفتوحة غير كافٍ." };
  }
  const first = values[0];
  const current = values[values.length - 1];
  const changePct = ((current - first) / first) * 100;

  return {
    current,
    changePct,
    samples: values.length,
    arabic:
      `العقود المفتوحة ${changePct >= 0 ? "ارتفعت" : "انخفضت"} ${Math.abs(changePct).toFixed(2)}% ` +
      `خلال النافذة (${values.length} قراءة).`,
  };
}

export interface PositioningRead {
  readonly longPct: number;
  readonly shortPct: number;
  readonly ratio: number;
  readonly percentile: number | null;
  readonly arabic: string;
}

export function analyzePositioning(history: readonly LongShortRatio[]): PositioningRead | null {
  const valid = history.filter((x) => Number.isFinite(x.ratio) && x.ratio > 0);
  if (valid.length === 0) return null;
  const last = valid[valid.length - 1];
  const ratios = valid.map((x) => x.ratio);
  const percentile = ratios.length >= 20 ? percentileRank(ratios, last.ratio) : null;

  return {
    longPct: last.longAccountPct,
    shortPct: last.shortAccountPct,
    ratio: last.ratio,
    percentile,
    arabic:
      `${last.longAccountPct.toFixed(1)}% من الحسابات في الشراء مقابل ${last.shortAccountPct.toFixed(1)}% في البيع ` +
      `(نسبة ${last.ratio.toFixed(2)})` +
      (percentile != null
        ? `، وهي في المئوي ${(percentile * 100).toFixed(0)} من تاريخها.`
        : ` — التاريخ قصير، فلا يمكن وصفها بالمتطرّفة.`) +
      " ونسبة الحسابات ليست نسبة رأس المال: كثرة الحسابات الصغيرة في جانب لا تعني ثقل السيولة فيه.",
  };
}

// ── liquidation clusters ─────────────────────────────────────────────────────

export interface LiquidationCluster {
  readonly price: number;
  readonly side: "long" | "short";
  /** Estimated leveraged notional that would be forced out at this price. */
  readonly estimatedNotional: number;
  readonly distancePct: number;
}

/**
 * Estimate where leveraged positions would be forced out.
 *
 * WITHOUT AN AGGREGATED PROVIDER THIS IS A MODEL, NOT A MEASUREMENT. It maps
 * open interest onto the common leverage tiers and reports where the pain
 * would be — which is a reasonable prior, and is labelled as one. Coinglass
 * supplies the real thing; until a key is present this is clearly marked
 * `estimated` and the stage says so in Arabic.
 */
export function estimateLiquidationClusters(
  price: number,
  openInterestNotional: number,
  leverageTiers: readonly number[] = [10, 25, 50, 100],
): LiquidationCluster[] {
  if (!(price > 0) || !(openInterestNotional > 0)) return [];

  // Weight toward lower leverage: most notional sits in modest leverage, and
  // assuming an even split across tiers would exaggerate the 100x cluster.
  const weights = leverageTiers.map((_, i) => 1 / (i + 1) ** 1.6);
  const weightSum = weights.reduce((s, w) => s + w, 0);

  const out: LiquidationCluster[] = [];
  leverageTiers.forEach((lev, i) => {
    const share = (weights[i] / weightSum) * openInterestNotional;
    // A long at L× is liquidated roughly L% below entry (ignoring fees).
    const drop = price * (1 - 1 / lev);
    const rise = price * (1 + 1 / lev);
    out.push({
      price: drop, side: "long", estimatedNotional: share / 2,
      distancePct: ((drop - price) / price) * 100,
    });
    out.push({
      price: rise, side: "short", estimatedNotional: share / 2,
      distancePct: ((rise - price) / price) * 100,
    });
  });

  return out.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct));
}

// ── the composite readings the spec names ────────────────────────────────────

export type CompositeKind =
  | "leveraged_fragile"   // price up + OI up + funding high → funded by leverage
  | "genuine_spot"        // price up + OI flat/down + delta positive → real buying
  | "crowded_against"     // funding extreme in the trade's direction → veto
  | "short_squeeze_fuel"  // price up + OI up + funding LOW → shorts trapped
  | "none";

export interface CompositeRead {
  readonly kind: CompositeKind;
  /** Multiplier applied to confidence: <1 lowers it, >1 raises it. */
  readonly confidenceMultiplier: number;
  /** True when this reading alone rejects the trade. */
  readonly veto: boolean;
  readonly arabic: string;
}

/**
 * The three composite readings the specification requires, applied literally.
 *
 * Each combines price with positioning, because either alone is ambiguous:
 * a rise on rising open interest and expensive funding is a LEVERAGED rise
 * that unwinds violently, while the same rise on flat open interest is spot
 * demand that does not.
 */
export function compositeRead(x: {
  priceChangePct: number;
  openInterestChangePct: number | null;
  funding: FundingRead;
  cvdNetRatio: number | null;
  direction: "long" | "short";
}): CompositeRead {
  const priceUp = x.priceChangePct > 0;
  const oiUp = x.openInterestChangePct != null && x.openInterestChangePct > 2;
  const oiFlat = x.openInterestChangePct != null && Math.abs(x.openInterestChangePct) <= 2;
  const oiDown = x.openInterestChangePct != null && x.openInterestChangePct < -2;

  // 1. Funding extreme AGAINST the trade — the market is crowded on our side.
  const crowdedLong = x.direction === "long" && x.funding.extreme === "high";
  const crowdedShort = x.direction === "short" && x.funding.extreme === "low";
  if (crowdedLong || crowdedShort) {
    return {
      kind: "crowded_against",
      confidenceMultiplier: 0,
      veto: true,
      arabic:
        `التمويل متطرّف في نفس اتجاه الصفقة (المئوي ${((x.funding.percentile ?? 0) * 100).toFixed(0)}). ` +
        `السوق مزدحم في جانبك: من يدفع التمويل هو من سيُصفّى أولاً عند أول ارتداد. الصفقة تسقط.`,
    };
  }

  // 2. Rise funded by leverage — fragile.
  if (priceUp && oiUp && x.funding.percentile != null && x.funding.percentile > 0.7) {
    return {
      kind: "leveraged_fragile",
      confidenceMultiplier: 0.75,
      veto: false,
      arabic:
        "سعر صاعد مع عقود مفتوحة صاعدة وتمويل مرتفع — ارتفاع مموّل برافعة لا بنقد. " +
        "هذه الارتفاعات تنهار أسرع مما تصعد، لأن كل مركز فيها لديه سعر تصفية. خُفضت الثقة.",
    };
  }

  // 3. Genuine spot demand.
  if (priceUp && (oiFlat || oiDown) && x.cvdNetRatio != null && x.cvdNetRatio > 0.05) {
    return {
      kind: "genuine_spot",
      confidenceMultiplier: 1.15,
      veto: false,
      arabic:
        "سعر صاعد مع عقود مفتوحة ثابتة أو منخفضة ودلتا إيجابية — شراء نقدي حقيقي لا رافعة. " +
        "هذه الارتفاعات أمتن لأنها لا تحمل مراكز مُهدّدة بالتصفية. رُفعت الثقة.",
    };
  }

  // 4. Shorts trapped in a rise — fuel rather than fragility.
  if (priceUp && oiUp && x.funding.extreme === "low") {
    return {
      kind: "short_squeeze_fuel",
      confidenceMultiplier: 1.1,
      veto: false,
      arabic:
        "سعر صاعد مع عقود مفتوحة صاعدة وتمويل منخفض — البائعون هم من يفتحون المراكز، " +
        "وكل ارتفاع يزيد الضغط عليهم. وقود لاستمرار الصعود لا خطر عليه.",
    };
  }

  return {
    kind: "none",
    confidenceMultiplier: 1,
    veto: false,
    arabic: "لا تنطبق أي قراءة مركّبة واضحة على التدفّقات والمشتقّات.",
  };
}
