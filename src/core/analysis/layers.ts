/**
 * The four technical layers, computed per timeframe.
 *
 * Every score is a WEIGHTED SUM OF NAMED FACTORS, and every factor records the
 * signed amount it contributed. Summing a layer's factor contributions
 * reproduces its score exactly. That is a hard invariant (there is a test for
 * it) and it is what lets the site show "how the bot decided" as an audit
 * rather than a story told after the fact.
 *
 * Weights live here as named constants so Stage 8 can re-weight them by market
 * regime without hunting for magic numbers scattered through the code.
 */
import {
  adx, atr, atrPercent, atrPercentile, bollinger, bollingerSqueeze, cloudPosition,
  ema, findDivergences, ichimoku, latestDivergence, macd, obv, relativeVolume,
  rsi, sma, slopePct, stochastic, takerDelta, vwap,
} from "@/core/indicators";
import type { Bias, Factor, LayerAnalysis } from "@/core/analysis/types";
import type { Candle } from "@/core/types";
import type { Timeframe } from "@/shared/time";

/** ADX below this means "no trend" — trend readings get damped hard. */
const ADX_RANGING = 20;
/** ADX above this is a strong trend: reversal signals must be discounted. */
const ADX_STRONG = 25;

const TREND_WEIGHTS = {
  maStack: 30,
  pricePosition: 20,
  longSlope: 20,
  adxDirection: 20,
  ichimoku: 10,
} as const;

const MOMENTUM_WEIGHTS = {
  rsiLevel: 30,
  divergence: 25,
  macd: 30,
  stochastic: 15,
} as const;

const VOLUME_WEIGHTS = {
  relative: 25,
  obvAgreement: 40,
  vwap: 20,
  takerDelta: 15,
} as const;

const clamp = (n: number, lo = -100, hi = 100): number => Math.max(lo, Math.min(hi, n));

function biasOf(score: number, deadzone = 15): Bias {
  if (score > deadzone) return "bullish";
  if (score < -deadzone) return "bearish";
  return "neutral";
}

const fmt = (n: number, d = 2): string =>
  Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";

/** Build a factor and keep its contribution consistent with its weight. */
function factor(
  id: string,
  label: string,
  value: number | null,
  display: string,
  /** −1..1 */ normalized: number,
  weight: number,
  note: string,
): Factor {
  return {
    id,
    label,
    value,
    display,
    contribution: clamp(normalized, -1, 1) * weight,
    note,
  };
}

/** A factor whose input was unreadable: zero contribution, stated plainly. */
function missingFactor(id: string, label: string, why: string): Factor {
  return { id, label, value: null, display: "غير متاح", contribution: 0, note: why };
}

const sumContributions = (factors: readonly Factor[]): number =>
  clamp(factors.reduce((s, f) => s + f.contribution, 0));

// ── TREND ────────────────────────────────────────────────────────────────────

export function analyzeTrend(candles: readonly Candle[]): LayerAnalysis {
  const close = candles.map((c) => c.close);
  const i = candles.length - 1;
  const price = close[i];
  const factors: Factor[] = [];
  const unavailable: string[] = [];

  const ma9 = ema(close, 9);
  const ma21 = ema(close, 21);
  const ma50 = sma(close, 50);
  const ma200 = sma(close, 200);

  // 1. Stack order. Three adjacent pairs; each correctly ordered pair is a
  //    third of the vote, so a partial stack reads as partial.
  const stack = [ma9[i], ma21[i], ma50[i], ma200[i]];
  if (stack.every(Number.isFinite)) {
    let bull = 0;
    let bear = 0;
    for (let k = 0; k < 3; k++) {
      if (stack[k] > stack[k + 1]) bull++;
      else if (stack[k] < stack[k + 1]) bear++;
    }
    const normalized = (bull - bear) / 3;
    factors.push(
      factor(
        "ma_stack", "ترتيب المتوسطات 9/21/50/200", normalized,
        `${bull} من 3 مرتّبة صعودياً`, normalized, TREND_WEIGHTS.maStack,
        bull === 3
          ? "المتوسطات مرتّبة ترتيباً صاعداً كاملاً — اتجاه صاعد ناضج"
          : bear === 3
            ? "المتوسطات مرتّبة ترتيباً هابطاً كاملاً — اتجاه هابط ناضج"
            : "المتوسطات متشابكة — الاتجاه غير محسوم على هذا الإطار",
      ),
    );
  } else {
    const have = stack.filter(Number.isFinite).length;
    factors.push(missingFactor("ma_stack", "ترتيب المتوسطات", `التاريخ يكفي ${have} من 4 متوسطات فقط`));
    unavailable.push("ترتيب المتوسطات — تاريخ غير كافٍ");
  }

  // 2. Where price sits relative to the averages it is supposed to respect.
  //    Above and below are counted SEPARATELY, and sitting exactly ON an
  //    average counts as neither. Folding "equal" into "below" would tilt the
  //    reading bearish precisely at a pullback to the 50 or the 200 — the
  //    decision points that matter most.
  const finiteMas = stack.filter(Number.isFinite);
  if (finiteMas.length > 0) {
    const above = finiteMas.filter((m) => price > m).length;
    const below = finiteMas.filter((m) => price < m).length;
    const normalized = (above - below) / finiteMas.length;
    const at = finiteMas.length - above - below;
    factors.push(
      factor(
        "price_position", "موقع السعر من المتوسطات", above,
        at > 0 ? `فوق ${above} · تحت ${below} · عند ${at}` : `فوق ${above} من ${finiteMas.length}`,
        normalized, TREND_WEIGHTS.pricePosition,
        above === finiteMas.length
          ? "السعر فوق كل المتوسطات"
          : below === finiteMas.length
            ? "السعر تحت كل المتوسطات"
            : at === finiteMas.length
              ? "السعر منطبق على المتوسطات — لا إشارة اتجاهية"
              : "السعر بين المتوسطات — منطقة تنازع",
      ),
    );
  }

  // 3. Slope of the long average. Direction of the tide, not the wave.
  const slope200 = slopePct(ma200, 20);
  if (Number.isFinite(slope200[i])) {
    // 0.05%/bar on the 200 is already a decidedly sloped average.
    const normalized = clamp(slope200[i] / 0.05, -1, 1);
    factors.push(
      factor(
        "ma200_slope", "ميل المتوسط 200", slope200[i],
        `${fmt(slope200[i], 4)}% لكل شمعة`, normalized, TREND_WEIGHTS.longSlope,
        Math.abs(slope200[i]) < 0.005
          ? "المتوسط 200 أفقي — السوق بلا اتجاه طويل"
          : slope200[i] > 0 ? "المتوسط 200 يميل صعوداً" : "المتوسط 200 يميل هبوطاً",
      ),
    );
  } else {
    factors.push(missingFactor("ma200_slope", "ميل المتوسط 200", "يحتاج 220 شمعة على الأقل"));
    unavailable.push("ميل المتوسط 200 — تاريخ غير كافٍ");
  }

  // 4. ADX with direction. Crucially, a weak ADX DAMPS the reading rather than
  //    flipping it: no trend is not the same as a trend the other way.
  const dmi = adx(candles, 14);
  const adxValue = dmi.adx[i];
  if (Number.isFinite(adxValue) && Number.isFinite(dmi.plusDi[i]) && Number.isFinite(dmi.minusDi[i])) {
    const diSum = dmi.plusDi[i] + dmi.minusDi[i];
    const direction = diSum === 0 ? 0 : (dmi.plusDi[i] - dmi.minusDi[i]) / diSum;
    const strength = clamp(adxValue / 40, 0, 1);
    const normalized = direction * strength;
    factors.push(
      factor(
        "adx", "قوة الاتجاه ADX", adxValue,
        `ADX ${fmt(adxValue, 1)} · +DI ${fmt(dmi.plusDi[i], 1)} / −DI ${fmt(dmi.minusDi[i], 1)}`,
        normalized, TREND_WEIGHTS.adxDirection,
        adxValue < ADX_RANGING
          ? `ADX ${fmt(adxValue, 1)} دون ${ADX_RANGING}: السوق عرضي، ومؤشرات الاختراق لا وزن لها هنا`
          : adxValue > ADX_STRONG
            ? `ADX ${fmt(adxValue, 1)}: اتجاه قوي، ومؤشرات الانعكاس لا وزن لها هنا`
            : `ADX ${fmt(adxValue, 1)}: اتجاه ناشئ غير مكتمل`,
      ),
    );
  } else {
    factors.push(missingFactor("adx", "قوة الاتجاه ADX", "تاريخ غير كافٍ"));
    unavailable.push("ADX — تاريخ غير كافٍ");
  }

  // 5. Ichimoku, compared against the cloud actually drawn under this bar.
  const cloud = ichimoku(candles);
  const pos = cloudPosition(price, cloud.cloudTop[i], cloud.cloudBottom[i]);
  if (pos !== "unknown") {
    const normalized = pos === "above" ? 1 : pos === "below" ? -1 : 0;
    factors.push(
      factor(
        "ichimoku", "سحابة إيتشيموكو", normalized,
        pos === "above" ? "السعر فوق السحابة" : pos === "below" ? "السعر تحت السحابة" : "السعر داخل السحابة",
        normalized, TREND_WEIGHTS.ichimoku,
        pos === "inside"
          ? "السعر داخل السحابة — منطقة توازن، لا إشارة اتجاهية"
          : pos === "above" ? "السحابة تعمل دعماً تحت السعر" : "السحابة تعمل مقاومة فوق السعر",
      ),
    );
  } else {
    factors.push(missingFactor("ichimoku", "سحابة إيتشيموكو", "يحتاج 78 شمعة على الأقل"));
    unavailable.push("إيتشيموكو — تاريخ غير كافٍ");
  }

  const score = sumContributions(factors);
  const bias = biasOf(score);

  return {
    id: "trend",
    label: "الاتجاه",
    score,
    bias,
    factors,
    unavailable,
    arabic: narrateTrend(score, bias, adxValue, factors),
  };
}

function narrateTrend(score: number, bias: Bias, adxValue: number, factors: readonly Factor[]): string {
  const parts: string[] = [];
  const strength = Math.abs(score);
  parts.push(
    bias === "neutral"
      ? `لا اتجاه واضح على هذا الإطار (النتيجة ${fmt(score, 0)}).`
      : `الاتجاه ${bias === "bullish" ? "صاعد" : "هابط"} بنتيجة ${fmt(score, 0)} من 100.`,
  );
  if (Number.isFinite(adxValue) && adxValue < ADX_RANGING) {
    parts.push(`لكن ADX عند ${fmt(adxValue, 1)} يقول إن السوق عرضي، فلا يُعتمد على قوة هذا الاتجاه.`);
  } else if (strength > 60) {
    parts.push("الاتفاق بين عناصر الاتجاه قوي.");
  }
  const stack = factors.find((f) => f.id === "ma_stack");
  if (stack && stack.value !== null && Math.abs(stack.value) < 0.5) {
    parts.push("تشابك المتوسطات يعني أن أي دخول هنا يفتقر لإسناد اتجاهي.");
  }
  return parts.join(" ");
}

// ── MOMENTUM ─────────────────────────────────────────────────────────────────

export function analyzeMomentum(candles: readonly Candle[], timeframe: Timeframe): LayerAnalysis {
  const close = candles.map((c) => c.close);
  const i = candles.length - 1;
  const factors: Factor[] = [];
  const unavailable: string[] = [];

  // 1. RSI as a DIRECTIONAL reading around 50. Extremes are flagged as
  //    warnings rather than auto-reversals: RSI 80 in a strong uptrend is
  //    strength, and only Stage 8's regime call can decide which it is here.
  const rsiSeries = rsi(close, 14);
  const rsiValue = rsiSeries[i];
  if (Number.isFinite(rsiValue)) {
    const normalized = clamp((rsiValue - 50) / 25, -1, 1);
    factors.push(
      factor(
        "rsi", "مؤشر القوة النسبية", rsiValue, fmt(rsiValue, 1), normalized, MOMENTUM_WEIGHTS.rsiLevel,
        rsiValue >= 70
          ? `${fmt(rsiValue, 1)} في منطقة تشبّع شرائي — قوة زخم، وخطر ارتداد إن كان السوق عرضياً`
          : rsiValue <= 30
            ? `${fmt(rsiValue, 1)} في منطقة تشبّع بيعي — ضعف زخم، وفرصة ارتداد إن كان السوق عرضياً`
            : `${fmt(rsiValue, 1)} في المنطقة المحايدة`,
      ),
    );
  } else {
    factors.push(missingFactor("rsi", "مؤشر القوة النسبية", "يحتاج 15 شمعة على الأقل"));
    unavailable.push("RSI — تاريخ غير كافٍ");
  }

  // 2. Divergence — computed on confirmed pivots only, so it never appears and
  //    then vanishes on the next bar.
  const divergences = findDivergences(candles, rsiSeries, { lookback: 120 });
  const latest = latestDivergence(divergences);
  if (latest) {
    const bullish = latest.kind === "regular_bullish" || latest.kind === "hidden_bullish";
    // Decay with age: a divergence 40 bars old is history, not a signal.
    const age = i - latest.toIndex;
    const freshness = clamp(1 - age / 40, 0, 1);
    const normalized = (bullish ? 1 : -1) * latest.strength * freshness;
    factors.push(
      factor(
        "divergence", "انحراف السعر عن المؤشّر", latest.strength,
        `${latest.kind.includes("hidden") ? "خفي" : "عادي"} ${bullish ? "صعودي" : "هبوطي"} · قبل ${age} شمعة`,
        normalized, MOMENTUM_WEIGHTS.divergence,
        `${latest.arabic}. ${age > 20 ? "لكنه قديم نسبياً وقلّ وزنه." : "وهو حديث."}`,
      ),
    );
  } else {
    factors.push(
      factor("divergence", "انحراف السعر عن المؤشّر", 0, "لا يوجد", 0, MOMENTUM_WEIGHTS.divergence,
        "لا انحراف مؤكّد بين السعر والمؤشّر في آخر 120 شمعة"),
    );
  }

  // 3. MACD: position plus acceleration. A shrinking positive histogram is a
  //    different message from a negative one, so both are read.
  const m = macd(close, 12, 26, 9);
  if (Number.isFinite(m.histogram[i]) && Number.isFinite(m.macd[i])) {
    const hist = m.histogram[i];
    const prevHist = m.histogram[i - 1];
    const accelerating = Number.isFinite(prevHist) ? Math.abs(hist) > Math.abs(prevHist) : false;
    // Normalize the histogram by price so it is comparable across assets.
    const scaled = clamp((hist / close[i]) * 4000, -1, 1);
    const aboveZero = m.macd[i] > 0;
    const normalized = clamp(scaled * 0.7 + (aboveZero ? 0.3 : -0.3), -1, 1);
    factors.push(
      factor(
        "macd", "ماكد", hist,
        `الهيستوجرام ${fmt(hist, 4)} · الخط ${aboveZero ? "فوق" : "تحت"} الصفر`,
        normalized, MOMENTUM_WEIGHTS.macd,
        `${hist > 0 ? "الزخم لصالح المشترين" : "الزخم لصالح البائعين"} و${accelerating ? "يتسارع" : "يتباطأ"}.` +
          (!accelerating && Math.abs(hist) > 0 ? " تباطؤ الزخم مع بقاء الاتجاه يسبق التصحيح عادةً." : ""),
      ),
    );
  } else {
    factors.push(missingFactor("macd", "ماكد", "يحتاج 35 شمعة على الأقل"));
    unavailable.push("MACD — تاريخ غير كافٍ");
  }

  // 4. Stochastic only earns a vote on the fast timeframes it is built for.
  const isFast = timeframe === "5m" || timeframe === "15m" || timeframe === "1h";
  if (isFast) {
    const st = stochastic(candles.map((c) => c.high), candles.map((c) => c.low), close, 14, 3, 3);
    if (Number.isFinite(st.k[i]) && Number.isFinite(st.d[i])) {
      const normalized = clamp((st.k[i] - 50) / 35, -1, 1);
      factors.push(
        factor(
          "stochastic", "ستوكاستك", st.k[i],
          `%K ${fmt(st.k[i], 1)} / %D ${fmt(st.d[i], 1)}`, normalized, MOMENTUM_WEIGHTS.stochastic,
          st.k[i] > 80 ? "تشبّع شرائي قصير المدى" : st.k[i] < 20 ? "تشبّع بيعي قصير المدى" : "لا تطرّف قصير المدى",
        ),
      );
    } else {
      factors.push(missingFactor("stochastic", "ستوكاستك", "تاريخ غير كافٍ"));
    }
  } else {
    factors.push(
      factor("stochastic", "ستوكاستك", null, "غير مُحتسب", 0, MOMENTUM_WEIGHTS.stochastic,
        "ستوكاستك مؤشّر توقيت قصير المدى، ولا يُحتسب على الأطر الطويلة"),
    );
  }

  const score = sumContributions(factors);
  const bias = biasOf(score);

  return {
    id: "momentum",
    label: "الزخم",
    score,
    bias,
    factors,
    unavailable,
    arabic: narrateMomentum(score, bias, rsiValue, latest !== null, factors),
  };
}

function narrateMomentum(
  score: number, bias: Bias, rsiValue: number, hasDivergence: boolean, factors: readonly Factor[],
): string {
  const parts: string[] = [
    bias === "neutral"
      ? `الزخم محايد (النتيجة ${fmt(score, 0)}).`
      : `الزخم ${bias === "bullish" ? "صعودي" : "هبوطي"} بنتيجة ${fmt(score, 0)}.`,
  ];
  if (Number.isFinite(rsiValue)) {
    if (rsiValue >= 70) parts.push(`RSI عند ${fmt(rsiValue, 1)} — التشبّع الشرائي في اتجاه قوي علامة قوة لا انعكاس، وفي سوق عرضي علامة انعكاس.`);
    else if (rsiValue <= 30) parts.push(`RSI عند ${fmt(rsiValue, 1)} — التشبّع البيعي في اتجاه هابط قوي ليس سبباً للشراء.`);
  }
  if (hasDivergence) {
    const d = factors.find((f) => f.id === "divergence");
    if (d) parts.push(d.note);
  }
  return parts.join(" ");
}

// ── VOLATILITY ───────────────────────────────────────────────────────────────

/**
 * Volatility is NOT directional. This layer answers one question: is this a
 * volatility environment worth trading? Squeezed and about to expand scores
 * high; already blown out and extended scores low, because entering after the
 * move has expanded is how a stop gets placed inside the noise.
 *
 * Score is 0..100 and never signed. Anything that reads a direction out of a
 * squeeze is guessing.
 */
export function analyzeVolatility(candles: readonly Candle[]): LayerAnalysis {
  const close = candles.map((c) => c.close);
  const i = candles.length - 1;
  const factors: Factor[] = [];
  const unavailable: string[] = [];
  let score = 50; // neutral baseline

  const atrPct = atrPercent(candles, 14);
  const atrRank = atrPercentile(candles, 14, 252);
  if (Number.isFinite(atrRank[i])) {
    const rank = atrRank[i];
    // A coiled market (low percentile) is the best setup; an already-exploded
    // one (very high) is the worst.
    const contribution = rank < 0.25 ? 25 : rank < 0.6 ? 10 : rank < 0.85 ? -5 : -25;
    score += contribution;
    factors.push({
      id: "atr_percentile",
      label: "التقلّب مقارنة بتاريخه",
      value: rank,
      display: `المئوي ${fmt(rank * 100, 0)} · ATR ${fmt(atrPct[i], 2)}%`,
      contribution,
      note:
        rank < 0.25
          ? "التقلّب في أدنى ربع من تاريخه — السوق منضغط، وحركة قادمة أرجح"
          : rank > 0.85
            ? "التقلّب في أعلى 15% من تاريخه — الحركة حدثت بالفعل، والدخول الآن يضع الوقف داخل الضجيج"
            : "التقلّب ضمن مداه الطبيعي",
    });
  } else {
    factors.push(missingFactor("atr_percentile", "التقلّب مقارنة بتاريخه", "يحتاج 45 شمعة على الأقل"));
    unavailable.push("مئوي ATR — تاريخ غير كافٍ");
  }

  const squeeze = bollingerSqueeze(close, 20, 2, 120, 0.2);
  if (Number.isFinite(squeeze.bandwidthPercentile[i])) {
    const inSqueeze = squeeze.squeezed[i];
    const bars = squeeze.barsInSqueeze[i];
    // A longer coil implies a larger release, with diminishing returns.
    const contribution = inSqueeze ? Math.min(25, 10 + bars) : 0;
    score += contribution;
    factors.push({
      id: "bb_squeeze",
      label: "انضغاط قنوات بولنجر",
      value: squeeze.bandwidthPercentile[i],
      display: inSqueeze ? `منضغط منذ ${bars} شمعة` : `غير منضغط (المئوي ${fmt(squeeze.bandwidthPercentile[i] * 100, 0)})`,
      contribution,
      note: inSqueeze
        ? `القنوات منضغطة منذ ${bars} شمعة — انفجار حركة قادم. الانضغاط لا يحدّد الاتجاه، فقط أن حركة ستقع.`
        : "لا انضغاط حالياً",
    });
  }

  const bb = bollinger(close, 20, 2);
  if (Number.isFinite(bb.percentB[i])) {
    const pb = bb.percentB[i];
    const outside = pb > 1 || pb < 0;
    const contribution = outside ? -10 : 0;
    score += contribution;
    factors.push({
      id: "bb_position",
      label: "موقع السعر داخل القنوات",
      value: pb,
      display: `%B ${fmt(pb, 2)}`,
      contribution,
      note: outside
        ? "السعر خارج القناة — امتداد حادّ، والمطاردة هنا مكلفة"
        : pb > 0.8 ? "السعر قرب القناة العليا" : pb < 0.2 ? "السعر قرب القناة السفلى" : "السعر في وسط القناة",
    });
  }

  score = Math.max(0, Math.min(100, score));

  return {
    id: "volatility",
    label: "التقلّب",
    score,
    bias: "neutral", // never directional, by design
    factors,
    unavailable,
    arabic: narrateVolatility(score, factors),
  };
}

function narrateVolatility(score: number, factors: readonly Factor[]): string {
  const squeeze = factors.find((f) => f.id === "bb_squeeze");
  const rank = factors.find((f) => f.id === "atr_percentile");
  const parts: string[] = [
    score >= 70
      ? `بيئة تقلّب مواتية للدخول (${fmt(score, 0)}/100).`
      : score <= 35
        ? `بيئة تقلّب غير مواتية (${fmt(score, 0)}/100).`
        : `بيئة تقلّب عادية (${fmt(score, 0)}/100).`,
  ];
  if (rank) parts.push(rank.note + ".");
  if (squeeze && squeeze.contribution > 0) parts.push(squeeze.note);
  return parts.join(" ");
}

// ── VOLUME ───────────────────────────────────────────────────────────────────

export function analyzeVolume(
  candles: readonly Candle[],
  timeframe: Timeframe,
  hasTakerBreakdown: boolean,
): LayerAnalysis {
  const close = candles.map((c) => c.close);
  const i = candles.length - 1;
  const factors: Factor[] = [];
  const unavailable: string[] = [];

  // 1. Relative volume — confirmation of whatever the price did.
  const relVol = relativeVolume(candles, 20);
  if (Number.isFinite(relVol[i])) {
    const moveUp = close[i] > close[i - 1];
    const excess = clamp((relVol[i] - 1) / 1.5, -1, 1);
    const normalized = excess * (moveUp ? 1 : -1);
    factors.push(
      factor(
        "relative_volume", "الحجم مقارنة بمتوسطه", relVol[i],
        `${fmt(relVol[i], 2)}× المتوسط`, normalized, VOLUME_WEIGHTS.relative,
        relVol[i] > 1.5
          ? `حجم ${fmt(relVol[i], 2)} ضعف المتوسط يؤكّد الحركة`
          : relVol[i] < 0.6
            ? `حجم ${fmt(relVol[i], 2)} من المتوسط — حركة بلا مشاركة، وهي هشّة`
            : "حجم اعتيادي",
      ),
    );
  } else {
    factors.push(missingFactor("relative_volume", "الحجم مقارنة بمتوسطه", "تاريخ غير كافٍ"));
  }

  // 2. OBV slope against price slope — the divergence that matters most here.
  const obvSeries = obv(candles);
  const obvSlope = slopePct(obvSeries, 20);
  const priceSlope = slopePct(close, 20);
  if (Number.isFinite(obvSlope[i]) && Number.isFinite(priceSlope[i])) {
    const priceUp = priceSlope[i] > 0;
    const obvUp = obvSlope[i] > 0;
    const agree = priceUp === obvUp;
    const magnitude = clamp(Math.abs(priceSlope[i]) / 0.5, 0, 1);
    // Agreement confirms the price direction; disagreement argues against it.
    const normalized = agree ? (priceUp ? magnitude : -magnitude) : (priceUp ? -magnitude : magnitude);
    factors.push(
      factor(
        "obv", "توازن الحجم OBV", obvSlope[i],
        agree ? "يؤكّد السعر" : "يخالف السعر",
        normalized, VOLUME_WEIGHTS.obvAgreement,
        agree
          ? "اتجاه OBV يوافق اتجاه السعر — الحركة مدعومة بحجم حقيقي"
          : "اتجاه OBV يخالف اتجاه السعر — الحركة غير مدعومة، وهذا انحراف يسبق الانعكاس غالباً",
      ),
    );
  } else {
    factors.push(missingFactor("obv", "توازن الحجم OBV", "تاريخ غير كافٍ"));
    unavailable.push("OBV — تاريخ غير كافٍ");
  }

  // 3. Price versus VWAP — where the average participant sits.
  const vwapSeries = vwap(candles, timeframe);
  if (Number.isFinite(vwapSeries[i]) && vwapSeries[i] > 0) {
    const distPct = ((close[i] - vwapSeries[i]) / vwapSeries[i]) * 100;
    const normalized = clamp(distPct / 1.5, -1, 1);
    factors.push(
      factor(
        "vwap", "السعر مقابل VWAP", distPct,
        `${distPct >= 0 ? "+" : ""}${fmt(distPct, 2)}%`, normalized, VOLUME_WEIGHTS.vwap,
        distPct > 0
          ? "السعر فوق متوسط السعر المرجّح بالحجم — المشترون في ربح"
          : "السعر تحت متوسط السعر المرجّح بالحجم — المشترون في خسارة",
      ),
    );
  }

  // 4. Taker delta — ONLY where the venue actually reports the aggressor split.
  //    On Bybit and OKX every bar would read as -volume, which looks like
  //    relentless selling and is in fact missing data.
  if (hasTakerBreakdown) {
    const delta = takerDelta(candles);
    const recent = delta.slice(-20).filter(Number.isFinite);
    const vol = candles.slice(-20).reduce((s, c) => s + c.volume, 0);
    if (recent.length > 0 && vol > 0) {
      const netRatio = recent.reduce((s, d) => s + d, 0) / vol;
      const normalized = clamp(netRatio * 3, -1, 1);
      factors.push(
        factor(
          "taker_delta", "دلتا المبادرين", netRatio,
          `${netRatio >= 0 ? "+" : ""}${fmt(netRatio * 100, 1)}% من الحجم`,
          normalized, VOLUME_WEIGHTS.takerDelta,
          netRatio > 0.05
            ? "المشترون هم المبادرون في آخر 20 شمعة — شراء حقيقي يرفع السعر"
            : netRatio < -0.05
              ? "البائعون هم المبادرون في آخر 20 شمعة — بيع حقيقي يضغط السعر"
              : "المبادرة متوازنة بين الطرفين",
        ),
      );
    }
  } else {
    factors.push(
      missingFactor("taker_delta", "دلتا المبادرين", "هذه المنصّة لا تُفصّل حجم المشتري المبادر في الشموع"),
    );
    unavailable.push("دلتا المبادرين — المنصّة لا توفّرها");
  }

  const score = sumContributions(factors);
  const bias = biasOf(score);

  return {
    id: "volume",
    label: "الحجم",
    score,
    bias,
    factors,
    unavailable,
    arabic: narrateVolume(score, bias, factors),
  };
}

function narrateVolume(score: number, bias: Bias, factors: readonly Factor[]): string {
  const parts: string[] = [
    bias === "neutral"
      ? `الحجم لا يرجّح اتجاهاً (النتيجة ${fmt(score, 0)}).`
      : `الحجم ${bias === "bullish" ? "يدعم الصعود" : "يدعم الهبوط"} بنتيجة ${fmt(score, 0)}.`,
  ];
  const obvFactor = factors.find((f) => f.id === "obv");
  if (obvFactor && obvFactor.display === "يخالف السعر") parts.push(obvFactor.note + ".");
  const rel = factors.find((f) => f.id === "relative_volume");
  if (rel && rel.value !== null && rel.value < 0.6) parts.push("ضعف المشاركة يجعل أي اختراق هنا مشكوكاً فيه.");
  return parts.join(" ");
}

export const __testing = { biasOf, sumContributions, ADX_RANGING, ADX_STRONG };
