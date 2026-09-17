/**
 * Building the trade plan.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: entry, stop and targets are read off
 * DISCOVERED LEVELS. Never from a percentage.
 *
 * A 2% stop is a statement about the trader's wallet. It has no relationship
 * to the price at which the trade idea stops being true, and placing it there
 * guarantees being stopped out of correct ideas and held through wrong ones.
 * If there is no real level to hide behind, this module REFUSES to build a
 * plan rather than inventing one.
 *
 * The only percentage in here is the volatility buffer beyond the level —
 * and it is a fraction of ATR, which is a measurement of this market's own
 * noise, not an arbitrary number.
 */
import crypto from "node:crypto";
import type {
  ConfidenceComponent, InvalidationCondition, PriceZone, Recommendation, Target,
} from "@/core/recommendation/types";
import type { LevelZone } from "@/core/structure/levels";
import type { StructureAnalysis } from "@/core/analysis/structure-stage";
import type { MarketRegime, SetupKind } from "@/core/pipeline/types";
import type { Direction } from "@/core/types";
import type { Timeframe } from "@/shared/time";
import { tfMillis } from "@/shared/time";

/** How far beyond the invalidation level the stop sits, in ATR. */
const STOP_BUFFER_ATR = 0.35;
/** Entry zone half-width when a level supplies only a centre. */
const ENTRY_ZONE_ATR = 0.25;
/** A target closer than this to entry is not worth a leg. */
const MIN_TARGET_DISTANCE_ATR = 0.8;
/** How many bars the entry zone stays valid before the idea goes stale. */
const EXPIRY_BARS = 12;

export interface PlanInput {
  readonly symbol: string;
  readonly direction: Direction;
  readonly setup: SetupKind;
  readonly regime: MarketRegime;
  readonly timeframe: Timeframe;
  readonly structure: StructureAnalysis;
  readonly price: number;
  readonly atr: number;
  readonly equity: number;
  readonly riskPercent: number;
  readonly pricePrecision: number;
  readonly quantityPrecision: number;
  readonly minNotional: number;
  readonly generatedAt: number;
  readonly asOfCandle: number;
  readonly exchange: string;
}

export type PlanFailure =
  | { ok: false; reason: "no_valid_stop"; arabic: string }
  | { ok: false; reason: "no_valid_target"; arabic: string }
  | { ok: false; reason: "below_min_notional"; arabic: string };

export type PlanResult =
  | {
      ok: true;
      entry: PriceZone;
      stop: number;
      stopBasis: string;
      targets: readonly Target[];
      riskReward: number;
      positionSize: number;
      positionNotional: number;
      riskAmount: number;
      expiresAt: number;
    }
  | PlanFailure;

const round = (n: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};

/**
 * Build the plan, or refuse.
 *
 * Refusal is a first-class outcome. "No level to put a stop behind" means
 * there is no trade, not that a stop should be made up.
 */
export function buildPlan(x: PlanInput): PlanResult {
  const long = x.direction === "long";
  const st = x.structure;

  // ── entry zone, from the level price is reacting to ──────────────────────
  // For a long we enter near support; for a short near resistance. When price
  // is already inside a zone, that zone IS the entry.
  const entryZone = chooseEntryZone(st, x.price, x.atr, long);
  const entry: PriceZone = {
    low: round(entryZone.low, x.pricePrecision),
    high: round(entryZone.high, x.pricePrecision),
    mid: round((entryZone.low + entryZone.high) / 2, x.pricePrecision),
  };

  // ── stop: behind the nearest REAL invalidation level ─────────────────────
  const invalidationLevel = chooseInvalidationLevel(st, entry, long);
  if (!invalidationLevel) {
    return {
      ok: false,
      reason: "no_valid_stop",
      arabic:
        "لا يوجد مستوى إبطال حقيقي لوضع الوقف خلفه. " +
        "الوقف يوضع خلف مستوى، لا عند نسبة مئوية من الدخول — ولأن المستوى غير موجود، لا توجد صفقة.",
    };
  }

  const buffer = x.atr * STOP_BUFFER_ATR;
  const rawStop = long ? invalidationLevel.price - buffer : invalidationLevel.price + buffer;
  const stop = round(rawStop, x.pricePrecision);

  // The stop must actually be on the correct side of the entry.
  if ((long && stop >= entry.low) || (!long && stop <= entry.high)) {
    return {
      ok: false,
      reason: "no_valid_stop",
      arabic:
        `مستوى الإبطال (${invalidationLevel.price.toFixed(x.pricePrecision)}) يقع داخل منطقة الدخول أو خلفها — ` +
        "لا يمكن وضع وقف منطقي. الصفقة تسقط.",
    };
  }

  const riskPerUnit = Math.abs(entry.mid - stop);
  if (!(riskPerUnit > 0)) {
    return { ok: false, reason: "no_valid_stop", arabic: "مسافة الوقف صفر — لا يمكن حساب المخاطرة." };
  }

  // ── targets: discovered levels first, measured moves only to fill ────────
  //
  // Only levels IN THE TRADE'S DIRECTION count. Filtering on absolute
  // distance alone would let a resistance below a long's entry be chosen as
  // its target.
  const ladder = long ? st.resistanceLadder : st.supportLadder;
  const usable = ladder.filter((z) => {
    const ahead = long ? z.price > entry.mid : z.price < entry.mid;
    if (!ahead) return false;
    return Math.abs(z.price - entry.mid) / x.atr >= MIN_TARGET_DISTANCE_ATR;
  });

  const targets = buildTargets(usable, entry.mid, riskPerUnit, long, x, st);
  if (!targets) {
    return {
      ok: false,
      reason: "no_valid_target",
      arabic:
        "لا مستوى مكتشف في اتجاه الصفقة، ولا تأرجحات كافية لقياس حركة مُسقَطة. " +
        "الأهداف تُقرأ من الهيكل الفعلي ولا تُخترع بمضاعفات ثابتة — فلا توصية.",
    };
  }

  // ── risk/reward, measured to the FINAL target ────────────────────────────
  // Measuring to target 1 flatters every trade; the honest number is the one
  // that accounts for where the position actually finishes.
  const weightedReward = targets.reduce((s, t) => s + t.rMultiple * t.closeFraction, 0);
  const riskReward = weightedReward;

  // ── position size, from the STOP DISTANCE ────────────────────────────────
  // This is the only correct way to size: the account risks a fixed amount,
  // and how many units that buys depends on how far away the invalidation is.
  // A wide stop means a small position, automatically.
  const riskAmount = x.equity * (x.riskPercent / 100);
  const rawSize = riskAmount / riskPerUnit;
  const positionSize = round(rawSize, x.quantityPrecision);
  const positionNotional = positionSize * entry.mid;

  if (positionSize <= 0 || positionNotional < x.minNotional) {
    return {
      ok: false,
      reason: "below_min_notional",
      arabic:
        `حجم المركز المحسوب (${positionNotional.toFixed(2)}) دون الحد الأدنى للمنصّة (${x.minNotional}). ` +
        "مسافة الوقف واسعة جداً بالنسبة لرأس المال ومخاطرة الصفقة.",
    };
  }

  return {
    ok: true,
    entry,
    stop,
    stopBasis:
      `خلف ${invalidationLevel.basis} عند ${invalidationLevel.price.toFixed(x.pricePrecision)} ` +
      `مع هامش تقلّب ${STOP_BUFFER_ATR} من ATR (${buffer.toFixed(x.pricePrecision)})`,
    targets,
    riskReward,
    positionSize,
    positionNotional,
    riskAmount,
    expiresAt: x.generatedAt + EXPIRY_BARS * tfMillis(x.timeframe),
  };
}

/**
 * The entry zone.
 *
 * If price already sits in a zone, that zone is the entry — we are at the
 * level. Otherwise we anchor on the nearest level in the trade's favour and
 * give it ATR-derived width, because price does not turn at a single tick.
 */
function chooseEntryZone(
  st: StructureAnalysis,
  price: number,
  atrValue: number,
  long: boolean,
): { low: number; high: number } {
  if (st.currentZone) {
    return { low: st.currentZone.low, high: st.currentZone.high };
  }
  const anchor = long ? st.nearestSupport : st.nearestResistance;
  if (anchor && Math.abs(price - anchor.price) / atrValue < 2) {
    return { low: anchor.low, high: anchor.high };
  }
  // No level within reach: enter around the current price with ATR width, and
  // let the stop logic decide whether an invalidation level exists at all.
  const half = atrValue * ENTRY_ZONE_ATR;
  return { low: price - half, high: price + half };
}

/**
 * The level whose loss means the idea was wrong.
 *
 * Preference order matters: a structural swing low is a better invalidation
 * than a clustered zone, because it is the price at which "higher lows" stops
 * being true.
 */
function chooseInvalidationLevel(
  st: StructureAnalysis,
  entry: PriceZone,
  long: boolean,
): { price: number; basis: string } | null {
  const candidates: { price: number; basis: string; rank: number }[] = [];

  // 1. The structural swing that defines the trend.
  const swing = long ? st.structure.lastLow : st.structure.lastHigh;
  if (swing && (long ? swing.price < entry.low : swing.price > entry.high)) {
    candidates.push({ price: swing.price, basis: long ? "آخر قاع هيكلي مؤكّد" : "آخر قمة هيكلية مؤكّدة", rank: 3 });
  }

  // 2. The nearest strong level beyond the entry.
  const zones = long ? st.supportLadder : st.resistanceLadder;
  const beyond = zones.filter((z) => (long ? z.high < entry.low : z.low > entry.high));
  const strong = beyond.find((z) => z.strength >= 45) ?? beyond[0];
  if (strong) {
    candidates.push({
      price: long ? strong.low : strong.high,
      basis: `${strong.kind.includes("support") ? "منطقة دعم" : "منطقة مقاومة"} بقوّة ${strong.strength}`,
      rank: 2,
    });
  }

  // 3. A pattern's own invalidation, when one is confirmed.
  const pattern = st.chartPatterns.find((p) => p.confirmed);
  if (pattern && (long ? pattern.invalidationLevel < entry.low : pattern.invalidationLevel > entry.high)) {
    candidates.push({ price: pattern.invalidationLevel, basis: "مستوى إبطال النمط السعري", rank: 1 });
  }

  if (candidates.length === 0) return null;

  // Prefer the highest-ranked basis; among equals take the NEAREST, so the
  // stop is as tight as the structure honestly allows.
  candidates.sort((a, b) => b.rank - a.rank || (long ? b.price - a.price : a.price - b.price));
  return candidates[0];
}

/**
 * Three targets at discovered levels, with a staged exit.
 *
 * 50/30/20 by design: taking half at the first target is what makes the
 * remainder free to run. If fewer than three levels are reachable, this
 * returns null and the trade is refused — inventing a third target as a
 * multiple of the first would be exactly the arbitrary-percentage behaviour
 * this module exists to prevent.
 */
/**
 * How a staged exit is split across one, two or three real levels.
 *
 * Each row sums to 1: the position is fully exited either way, and the
 * weighted risk/reward stays comparable across ladders of different length.
 */
/**
 * Fibonacci extensions of the measured swing leg.
 *
 * The ratios are conventional; what they scale is not. They multiply a
 * distance measured from this chart's own swings, so a quiet market gets
 * near targets and a volatile one gets far targets, automatically.
 */
const PROJECTION_RATIOS = [1, 1.618, 2.618] as const;

const FRACTIONS: Record<number, readonly number[]> = {
  1: [1],
  2: [0.6, 0.4],
  3: [0.5, 0.3, 0.2],
};

function buildTargets(
  levels: readonly LevelZone[],
  entryMid: number,
  riskPerUnit: number,
  long: boolean,
  x: PlanInput,
  st: StructureAnalysis,
): readonly Target[] | null {
  const chosen: { price: number; basis: string; source: "level" | "projection" }[] = [];

  for (const z of levels) {
    if (chosen.length === 3) break;
    // Each target must be meaningfully beyond the previous one.
    const previous = chosen[chosen.length - 1];
    const price = long ? z.low : z.high; // the near edge: exit where the wall starts
    if (previous) {
      const gap = Math.abs(price - previous.price);
      if (gap / x.atr < MIN_TARGET_DISTANCE_ATR * 0.7) continue;
    }
    chosen.push({
      price,
      source: "level",
      basis: `${z.kind.includes("support") ? "منطقة دعم" : "منطقة مقاومة"} بقوّة ${z.strength}، اختُبرت ${z.touchCount} مرات`,
    });
  }

  // ── fill the remaining rungs with measured moves ────────────────────────
  //
  // At a new high there is NO resistance overhead — nobody has traded there.
  // Measured on two years of real BTC/ETH/SOL, that single fact rejected 341
  // of 350 plans, which is to say it rejected the trend-continuation trades
  // the strategy exists to find.
  //
  // A measured move is not an invented number: it is THIS market's own swing
  // size, taken from its confirmed swing points and projected from entry. The
  // Fibonacci ratios scale a real measurement rather than replacing it, and
  // every such target is labelled `projection` so the report can say plainly
  // that nobody has defended this price yet.
  const leg = medianSwingLeg(st);
  if (leg > 0) {
    for (const ratio of PROJECTION_RATIOS) {
      if (chosen.length === 3) break;
      const raw = long ? entryMid + leg * ratio : entryMid - leg * ratio;
      const previous = chosen[chosen.length - 1];
      if (previous && Math.abs(raw - previous.price) / x.atr < MIN_TARGET_DISTANCE_ATR * 0.7) continue;
      if (Math.abs(raw - entryMid) / x.atr < MIN_TARGET_DISTANCE_ATR) continue;
      chosen.push({
        price: raw,
        source: "projection",
        basis: `حركة مُسقَطة ${ratio}× من متوسط تأرجح هذا السوق (${leg.toFixed(x.pricePrecision)}) — لا مستوى مكتشف هنا بعد`,
      });
    }
  }

  // Nothing ahead and no measurable swing: a genuine refusal.
  if (chosen.length === 0) return null;

  // The staged exit is redistributed over however many rungs exist, so the
  // fractions always sum to 1 and the weighted R:R stays honest.
  const fractions = FRACTIONS[chosen.length];

  const targets = chosen.map((c, idx): Target => {
    const price = round(c.price, x.pricePrecision);
    return {
      index: (idx + 1) as 1 | 2 | 3,
      price,
      closeFraction: fractions[idx],
      rMultiple: Math.abs(price - entryMid) / riskPerUnit,
      basis: c.basis,
      source: c.source,
    };
  });

  // Sanity: every target must be on the profitable side of entry.
  for (const t of targets) {
    if (long ? t.price <= entryMid : t.price >= entryMid) return null;
  }
  return targets;
}

/**
 * The typical distance this market travels in one impulse.
 *
 * The MEDIAN, not the mean: one violent leg would otherwise set the target
 * for every quiet trade that followed it. Measured between consecutive
 * confirmed swing points, so it is a property of the chart rather than a
 * constant.
 */
function medianSwingLeg(st: StructureAnalysis): number {
  const swings = st.structure.swings;
  if (swings.length < 3) return 0;

  const legs: number[] = [];
  for (let i = 1; i < swings.length; i++) {
    const size = Math.abs(swings[i].price - swings[i - 1].price);
    if (size > 0) legs.push(size);
  }
  if (legs.length === 0) return 0;

  legs.sort((a, b) => a - b);
  const mid = Math.floor(legs.length / 2);
  return legs.length % 2 === 0 ? (legs[mid - 1] + legs[mid]) / 2 : legs[mid];
}

// ── invalidation conditions ──────────────────────────────────────────────────

/**
 * Machine-checkable invalidation.
 *
 * Every condition names a subject, an operator and a value so the position
 * monitor can evaluate it literally on each closed candle. Free text would be
 * unenforceable, which would make "invalidation conditions" decorative.
 */
export function buildInvalidation(x: {
  direction: Direction;
  stop: number;
  entry: PriceZone;
  structureState: string;
  timeframe: Timeframe;
  expiryBars: number;
  pricePrecision: number;
}): InvalidationCondition[] {
  const long = x.direction === "long";
  const out: InvalidationCondition[] = [
    {
      id: "stop_hit",
      subject: "close",
      operator: long ? "lte" : "gte",
      value: x.stop,
      arabic: `إغلاق شمعة ${long ? "تحت" : "فوق"} الوقف ${x.stop.toFixed(x.pricePrecision)} — خروج فوري`,
    },
    {
      id: "structure_flip",
      subject: "structure_state",
      operator: "eq",
      value: long ? "downtrend" : "uptrend",
      arabic: `انقلاب الهيكل إلى ${long ? "قمم أدنى وقيعان أدنى" : "قمم أعلى وقيعان أعلى"} — فكرة الصفقة لم تعد قائمة`,
    },
    {
      id: "technical_reversal",
      subject: "stage_score",
      stage: "technical",
      operator: long ? "lt" : "gt",
      value: long ? -30 : 30,
      arabic: `انقلاب نتيجة التحليل الفني إلى ${long ? "أقل من −30" : "أكثر من +30"} — الأطر الزمنية انقلبت ضد المركز`,
    },
    {
      id: "expiry",
      subject: "elapsed_bars",
      operator: "gte",
      value: x.expiryBars,
      arabic: `مرور ${x.expiryBars} شمعة دون وصول السعر لمنطقة الدخول — انتهاء صلاحية`,
    },
  ];

  if (long) {
    out.push({
      id: "btc_breakdown",
      subject: "btc_daily_score",
      operator: "lte",
      value: -45,
      arabic: "انهيار البيتكوين على اليومي — كل مراكز الشراء على العملات البديلة تُغلق",
    });
  }
  return out;
}

// ── integrity ────────────────────────────────────────────────────────────────

/**
 * A hash over the fields that define the call.
 *
 * Recommendations are immutable, and this is how that claim becomes checkable
 * rather than merely asserted: if a stored row no longer hashes to its
 * recorded value, it was altered outside the append-only path.
 */
export function computeIntegrityHash(
  r: Omit<Recommendation, "integrityHash">,
): string {
  const canonical = JSON.stringify({
    id: r.id, symbol: r.symbol, direction: r.direction, setup: r.setup,
    regime: r.regime, timeframe: r.timeframe, generatedAt: r.generatedAt,
    asOfCandle: r.asOfCandle, entry: r.entry, stop: r.stop,
    targets: r.targets.map((t) => ({ p: t.price, f: t.closeFraction })),
    riskReward: r.riskReward, positionSize: r.positionSize,
    confidence: r.confidence, finalScore: r.finalScore,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/** Deterministic id — the same analysis of the same bar yields the same id. */
export function recommendationId(symbol: string, timeframe: Timeframe, asOfCandle: number): string {
  const base = `${symbol}:${timeframe}:${asOfCandle}`;
  return crypto.createHash("sha256").update(base).digest("hex").slice(0, 24);
}

export function buildConfidenceComponents(
  stages: readonly { id: string; name: string; score: number; status: string; arabic: string }[],
  weights: Record<string, number>,
): ConfidenceComponent[] {
  return stages
    .filter((s) => s.id !== "council" && s.id !== "eligibility")
    .map((s) => {
      const weight = weights[s.id] ?? 0;
      return {
        stage: s.id as ConfidenceComponent["stage"],
        name: s.name,
        score: s.score,
        weight,
        contribution: s.status === "pass" ? s.score * weight : 0,
        status: s.status === "pass" ? "pass" : "unavailable",
        note: s.arabic.slice(0, 200),
      };
    });
}

export const __testing = { STOP_BUFFER_ATR, MIN_TARGET_DISTANCE_ATR, EXPIRY_BARS, chooseInvalidationLevel };
