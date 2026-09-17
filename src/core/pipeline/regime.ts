/**
 * Market regime and setup classification.
 *
 * Two decisions live here, and they are the most consequential in the system.
 *
 * REGIME decides which indicators are allowed to vote at all. The spec is
 * explicit and this file implements it literally: reversal indicators are
 * struck out ENTIRELY in a trending market, breakout indicators are struck out
 * ENTIRELY in a range. Not down-weighted — removed. Mean-reverting into a
 * strong trend and buying breakouts in chop are the two most reliable ways to
 * lose money, and neither is a matter of degree.
 *
 * SETUP decides whether there is a nameable reason to trade. If no setup
 * matches cleanly, there is no recommendation — a high score with no
 * recognisable pattern is not an opportunity, it is a number.
 */
import { adx } from "@/core/indicators/trend";
import { atrPercentile, bollingerSqueeze } from "@/core/indicators/volatility";
import { relativeVolume } from "@/core/indicators/volume";
import { findDivergences, latestDivergence } from "@/core/indicators/divergence";
import { rsi } from "@/core/indicators/momentum";
import { ema } from "@/core/indicators/moving-averages";
import {
  REGIME_ALLOWED_SETUPS, SETUP_AR, type MarketRegime, type SetupKind, type SetupMatch,
} from "@/core/pipeline/types";
import type { StructureAnalysis } from "@/core/analysis/structure-stage";
import type { TechnicalAnalysis } from "@/core/analysis/types";
import type { Candle } from "@/core/types";

const ADX_TRENDING = 25;
const ADX_RANGING = 20;
const VOL_EXTREME_PERCENTILE = 0.85;

export interface RegimeResult {
  readonly regime: MarketRegime;
  readonly confidence: number;
  readonly adx: number;
  readonly volatilityPercentile: number;
  readonly arabic: string;
}

/**
 * Classify the regime from the TRADING timeframe's own candles.
 *
 * High volatility is checked FIRST and overrides everything: a market whose
 * ATR is in the top 15% of its own year behaves differently from a trend or a
 * range regardless of what ADX says, and the setups that survive there are
 * very few.
 */
export function classifyRegime(
  candles: readonly Candle[],
  structure: StructureAnalysis,
): RegimeResult {
  const i = candles.length - 1;
  const dmi = adx(candles, 14);
  const adxValue = Number.isFinite(dmi.adx[i]) ? dmi.adx[i] : 0;
  const volRank = atrPercentile(candles, 14, 252)[i];
  const volPercentile = Number.isFinite(volRank) ? volRank : 0.5;

  if (volPercentile > VOL_EXTREME_PERCENTILE) {
    return {
      regime: "high_volatility",
      confidence: Math.min(100, Math.round((volPercentile - VOL_EXTREME_PERCENTILE) / 0.15 * 100)),
      adx: adxValue,
      volatilityPercentile: volPercentile,
      arabic:
        `النظام السوقي: تقلّب عالٍ — ATR في المئوي ${Math.round(volPercentile * 100)} من تاريخه. ` +
        "في هذه البيئة تتّسع الوقوف وتصغر المراكز، ومعظم أنماط الصفقات لا تصلح.",
    };
  }

  const trendingUp = adxValue >= ADX_TRENDING && dmi.plusDi[i] > dmi.minusDi[i];
  const trendingDown = adxValue >= ADX_TRENDING && dmi.minusDi[i] > dmi.plusDi[i];

  if (trendingUp || trendingDown) {
    // The structure must agree; ADX alone says "strong", not "which way".
    const agrees =
      (trendingUp && structure.structure.state !== "downtrend") ||
      (trendingDown && structure.structure.state !== "uptrend");
    const regime: MarketRegime = trendingUp ? "trending_up" : "trending_down";
    return {
      regime,
      confidence: Math.round(Math.min(100, (adxValue / 50) * 100) * (agrees ? 1 : 0.6)),
      adx: adxValue,
      volatilityPercentile: volPercentile,
      arabic:
        `النظام السوقي: ${trendingUp ? "اتجاه صاعد" : "اتجاه هابط"} — ADX ${adxValue.toFixed(1)}. ` +
        (agrees
          ? "والهيكل يوافق. مؤشرات الانعكاس مُلغاة تماماً في هذا النظام."
          : "لكن الهيكل لا يوافق تماماً، فخُفضت الثقة في التصنيف."),
    };
  }

  return {
    regime: "ranging",
    confidence: Math.round(Math.min(100, (1 - adxValue / ADX_RANGING) * 100)),
    adx: adxValue,
    volatilityPercentile: volPercentile,
    arabic:
      `النظام السوقي: عرضي — ADX ${adxValue.toFixed(1)} دون ${ADX_RANGING}. ` +
      "مؤشرات الاختراق مُلغاة تماماً في هذا النظام، لأن معظم الاختراقات في السوق العرضي كاذبة.",
  };
}

// ── setup classification ─────────────────────────────────────────────────────

export interface SetupInput {
  readonly candles: readonly Candle[];
  readonly regime: MarketRegime;
  readonly structure: StructureAnalysis;
  readonly technical: TechnicalAnalysis;
  readonly allowedDirection: "long" | "short" | "both";
}

interface Condition {
  label: string;
  met: boolean;
  detail: string;
}

/**
 * Try every setup the regime permits and return the best fit.
 *
 * Returns null when nothing matches cleanly — which is the correct and most
 * common outcome.
 */
export function classifySetup(input: SetupInput): SetupMatch | null {
  const allowed = REGIME_ALLOWED_SETUPS[input.regime];
  const candidates: SetupMatch[] = [];

  for (const kind of allowed) {
    for (const direction of ["long", "short"] as const) {
      if (input.allowedDirection !== "both" && input.allowedDirection !== direction) continue;
      const match = evaluate(kind, direction, input);
      if (match && match.fit >= 0.6) candidates.push(match);
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.fit - a.fit);
  return candidates[0];
}

function evaluate(kind: SetupKind, direction: "long" | "short", x: SetupInput): SetupMatch | null {
  const c = x.candles;
  const i = c.length - 1;
  const price = c[i].close;
  const long = direction === "long";
  const st = x.structure;
  const conditions: Condition[] = [];

  const add = (label: string, met: boolean, detail: string): boolean => {
    conditions.push({ label, met, detail });
    return met;
  };

  switch (kind) {
    case "trend_continuation": {
      // The trend must exist, price must have pulled back into a level or the
      // golden pocket, and momentum must be turning back the right way.
      const trendOk = add(
        "الاتجاه قائم",
        long ? x.regime === "trending_up" : x.regime === "trending_down",
        `النظام ${x.regime}`,
      );
      const structureOk = add(
        "الهيكل يوافق",
        long ? st.structure.state === "uptrend" : st.structure.state === "downtrend",
        st.structure.state,
      );
      const zone = long ? st.nearestSupport : st.nearestResistance;
      const nearLevel = zone ? Math.abs(price - zone.price) / st.atr < 1.2 : false;
      const pullbackOk = add(
        "ارتداد إلى مستوى حقيقي",
        nearLevel || (st.fibonacci?.inGoldenPocket ?? false),
        zone ? `أقرب ${long ? "دعم" : "مقاومة"} على بُعد ${(Math.abs(price - zone.price) / st.atr).toFixed(2)} ATR` : "لا مستوى قريب",
      );
      const momentum = x.technical.timeframes.find((t) => t.timeframe === x.technical.confluence.tradingTimeframe);
      const momentumOk = add(
        "الزخم يعود في اتجاه الاتجاه",
        momentum ? (long ? momentum.layers.momentum.score > -20 : momentum.layers.momentum.score < 20) : false,
        momentum ? `زخم ${momentum.layers.momentum.score.toFixed(0)}` : "غير متاح",
      );
      return build(kind, direction, conditions, [trendOk, structureOk, pullbackOk, momentumOk], [0.3, 0.25, 0.3, 0.15]);
    }

    case "breakout_retest": {
      const lastBreak = st.structure.lastBreak;
      const breakOk = add(
        "كسر هيكلي مؤكّد بإغلاق",
        lastBreak !== null && lastBreak.closedBeyond && (long ? lastBreak.direction === "up" : lastBreak.direction === "down"),
        lastBreak ? `${lastBreak.kind} ${lastBreak.direction}${lastBreak.closedBeyond ? " بإغلاق" : " بالظل فقط"}` : "لا كسر",
      );
      const age = lastBreak ? i - lastBreak.index : 999;
      const freshOk = add("الكسر حديث", age <= 20, `قبل ${age} شمعة`);
      // Price must have come BACK to the broken level — that is the retest.
      const retestOk = lastBreak
        ? add(
            "إعادة اختبار المستوى المكسور",
            Math.abs(price - lastBreak.level) / st.atr < 1.0,
            `المسافة ${(Math.abs(price - lastBreak.level) / st.atr).toFixed(2)} ATR من مستوى ${lastBreak.level.toFixed(4)}`,
          )
        : add("إعادة اختبار المستوى المكسور", false, "لا كسر لإعادة اختباره");
      // And it must still be holding on the correct side.
      const holdingOk = lastBreak
        ? add("المستوى ما زال صامداً", long ? price > lastBreak.level : price < lastBreak.level, `السعر ${long ? "فوق" : "تحت"} المستوى`)
        : add("المستوى ما زال صامداً", false, "لا كسر");
      return build(kind, direction, conditions, [breakOk, freshOk, retestOk, holdingOk], [0.3, 0.15, 0.3, 0.25]);
    }

    case "range_reversal": {
      const rangeOk = add("السوق عرضي", x.regime === "ranging", `النظام ${x.regime}`);
      const zone = long ? st.nearestSupport : st.nearestResistance;
      const atEdgeOk = add(
        "السعر عند حافة النطاق",
        zone ? Math.abs(price - zone.price) / st.atr < 0.8 : false,
        zone ? `${(Math.abs(price - zone.price) / st.atr).toFixed(2)} ATR من ${zone.price.toFixed(4)}` : "لا حافة",
      );
      const strongEdgeOk = add(
        "الحافة قوية",
        zone ? zone.strength >= 50 : false,
        zone ? `قوّة ${zone.strength}` : "—",
      );
      // A candle pattern AT that level is what turns a level into a trigger.
      const significant = st.candlePatterns.filter((p) => p.weight > 0.2 && (long ? p.direction === "bullish" : p.direction === "bearish"));
      const rejectionOk = add(
        "شمعة رفض عند الحافة",
        significant.length > 0,
        significant.length > 0 ? significant[0].arabic.split("—")[0] : "لا نمط شموع عند مستوى",
      );
      return build(kind, direction, conditions, [rangeOk, atEdgeOk, strongEdgeOk, rejectionOk], [0.25, 0.3, 0.2, 0.25]);
    }

    case "momentum_ignition": {
      const closes = c.map((k) => k.close);
      const squeeze = bollingerSqueeze(closes, 20, 2, 120, 0.2);
      // The squeeze must have RELEASED recently, not still be squeezing.
      const wasSqueezed = squeeze.squeezed.slice(Math.max(0, i - 8), i).some(Boolean);
      const releasedOk = add("انضغاط تحرّر حديثاً", wasSqueezed && !squeeze.squeezed[i], wasSqueezed ? "انضغاط خلال 8 شمعات ثم تحرّر" : "لا انضغاط سابق");
      const relVol = relativeVolume(c, 20)[i];
      const volumeOk = add("حجم يؤكّد الانفجار", Number.isFinite(relVol) && relVol > 1.5, `${Number.isFinite(relVol) ? relVol.toFixed(2) : "—"}× المتوسط`);
      const moved = (c[i].close - c[i - 1].close) / st.atr;
      const directionOk = add("الحركة في الاتجاه المطلوب", long ? moved > 0.5 : moved < -0.5, `${moved.toFixed(2)} ATR`);
      return build(kind, direction, conditions, [releasedOk, volumeOk, directionOk], [0.4, 0.3, 0.3]);
    }

    case "divergence_reversal": {
      const rsiSeries = rsi(c.map((k) => k.close), 14);
      const divs = findDivergences(c, rsiSeries, { lookback: 80 });
      const latest = latestDivergence(divs);
      const wantBullish = long;
      const divOk = add(
        "انحراف مؤكّد في الاتجاه الصحيح",
        latest !== null && (wantBullish ? latest.kind === "regular_bullish" : latest.kind === "regular_bearish"),
        latest ? latest.kind : "لا انحراف",
      );
      const freshOk = add("الانحراف حديث", latest !== null && i - latest.toIndex <= 15, latest ? `قبل ${i - latest.toIndex} شمعة` : "—");
      const zone = long ? st.nearestSupport : st.nearestResistance;
      const atLevelOk = add(
        "عند مستوى قوي",
        zone ? zone.strength >= 55 && Math.abs(price - zone.price) / st.atr < 1.0 : false,
        zone ? `قوّة ${zone.strength}، المسافة ${(Math.abs(price - zone.price) / st.atr).toFixed(2)} ATR` : "لا مستوى",
      );
      const exhaustedOk = add(
        "تشبّع في المؤشّر",
        Number.isFinite(rsiSeries[i]) && (wantBullish ? rsiSeries[i] < 40 : rsiSeries[i] > 60),
        `RSI ${Number.isFinite(rsiSeries[i]) ? rsiSeries[i].toFixed(1) : "—"}`,
      );
      return build(kind, direction, conditions, [divOk, freshOk, atLevelOk, exhaustedOk], [0.35, 0.15, 0.3, 0.2]);
    }

    case "liquidity_sweep": {
      // A wick that took out a level and CLOSED BACK INSIDE — the opposite of
      // a breakout, and the reason breaks are measured on closes.
      const lookback = c.slice(Math.max(0, i - 5), i + 1);
      const zone = long ? st.nearestSupport : st.nearestResistance;
      if (!zone) {
        add("مستوى للكنس", false, "لا مستوى قريب");
        return build(kind, direction, conditions, [false], [1]);
      }
      const swept = lookback.some((k) =>
        long ? k.low < zone.low && k.close > zone.low : k.high > zone.high && k.close < zone.high,
      );
      const sweepOk = add(
        "ظلّ اخترق المستوى وأُغلق داخله",
        swept,
        swept ? `كنس حول ${zone.price.toFixed(4)}` : "لا كنس",
      );
      const reclaimOk = add(
        "السعر استردّ المستوى",
        long ? price > zone.low : price < zone.high,
        `السعر ${price.toFixed(4)} مقابل المستوى ${zone.price.toFixed(4)}`,
      );
      const strengthOk = add("المستوى المكنوس قوي", zone.strength >= 45, `قوّة ${zone.strength}`);
      return build(kind, direction, conditions, [sweepOk, reclaimOk, strengthOk], [0.45, 0.35, 0.2]);
    }

    // ── order block ────────────────────────────────────────────────────────
    //
    // The last opposing candle before the impulsive move that broke
    // structure. The idea is that whoever caused the move left unfilled
    // orders there, and price returns to them.
    //
    // Two conditions do the real work and both are easy to omit: the move
    // away must have been IMPULSIVE (otherwise every candle in a drift is an
    // "order block"), and price must be RETURNING to it rather than sitting
    // in it having already broken through.
    case "order_block": {
      const block = findOrderBlock(c, long, st.atr, i);
      const foundOk = add(
        "كتلة أوامر محدّدة",
        block !== null,
        block ? `شمعة ${i - block.index} قبل الحالية · ${block.low.toFixed(4)}–${block.high.toFixed(4)}` : "لا كتلة",
      );
      if (!block) return build(kind, direction, conditions, [foundOk], [1]);

      const impulseOk = add(
        "الحركة بعدها اندفاعية",
        block.impulseAtr >= 2,
        `${block.impulseAtr.toFixed(2)} ATR خلال ${block.impulseBars} شمعات`,
      );
      const distance = long ? (price - block.high) / st.atr : (block.low - price) / st.atr;
      const returningOk = add(
        "السعر عائد إليها ولم يخترقها",
        distance > -0.2 && distance < 1.2,
        `المسافة ${distance.toFixed(2)} ATR`,
      );
      const structureOk = add(
        "الهيكل يوافق الاتجاه",
        long ? st.structure.state === "uptrend" : st.structure.state === "downtrend",
        st.structure.state,
      );
      return build(kind, direction, conditions, [foundOk, impulseOk, returningOk, structureOk], [0.2, 0.3, 0.3, 0.2]);
    }

    // ── fair value gap ─────────────────────────────────────────────────────
    //
    // A three-candle imbalance price skipped over. The trade is the return
    // into it. Gaps already filled are excluded — a filled gap is history,
    // not a level, and treating it as one is the commonest way this setup is
    // misapplied.
    case "fvg_fill": {
      const wanted = long ? "bullish" : "bearish";
      const open = st.gaps.filter((g) => !g.filled && g.direction === wanted && g.sizeAtr >= 0.3);
      const nearest = open
        .map((g) => ({ g, distance: long ? (price - g.top) / st.atr : (g.bottom - price) / st.atr }))
        .filter((x2) => x2.distance > -0.5 && x2.distance < 1.5)
        .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance))[0];

      const gapOk = add(
        "فجوة قيمة عادلة مفتوحة قريبة",
        nearest !== undefined,
        nearest ? `${nearest.g.bottom.toFixed(4)}–${nearest.g.top.toFixed(4)} · ${nearest.g.sizeAtr.toFixed(2)} ATR` : "لا فجوة",
      );
      const sizeOk = add(
        "الفجوة ذات حجم معتبر",
        nearest !== undefined && nearest.g.sizeAtr >= 0.5,
        nearest ? `${nearest.g.sizeAtr.toFixed(2)} ATR` : "—",
      );
      const unfilledOk = add(
        "لم تُملأ بعد",
        nearest !== undefined && nearest.g.filledFraction < 0.5,
        nearest ? `مملوءة ${Math.round(nearest.g.filledFraction * 100)}%` : "—",
      );
      const trendOk = add(
        "الاتجاه يوافق",
        long ? x.regime === "trending_up" : x.regime === "trending_down",
        x.regime,
      );
      return build(kind, direction, conditions, [gapOk, sizeOk, unfilledOk, trendOk], [0.35, 0.2, 0.25, 0.2]);
    }

    // ── moving-average pullback ────────────────────────────────────────────
    //
    // The most posted setup there is. Its weakness is also the best known:
    // in a range price crosses the average constantly, so this is allowed in
    // trending regimes only — enforced by REGIME_ALLOWED_SETUPS, not here.
    case "ema_pullback": {
      const closes = c.map((k) => k.close);
      const fast = ema(closes, 21);
      const slow = ema(closes, 50);
      const f = fast[i];
      const sl = slow[i];

      const stackedOk = add(
        "ترتيب المتوسطات يوافق الاتجاه",
        Number.isFinite(f) && Number.isFinite(sl) && (long ? f > sl : f < sl),
        `EMA21 ${f?.toFixed(4) ?? "—"} مقابل EMA50 ${sl?.toFixed(4) ?? "—"}`,
      );
      const touch = Number.isFinite(f) ? Math.abs(price - f) / st.atr : Infinity;
      const touchOk = add("السعر عند المتوسط السريع", touch < 0.6, `${touch.toFixed(2)} ATR من EMA21`);
      const sideOk = add(
        "لم يُغلق خلف المتوسط البطيء",
        Number.isFinite(sl) && (long ? price > sl : price < sl),
        long ? "فوق EMA50" : "تحت EMA50",
      );
      // The bounce has to have started; buying into a falling knife at the
      // average is the way this setup loses.
      const turned = (c[i].close - c[i].open) / st.atr;
      const turnOk = add("شمعة الارتداد بدأت", long ? turned > 0.1 : turned < -0.1, `${turned.toFixed(2)} ATR`);
      return build(kind, direction, conditions, [stackedOk, touchOk, sideOk, turnOk], [0.3, 0.3, 0.2, 0.2]);
    }

    // ── RSI reversal at a level ────────────────────────────────────────────
    //
    // Oversold alone is not a signal — in a downtrend RSI stays oversold for
    // weeks and buying it is how accounts die. It is only a setup at a real
    // level, and only once RSI has turned back OUT of the extreme.
    case "rsi_reversal": {
      const r = rsi(c.map((k) => k.close), 14);
      const now = r[i];
      const prev = r[i - 1];
      const extreme = long ? 30 : 70;

      const wasExtremeOk = add(
        "بلغ التشبّع خلال 5 شمعات",
        r.slice(Math.max(0, i - 5), i + 1).some((v) => (long ? v <= extreme : v >= extreme)),
        `RSI الحالي ${Number.isFinite(now) ? now.toFixed(1) : "—"}`,
      );
      const turnedOk = add(
        "خرج من التشبّع",
        Number.isFinite(now) && Number.isFinite(prev) && (long ? now > extreme && now > prev : now < extreme && now < prev),
        `${prev?.toFixed(1) ?? "—"} ← ${now?.toFixed(1) ?? "—"}`,
      );
      const zone = long ? st.nearestSupport : st.nearestResistance;
      const atLevelOk = add(
        "عند مستوى حقيقي",
        zone ? zone.strength >= 45 && Math.abs(price - zone.price) / st.atr < 1.0 : false,
        zone ? `قوّة ${zone.strength}` : "لا مستوى",
      );
      const notTrendingOk = add(
        "ليس داخل اتجاه معاكس قوي",
        long ? x.regime !== "trending_down" : x.regime !== "trending_up",
        x.regime,
      );
      return build(kind, direction, conditions, [wasExtremeOk, turnedOk, atLevelOk, notTrendingOk], [0.2, 0.3, 0.3, 0.2]);
    }
  }
}

/**
 * The last opposing candle before an impulsive, structure-breaking move.
 *
 * Scanned backwards from a recent impulse rather than forwards from a candle:
 * an "order block" is only one because of what happened AFTER it, so the move
 * has to be found first and the candle second.
 */
function findOrderBlock(
  candles: readonly Candle[],
  long: boolean,
  atrValue: number,
  i: number,
): { index: number; high: number; low: number; impulseAtr: number; impulseBars: number } | null {
  if (!(atrValue > 0) || i < 12) return null;

  // Look for an impulse inside the last 40 bars, newest first.
  for (let end = i - 1; end >= Math.max(3, i - 40); end--) {
    for (let bars = 2; bars <= 5 && end - bars >= 1; bars++) {
      const start = end - bars;
      const move = (candles[end].close - candles[start].open) / atrValue;
      const impulsive = long ? move >= 2 : move <= -2;
      if (!impulsive) continue;

      // The block is the last candle against the move before it began.
      for (let k = start; k >= Math.max(0, start - 5); k--) {
        const bearish = candles[k].close < candles[k].open;
        if (long ? bearish : !bearish) {
          return {
            index: k,
            high: candles[k].high,
            low: candles[k].low,
            impulseAtr: Math.abs(move),
            impulseBars: bars,
          };
        }
      }
    }
  }
  return null;
}

function build(
  kind: SetupKind,
  direction: "long" | "short",
  conditions: Condition[],
  met: boolean[],
  weights: number[],
): SetupMatch {
  const fit = met.reduce((s, ok, idx) => s + (ok ? weights[idx] : 0), 0);
  const unmet = conditions.filter((c) => !c.met);
  return {
    kind,
    direction,
    fit,
    conditions,
    arabic:
      `${SETUP_AR[kind]} (${direction === "long" ? "شراء" : "بيع"}) — مطابقة ${Math.round(fit * 100)}%. ` +
      (unmet.length === 0
        ? "كل الشروط متحقّقة."
        : `الشروط غير المتحقّقة: ${unmet.map((u) => `${u.label} (${u.detail})`).join("، ")}.`),
  };
}

// ── regime-dependent weighting ───────────────────────────────────────────────

export interface StageWeights {
  readonly technical: number;
  readonly structure: number;
  readonly flows: number;
  readonly onchain: number;
  readonly sentiment: number;
}

/**
 * Stage weights by regime and trading timeframe.
 *
 * On-chain data is weighted heavily on long timeframes and near-zero on
 * scalps: exchange netflow over a day says nothing about the next 15 minutes.
 * Flows and derivatives are the reverse.
 */
export function weightsFor(regime: MarketRegime, timeframe: string): StageWeights {
  const short = timeframe === "5m" || timeframe === "15m";
  const long = timeframe === "1d" || timeframe === "1w";

  const base: StageWeights = {
    technical: 0.30,
    structure: 0.30,
    flows: short ? 0.25 : 0.18,
    onchain: short ? 0.02 : long ? 0.20 : 0.10,
    sentiment: short ? 0.05 : 0.12,
  };

  // In a strong trend, structure (where the trend can continue to) matters
  // more than oscillators; in a range the levels matter even more.
  if (regime === "trending_up" || regime === "trending_down") {
    return normalize({ ...base, technical: base.technical + 0.05, structure: base.structure + 0.05, sentiment: Math.max(0, base.sentiment - 0.05) });
  }
  if (regime === "ranging") {
    return normalize({ ...base, structure: base.structure + 0.10, flows: Math.max(0, base.flows - 0.05) });
  }
  // High volatility: trust structure and flows, distrust everything slow.
  return normalize({ ...base, structure: base.structure + 0.08, flows: base.flows + 0.05, onchain: Math.max(0, base.onchain - 0.08), sentiment: Math.max(0, base.sentiment - 0.05) });
}

function normalize(w: StageWeights): StageWeights {
  const total = w.technical + w.structure + w.flows + w.onchain + w.sentiment;
  if (total <= 0) return w;
  return {
    technical: w.technical / total,
    structure: w.structure / total,
    flows: w.flows / total,
    onchain: w.onchain / total,
    sentiment: w.sentiment / total,
  };
}

/**
 * Which FACTOR IDS are nullified by the regime.
 *
 * This is the literal implementation of the spec's rule. The council zeroes
 * these factors' contributions before scoring — they do not merely count less.
 */
export function nullifiedFactors(regime: MarketRegime): readonly string[] {
  if (regime === "trending_up" || regime === "trending_down") {
    // Reversal indicators carry no weight in a trend.
    return ["divergence", "stochastic", "bb_position"];
  }
  if (regime === "ranging") {
    // Breakout indicators carry no weight in a range.
    return ["bb_squeeze", "last_break", "adx"];
  }
  return [];
}
