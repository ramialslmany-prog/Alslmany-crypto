/**
 * Multi-timeframe confluence and the flow rule.
 *
 * THE FLOW RULE, stated precisely because everything here depends on it:
 *   - The HIGHER timeframe decides which DIRECTION is permitted.
 *   - The LOWER timeframe decides only the TIMING of entry.
 *   - If the trading timeframe disagrees with the timeframe TWO RUNGS ABOVE
 *     it, the setup is rejected outright.
 *
 * Two rungs, not one. One rung apart is ordinary noise — a 1h pullback inside
 * a 4h uptrend is what a pullback entry IS, and rejecting it would reject the
 * best setups. Two rungs apart is a genuine structural disagreement: trading
 * long on 1h while the daily is in a downtrend means fighting the tide with
 * the surface chop.
 *
 * Ladder: 5m → 15m → 1h → 4h → 1d → 1w
 * So a 1h trade is anchored to 1d; a 15m trade to 4h; a 4h trade to 1w.
 *
 * When a timeframe two rungs up does not exist (a 1d or 1w trade), the highest
 * available timeframe becomes the anchor — there is nothing above it to
 * disagree with.
 */
import { TF_ORDER, type Timeframe, tfIndex } from "@/shared/time";
import { BIAS_AR, type Bias, type Conflict, type ConfluenceResult, type TimeframeAnalysis } from "@/core/analysis/types";

/**
 * How much each timeframe counts toward the overall agreement score.
 *
 * Weighted toward the higher timeframes on purpose: a 5m disagreement is
 * noise, a weekly disagreement is the market.
 */
const TF_WEIGHT: Record<Timeframe, number> = {
  "5m": 0.5,
  "15m": 0.8,
  "1h": 1.2,
  "4h": 1.6,
  "1d": 2.0,
  "1w": 1.5, // slightly below daily: the weekly turns too slowly to time with
};

const fmt = (n: number, d = 0): string =>
  Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";

/** The timeframe two rungs above `tf`, or the highest one that exists. */
export function anchorFor(tf: Timeframe, available: readonly Timeframe[]): Timeframe {
  const wanted = TF_ORDER[Math.min(tfIndex(tf) + 2, TF_ORDER.length - 1)];
  if (available.includes(wanted)) return wanted;
  // Fall back to the highest available timeframe at or above `tf`.
  const higher = available.filter((t) => tfIndex(t) > tfIndex(tf)).sort((a, b) => tfIndex(b) - tfIndex(a));
  return higher[0] ?? tf;
}

export interface ConfluenceOptions {
  /** The timeframe the trade would actually be executed on. */
  readonly tradingTimeframe: Timeframe;
  /** Direction the macro stage allows this cycle; intersected with our own. */
  readonly macroAllowed?: "long" | "short" | "both" | "none";
}

export function analyzeConfluence(
  analyses: readonly TimeframeAnalysis[],
  opts: ConfluenceOptions,
): ConfluenceResult {
  const available = analyses.map((a) => a.timeframe);
  const byTf = new Map(analyses.map((a) => [a.timeframe, a]));

  const perTimeframe = analyses.map((a) => ({
    timeframe: a.timeframe,
    bias: a.bias,
    score: a.score,
    strength: a.strength,
  }));

  // ── agreement ────────────────────────────────────────────────────────────
  // Weighted mean of the directional scores, then converted to 0..100 by how
  // far the timeframes are from cancelling each other out.
  let weightSum = 0;
  let weightedScore = 0;
  for (const a of analyses) {
    const w = TF_WEIGHT[a.timeframe];
    weightSum += w;
    weightedScore += a.score * w;
  }
  const meanScore = weightSum > 0 ? weightedScore / weightSum : 0;

  // Dispersion: how much the timeframes scatter around that mean. Low
  // dispersion with a strong mean is real confluence; a strong mean produced
  // by two violently opposed groups is not.
  let dispersion = 0;
  for (const a of analyses) {
    dispersion += TF_WEIGHT[a.timeframe] * Math.abs(a.score - meanScore);
  }
  dispersion = weightSum > 0 ? dispersion / weightSum : 0;

  const directionStrength = Math.min(100, Math.abs(meanScore));
  const cohesion = Math.max(0, 100 - dispersion);
  const agreement = Math.round(directionStrength * 0.5 + cohesion * 0.5);

  const dominantBias: Bias = meanScore > 15 ? "bullish" : meanScore < -15 ? "bearish" : "neutral";

  // ── conflicts ────────────────────────────────────────────────────────────
  const conflicts: Conflict[] = [];
  for (let i = 0; i < analyses.length; i++) {
    for (let j = i + 1; j < analyses.length; j++) {
      const lower = analyses[i];
      const higher = analyses[j];
      if (tfIndex(higher.timeframe) <= tfIndex(lower.timeframe)) continue;
      // Only opposed readings count; neutral is not a conflict, it is silence.
      if (lower.bias === "neutral" || higher.bias === "neutral") continue;
      if (lower.bias === higher.bias) continue;

      const levels = tfIndex(higher.timeframe) - tfIndex(lower.timeframe);
      // Fatal only when it is the trading timeframe against its own anchor.
      const fatal = levels >= 2 && lower.timeframe === opts.tradingTimeframe;

      conflicts.push({
        lower: lower.timeframe,
        higher: higher.timeframe,
        lowerBias: lower.bias,
        higherBias: higher.bias,
        levels,
        fatal,
        arabic:
          `${lower.timeframe} ${BIAS_AR[lower.bias]} بينما ${higher.timeframe} ${BIAS_AR[higher.bias]}` +
          ` — فارق ${levels} ${levels === 1 ? "مستوى" : "مستويات"}.` +
          (fatal
            ? ` هذا تعارض قاتل: إطار التداول يخالف إطاره المرجعي بمستويين، والصفقة تسقط.`
            : levels === 1
              ? ` فارق مستوى واحد طبيعي — هذا هو الارتداد داخل الاتجاه.`
              : ` تعارض هيكلي يخفض الثقة.`),
      });
    }
  }

  // ── the flow rule ────────────────────────────────────────────────────────
  const anchorTimeframe = anchorFor(opts.tradingTimeframe, available);
  const anchor = byTf.get(anchorTimeframe);
  const trading = byTf.get(opts.tradingTimeframe);
  const anchorBias: Bias = anchor?.bias ?? "neutral";

  let allowedDirection: ConfluenceResult["allowedDirection"];
  if (anchorBias === "bullish") allowedDirection = "long";
  else if (anchorBias === "bearish") allowedDirection = "short";
  else allowedDirection = "both"; // a neutral anchor forbids nothing

  // Intersect with whatever the macro stage permits.
  if (opts.macroAllowed && opts.macroAllowed !== "both") {
    if (opts.macroAllowed === "none") allowedDirection = "none";
    else if (allowedDirection === "both") allowedDirection = opts.macroAllowed;
    else if (allowedDirection !== opts.macroAllowed) allowedDirection = "none";
  }

  const fatalConflict = conflicts.some((c) => c.fatal);
  const tradingOpposesAnchor =
    trading != null &&
    anchor != null &&
    trading.bias !== "neutral" &&
    anchorBias !== "neutral" &&
    trading.bias !== anchorBias;

  const verdict: ConfluenceResult["verdict"] =
    fatalConflict || tradingOpposesAnchor || allowedDirection === "none" ? "fail" : "pass";

  return {
    agreement,
    dominantBias,
    tradingTimeframe: opts.tradingTimeframe,
    anchorTimeframe,
    anchorBias,
    perTimeframe,
    conflicts,
    allowedDirection,
    verdict,
    arabic: narrate({
      analyses, agreement, dominantBias, conflicts, anchorTimeframe, anchorBias,
      tradingTimeframe: opts.tradingTimeframe, tradingBias: trading?.bias ?? "neutral",
      allowedDirection, verdict, meanScore,
    }),
  };
}

function narrate(x: {
  analyses: readonly TimeframeAnalysis[];
  agreement: number;
  dominantBias: Bias;
  conflicts: readonly Conflict[];
  anchorTimeframe: Timeframe;
  anchorBias: Bias;
  tradingTimeframe: Timeframe;
  tradingBias: Bias;
  allowedDirection: ConfluenceResult["allowedDirection"];
  verdict: ConfluenceResult["verdict"];
  meanScore: number;
}): string {
  const parts: string[] = [];

  // Say what each timeframe says — the spec asks for this explicitly.
  const roll = x.analyses
    .slice()
    .sort((a, b) => tfIndex(a.timeframe) - tfIndex(b.timeframe))
    .map((a) => `${a.timeframe}: ${BIAS_AR[a.bias]} (${fmt(a.score)})`)
    .join(" · ");
  parts.push(`قراءة الأطر — ${roll}.`);

  parts.push(
    `درجة الاتفاق ${x.agreement} من 100، والميل الغالب ${BIAS_AR[x.dominantBias]} بمتوسط مرجّح ${fmt(x.meanScore)}.`,
  );

  parts.push(
    `إطار التداول ${x.tradingTimeframe} (${BIAS_AR[x.tradingBias]}) وإطاره المرجعي ${x.anchorTimeframe} (${BIAS_AR[x.anchorBias]}).`,
  );

  const fatal = x.conflicts.filter((c) => c.fatal);
  const structural = x.conflicts.filter((c) => !c.fatal && c.levels >= 2);
  const minor = x.conflicts.filter((c) => c.levels === 1);

  if (fatal.length > 0) {
    parts.push(`تعارض قاتل: ${fatal.map((c) => c.arabic).join(" ")}`);
  } else if (structural.length > 0) {
    parts.push(`تعارضات هيكلية تخفض الثقة: ${structural.map((c) => `${c.lower}/${c.higher}`).join("، ")}.`);
  } else if (minor.length > 0) {
    parts.push(`التعارضات الموجودة كلها بفارق مستوى واحد، وهي طبيعية داخل الاتجاه.`);
  } else {
    parts.push("لا تعارض بين أي إطارين.");
  }

  parts.push(
    x.allowedDirection === "none"
      ? "الاتجاه المسموح: لا شيء — لا تُفتح صفقة في هذه الدورة."
      : x.allowedDirection === "both"
        ? "الاتجاه المسموح: الشراء والبيع كلاهما — الإطار المرجعي محايد."
        : `الاتجاه المسموح: ${x.allowedDirection === "long" ? "الشراء فقط" : "البيع فقط"}، لأن الإطار المرجعي ${x.anchorTimeframe} ${BIAS_AR[x.anchorBias]}.`,
  );

  parts.push(x.verdict === "pass" ? "النتيجة: تمرّ إلى المرحلة التالية." : "النتيجة: تسقط هنا.");

  return parts.join(" ");
}

export const __testing = { TF_WEIGHT };
