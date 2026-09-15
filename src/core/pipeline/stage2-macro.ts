/**
 * Stage 2 — macro context.
 *
 * Its output is a permission, not a score: WHICH DIRECTION IS ALLOWED this
 * cycle. Everything downstream is subordinate to it.
 *
 * Two rules the spec states and this file enforces literally:
 *
 *  1. If Bitcoin is breaking down, NO long is permitted on any altcoin,
 *     however good it looks technically. In a real drawdown correlations go
 *     to one and every alt falls together; a beautiful setup is simply a
 *     beautiful way to lose money that week.
 *
 *  2. If the coin's 30-day correlation to BTC exceeds 0.85, its "independent"
 *     technical analysis is not independent — it is a leveraged read of
 *     Bitcoin. Confidence is cut and the report says so out loud.
 */
import { stagePass, stageUnavailable, type StageResult } from "@/core/pipeline/types";
import { adx } from "@/core/indicators/trend";
import { atrPercentile } from "@/core/indicators/volatility";
import { sma, slopePct } from "@/core/indicators";
import type { Bias, Factor } from "@/core/analysis/types";
import type { AllowedDirection, Candle, FearGreed, GlobalMarket } from "@/core/types";
import { type Availability, isAvailable } from "@/shared/availability";

export interface MacroInput {
  readonly symbol: string;
  /** Bitcoin's own candles — the reference asset. */
  readonly btcDaily: readonly Candle[];
  readonly btc4h: readonly Candle[];
  /** The candidate's daily candles, for the correlation measurement. */
  readonly assetDaily: readonly Candle[];
  readonly global: Availability<GlobalMarket>;
  /** Dominance history, newest last, for the trend of dominance. */
  readonly dominanceHistory: Availability<readonly { value: number; timestamp: number }[]>;
  readonly fearGreed: Availability<FearGreed>;
  readonly now: number;
  /** Above this, the asset is not analysed independently. */
  readonly correlationCeiling: number;
}

export interface MacroResult extends StageResult {
  readonly allowedDirection: AllowedDirection;
  readonly btcCorrelation: number | null;
  readonly independentAnalysis: boolean;
}

const fmt = (n: number, d = 2): string =>
  Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";

/** Arabic label for a direction permission, shared so no caller re-spells it. */
export function directionLabelAr(d: AllowedDirection): string {
  switch (d) {
    case "both": return "الشراء والبيع";
    case "long": return "الشراء فقط";
    case "short": return "البيع فقط";
    case "none": return "لا شيء";
  }
}

/**
 * Pearson correlation of DAILY RETURNS, not of prices.
 *
 * Correlating raw prices is a classic error: any two assets that both drifted
 * up over the window correlate near 1 whatever their day-to-day behaviour.
 * Returns measure what actually matters — do they move together.
 */
export function returnCorrelation(
  a: readonly Candle[],
  b: readonly Candle[],
  periods = 30,
): number | null {
  const returnsOf = (c: readonly Candle[]): { t: number; r: number }[] => {
    const out: { t: number; r: number }[] = [];
    for (let i = 1; i < c.length; i++) {
      const prev = c[i - 1].close;
      if (prev > 0) out.push({ t: c[i].openTime, r: (c[i].close - prev) / prev });
    }
    return out;
  };

  const ra = returnsOf(a);
  const rb = returnsOf(b);
  if (ra.length < periods || rb.length < periods) return null;

  // Align on shared timestamps: two series with different histories would
  // otherwise be compared bar-index to bar-index across different dates.
  const byTime = new Map(rb.map((x) => [x.t, x.r]));
  const pairs: [number, number][] = [];
  for (const x of ra) {
    const y = byTime.get(x.t);
    if (y !== undefined) pairs.push([x.r, y]);
  }
  const window = pairs.slice(-periods);
  if (window.length < Math.min(periods, 20)) return null;

  const n = window.length;
  const meanX = window.reduce((s, p) => s + p[0], 0) / n;
  const meanY = window.reduce((s, p) => s + p[1], 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (const [x, y] of window) {
    num += (x - meanX) * (y - meanY);
    dx += (x - meanX) ** 2;
    dy += (y - meanY) ** 2;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? null : num / denom;
}

/** Bitcoin's state on one timeframe, as a directional score. */
function btcState(candles: readonly Candle[]): { score: number; bias: Bias; note: string } {
  if (candles.length < 60) {
    return { score: 0, bias: "neutral", note: "تاريخ البيتكوين غير كافٍ على هذا الإطار" };
  }
  const close = candles.map((c) => c.close);
  const i = candles.length - 1;
  const ma50 = sma(close, 50);
  const ma200 = sma(close, 200);
  const dmi = adx(candles, 14);

  const price = close[i];
  let score = 0;
  const notes: string[] = [];

  if (Number.isFinite(ma50[i])) {
    const above = price > ma50[i];
    score += above ? 25 : -25;
    notes.push(above ? "فوق المتوسط 50" : "تحت المتوسط 50");
  }
  if (Number.isFinite(ma200[i])) {
    const above = price > ma200[i];
    score += above ? 30 : -30;
    notes.push(above ? "فوق المتوسط 200" : "تحت المتوسط 200");
  }
  const slope = slopePct(ma50, 10)[i];
  if (Number.isFinite(slope)) {
    score += Math.max(-20, Math.min(20, slope * 40));
    notes.push(slope > 0 ? "المتوسط 50 يميل صعوداً" : "المتوسط 50 يميل هبوطاً");
  }
  if (Number.isFinite(dmi.adx[i]) && Number.isFinite(dmi.plusDi[i])) {
    const directional = dmi.plusDi[i] > dmi.minusDi[i] ? 1 : -1;
    const strength = Math.min(1, dmi.adx[i] / 40);
    score += directional * strength * 25;
    notes.push(`ADX ${fmt(dmi.adx[i], 1)}`);
  }

  score = Math.max(-100, Math.min(100, score));
  return {
    score,
    bias: score > 15 ? "bullish" : score < -15 ? "bearish" : "neutral",
    note: notes.join("، "),
  };
}

/** Bitcoin is "breaking down" when the daily is decisively bearish. */
const BTC_BREAKDOWN_THRESHOLD = -45;

export function runMacro(input: MacroInput): MacroResult {
  const started = Date.now();
  const factors: Factor[] = [];
  const warnings: string[] = [];

  const base = (extra: Partial<MacroResult>): MacroResult => ({
    ...stagePass("macro", {
      score: 0, bias: "neutral", factors, confidencePenalty: 0,
      warnings, arabic: "", dataAgeMs: null, durationMs: Date.now() - started,
    }),
    allowedDirection: "both",
    btcCorrelation: null,
    independentAnalysis: true,
    ...extra,
  });

  if (input.btcDaily.length < 60) {
    return {
      ...stageUnavailable("macro", "تاريخ البيتكوين اليومي غير كافٍ لتقييم السياق الكلي", 0.25, {
        durationMs: Date.now() - started,
      }),
      allowedDirection: "none",
      btcCorrelation: null,
      independentAnalysis: false,
    };
  }

  // ── Bitcoin on the daily and the 4h ──────────────────────────────────────
  const daily = btcState(input.btcDaily);
  const fourHour = btcState(input.btc4h);

  factors.push({
    id: "btc_daily", label: "البيتكوين على اليومي", value: daily.score,
    display: `${fmt(daily.score, 0)} (${daily.bias === "bullish" ? "صاعد" : daily.bias === "bearish" ? "هابط" : "محايد"})`,
    contribution: daily.score * 0.4,
    note: daily.note,
  });
  factors.push({
    id: "btc_4h", label: "البيتكوين على الأربع ساعات", value: fourHour.score,
    display: `${fmt(fourHour.score, 0)}`,
    contribution: fourHour.score * 0.2,
    note: fourHour.note,
  });

  // ── dominance and its trend ──────────────────────────────────────────────
  let dominance: number | null = null;
  if (isAvailable(input.global)) {
    dominance = input.global.value.btcDominance;
    let trendNote = "ميل الهيمنة غير معروف";
    let dominanceSlope = NaN;
    if (isAvailable(input.dominanceHistory) && input.dominanceHistory.value.length >= 10) {
      const series = input.dominanceHistory.value.map((d) => d.value);
      dominanceSlope = slopePct(series, Math.min(14, series.length))[series.length - 1];
      trendNote = Number.isFinite(dominanceSlope)
        ? dominanceSlope > 0
          ? "الهيمنة ترتفع — السيولة تنسحب من العملات البديلة نحو البيتكوين"
          : "الهيمنة تنخفض — السيولة تتجه نحو العملات البديلة"
        : trendNote;
    }
    factors.push({
      id: "btc_dominance", label: "هيمنة البيتكوين", value: dominance,
      display: `${fmt(dominance, 2)}%`,
      // Rising dominance is a headwind for an altcoin long.
      contribution: Number.isFinite(dominanceSlope) ? Math.max(-10, Math.min(10, -dominanceSlope * 20)) : 0,
      note: trendNote,
    });
  } else {
    warnings.push("هيمنة البيتكوين غير متاحة");
  }

  // ── market volatility versus its own normal ──────────────────────────────
  const btcAtrRank = atrPercentile(input.btcDaily, 14, 252);
  const volRank = btcAtrRank[btcAtrRank.length - 1];
  if (Number.isFinite(volRank)) {
    factors.push({
      id: "market_volatility", label: "تقلّب السوق مقارنة بمتوسطه", value: volRank,
      display: `المئوي ${fmt(volRank * 100, 0)}`,
      contribution: 0,
      note: volRank > 0.85
        ? "تقلّب السوق في أعلى 15% من تاريخه — بيئة خطرة، والمراكز تُصغَّر"
        : volRank < 0.15
          ? "تقلّب السوق منخفض تاريخياً — السوق هادئ"
          : "تقلّب السوق ضمن مداه الطبيعي",
    });
    if (volRank > 0.85) warnings.push("تقلّب السوق مرتفع تاريخياً");
  }

  // ── fear and greed, read contrarian ──────────────────────────────────────
  if (isAvailable(input.fearGreed)) {
    const fg = input.fearGreed.value;
    // Extreme fear favours longs; extreme greed favours caution on longs.
    const contribution = fg.value <= 25 ? 12 : fg.value >= 75 ? -12 : 0;
    factors.push({
      id: "fear_greed", label: "مؤشر الخوف والطمع", value: fg.value,
      display: `${fg.value} (${fg.classification})`,
      contribution,
      note: fg.value <= 25
        ? "خوف شديد — يُقرأ معاكساً، فيرفع وزن إشارات الشراء"
        : fg.value >= 75
          ? "طمع شديد — يُقرأ معاكساً، فيخفض وزن إشارات الشراء"
          : "لا تطرّف في المشاعر",
    });
  } else {
    warnings.push("مؤشر الخوف والطمع غير متاح");
  }

  // ── correlation to Bitcoin ───────────────────────────────────────────────
  const correlation = returnCorrelation(input.assetDaily, input.btcDaily, 30);
  const independent = correlation === null || Math.abs(correlation) < input.correlationCeiling;

  if (correlation !== null) {
    factors.push({
      id: "btc_correlation", label: "ارتباط العملة بالبيتكوين (30 يوماً)", value: correlation,
      display: fmt(correlation, 3),
      contribution: 0,
      note: independent
        ? "الارتباط دون السقف — التحليل الفني للعملة مستقلّ بدرجة مقبولة"
        : `الارتباط ${fmt(correlation, 3)} يتجاوز ${input.correlationCeiling} — التحليل الفني لهذه العملة ليس مستقلاً، وهو في الحقيقة قراءة للبيتكوين برافعة. تُخفض الثقة.`,
    });
    if (!independent) warnings.push("التحليل الفني غير مستقلّ — الارتباط بالبيتكوين فوق السقف");
  } else {
    warnings.push("تعذّر حساب الارتباط بالبيتكوين — تاريخ غير كافٍ");
  }

  // ── the permission ───────────────────────────────────────────────────────
  // Typed as the full union because it is what downstream stages consume and
  // narrow further. This stage itself only ever grants "both" or "short":
  // a bullish Bitcoin does not forbid shorting a weak altcoin, so there is no
  // "long only" case here, and insufficient data is reported as `unavailable`
  // rather than as a blanket ban.
  let allowedDirection: AllowedDirection;
  let gateNote: string;

  if (daily.score <= BTC_BREAKDOWN_THRESHOLD) {
    // The hard rule: BTC breaking down bans every altcoin long outright.
    const isBtc = input.symbol.toUpperCase().startsWith("BTC");
    allowedDirection = "short";
    gateNote = isBtc
      ? "البيتكوين نفسه ينهار على اليومي — الشراء ممنوع."
      : "البيتكوين ينهار على اليومي — كل توصيات الشراء على العملات البديلة ممنوعة مهما كانت قوية فنياً. في الانهيارات الحقيقية ترتفع الارتباطات إلى واحد وتهبط كل العملات معاً.";
  } else if (daily.bias === "bullish" && fourHour.bias !== "bearish") {
    allowedDirection = "both";
    gateNote = "البيتكوين صاعد ولا تعارض على الأربع ساعات — الاتجاهان مسموحان.";
  } else if (daily.bias === "bearish") {
    allowedDirection = "short";
    gateNote = "البيتكوين هابط على اليومي — البيع فقط.";
  } else if (daily.bias === "bullish" && fourHour.bias === "bearish") {
    allowedDirection = "both";
    gateNote = "البيتكوين صاعد على اليومي لكنه هابط على الأربع ساعات — تعارض قصير المدى، والاتجاهان مسموحان بحذر.";
    warnings.push("تعارض بين اليومي والأربع ساعات على البيتكوين");
  } else {
    allowedDirection = "both";
    gateNote = "البيتكوين محايد — لا قيد اتجاهي من السياق الكلي.";
  }

  const score = Math.max(-100, Math.min(100, factors.reduce((s, f) => s + f.contribution, 0)));
  const bias: Bias = score > 15 ? "bullish" : score < -15 ? "bearish" : "neutral";

  const arabic = [
    `السياق الكلي: البيتكوين ${daily.bias === "bullish" ? "صاعد" : daily.bias === "bearish" ? "هابط" : "محايد"} على اليومي (${daily.note})`,
    `وعلى الأربع ساعات ${fourHour.bias === "bullish" ? "صاعد" : fourHour.bias === "bearish" ? "هابط" : "محايد"}.`,
    dominance !== null ? `هيمنة البيتكوين ${fmt(dominance, 2)}%.` : "",
    correlation !== null
      ? `ارتباط ${input.symbol} بالبيتكوين خلال 30 يوماً ${fmt(correlation, 3)}${independent ? "" : " — فوق السقف، والتحليل ليس مستقلاً"}.`
      : "",
    gateNote,
    `الاتجاه المسموح في هذه الدورة: ${directionLabelAr(allowedDirection)}.`,
  ].filter(Boolean).join(" ");

  return base({
    ...stagePass("macro", {
      score, bias, factors,
      // A non-independent asset costs confidence even though the stage passes.
      confidencePenalty: independent ? 0 : 0.15,
      warnings, arabic,
      dataAgeMs: isAvailable(input.global) ? input.now - input.global.asOf : null,
      durationMs: Date.now() - started,
    }),
    allowedDirection,
    btcCorrelation: correlation,
    independentAnalysis: independent,
  });
}
