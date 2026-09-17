/**
 * Stage 5 — flows and derivatives.
 *
 * Reads who is actually initiating, where the leverage sits, and whether the
 * order book's walls are real. Its most consequential output is not the score
 * but the COMPOSITE READ: extreme funding in the trade's own direction is a
 * veto, not a deduction.
 *
 * Every input is optional. A venue without a taker split, a spot-only pair
 * with no funding, a missing book snapshot — each is reported unavailable
 * with its own penalty rather than substituted with a zero.
 */
import { analyzeCvd, type CvdResult } from "@/core/flows/cvd";
import { findLargeTrades, type LargeTradeResult } from "@/core/flows/large-trades";
import { analyzeImbalance, findWalls, trackWalls, type BookImbalance, type TrackedWall, type Wall } from "@/core/flows/orderbook";
import {
  analyzeFunding, analyzeOpenInterest, analyzePositioning, compositeRead,
  estimateLiquidationClusters, measureLiquidationClusters,
  type CompositeRead, type FundingRead, type LiquidationCluster, type LiquidationEvent,
  type OpenInterestRead, type PositioningRead,
} from "@/core/flows/derivatives";
import { stageFail, stagePass, stageUnavailable, type StageResult } from "@/core/pipeline/types";
import type { Factor } from "@/core/analysis/types";
import type { Candle, FundingRate, LongShortRatio, OpenInterest, OrderBook, Trade } from "@/core/types";

export interface FlowsInput {
  readonly symbol: string;
  readonly candles: readonly Candle[];
  /** Whether the venue reports the taker-buy split. CVD is invalid without it. */
  readonly hasTakerBreakdown: boolean;
  readonly trades: readonly Trade[] | null;
  /** Ordered oldest to newest. Two or more enable wall tracking. */
  readonly bookSnapshots: readonly OrderBook[] | null;
  readonly funding: FundingRate | null;
  readonly fundingHistory: readonly FundingRate[] | null;
  readonly openInterest: readonly OpenInterest[] | null;
  readonly longShort: readonly LongShortRatio[] | null;
  /**
   * The venue's own record of forced closes, when imported.
   *
   * Present, these REPLACE the modelled clusters: where leverage actually
   * died is a measurement, where a leverage-tier model says it might die is a
   * prior. Absent, the model still runs and says so — but the two are never
   * silently interchanged, because a reader deciding whether to trust a level
   * needs to know which one they are looking at.
   */
  readonly liquidationEvents: readonly LiquidationEvent[] | null;
  /** ATR of the trading timeframe — sets the cluster bucket width. */
  readonly atr: number | null;
  /** Direction under consideration, for the crowding veto. */
  readonly direction: "long" | "short";
  readonly now: number;
}

export interface FlowsResult extends StageResult {
  readonly cvd: CvdResult | null;
  readonly largeTrades: LargeTradeResult | null;
  readonly imbalance: BookImbalance | null;
  readonly walls: readonly (Wall | TrackedWall)[];
  readonly funding: FundingRead | null;
  readonly openInterest: OpenInterestRead | null;
  readonly positioning: PositioningRead | null;
  readonly liquidations: readonly LiquidationCluster[];
  readonly composite: CompositeRead;
  /** Multiplier the council applies to confidence. */
  readonly confidenceMultiplier: number;
}

const WEIGHTS = {
  cvd: 35,
  largeTrades: 20,
  imbalance: 15,
  funding: 15,
  positioning: 15,
} as const;

const clamp = (n: number, lo = -100, hi = 100): number => Math.max(lo, Math.min(hi, n));
const fmt = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : "—");

export function runFlows(input: FlowsInput): FlowsResult {
  const started = Date.now();
  const factors: Factor[] = [];
  const warnings: string[] = [];
  const unavailableParts: string[] = [];

  const n = input.candles.length;
  const price = n > 0 ? input.candles[n - 1].close : NaN;

  // ── cumulative volume delta ──────────────────────────────────────────────
  let cvd: CvdResult | null = null;
  if (input.hasTakerBreakdown && n >= 40) {
    cvd = analyzeCvd(input.candles, 40);
    const normalized = clamp(cvd.netRatio * 4, -1, 1);
    factors.push({
      id: "cvd", label: "دلتا الحجم التراكمي", value: cvd.netRatio,
      display: `${cvd.netRatio >= 0 ? "+" : "−"}${fmt(Math.abs(cvd.netRatio) * 100, 1)}% من الحجم`,
      contribution: normalized * WEIGHTS.cvd,
      note: cvd.arabic,
    });
    if (cvd.divergence) warnings.push(cvd.divergence.arabic);
  } else {
    const why = !input.hasTakerBreakdown
      ? "هذه المنصّة لا تُفصّل حجم المشتري المبادر في الشموع"
      : `التاريخ ${n} شمعة فقط`;
    factors.push({
      id: "cvd", label: "دلتا الحجم التراكمي", value: null, display: "غير متاحة",
      contribution: 0, note: `${why} — تُحسب الدلتا من أصفار لو استُخدمت، فتبدو بيعاً عنيفاً في كل شمعة.`,
    });
    unavailableParts.push("دلتا الحجم");
  }

  // ── large prints ─────────────────────────────────────────────────────────
  let largeTrades: LargeTradeResult | null = null;
  if (input.trades && input.trades.length >= 30) {
    largeTrades = findLargeTrades(input.trades);
    const normalized = clamp(largeTrades.bias * Math.min(1, largeTrades.shareOfVolume * 3), -1, 1);
    factors.push({
      id: "large_trades", label: "الصفقات الكبيرة الشاذة", value: largeTrades.bias,
      display: `${largeTrades.trades.length} صفقة · ميل ${fmt(largeTrades.bias * 100, 0)}%`,
      contribution: normalized * WEIGHTS.largeTrades,
      note: largeTrades.arabic,
    });
  } else {
    factors.push({
      id: "large_trades", label: "الصفقات الكبيرة الشاذة", value: null, display: "غير متاحة",
      contribution: 0, note: "لا توجد صفقات منفّذة كافية لتمييز الشاذّ منها",
    });
    unavailableParts.push("الصفقات الكبيرة");
  }

  // ── order book ───────────────────────────────────────────────────────────
  let imbalance: BookImbalance | null = null;
  let walls: (Wall | TrackedWall)[] = [];

  if (input.bookSnapshots && input.bookSnapshots.length > 0) {
    const latest = input.bookSnapshots[input.bookSnapshots.length - 1];
    imbalance = analyzeImbalance(latest, 1);

    // Wall BEHAVIOUR needs a sequence; a single snapshot can only list them.
    walls = input.bookSnapshots.length >= 2
      ? trackWalls(input.bookSnapshots)
      : findWalls(latest);

    const pulled = walls.filter((w) => "behaviour" in w && w.behaviour === "pulled");
    const held = walls.filter((w) => "behaviour" in w && w.behaviour === "held");

    factors.push({
      id: "book_imbalance", label: "اختلال دفتر الأوامر", value: imbalance.imbalance,
      display: `${fmt(imbalance.imbalance * 100, 0)}%`,
      contribution: clamp(imbalance.imbalance * 1.2, -1, 1) * WEIGHTS.imbalance,
      note: imbalance.arabic,
    });

    if (walls.length > 0) {
      factors.push({
        id: "walls", label: "جدران السيولة", value: walls.length,
        display: input.bookSnapshots.length >= 2
          ? `${held.length} صمد · ${pulled.length} سُحب`
          : `${walls.length} جدار (لقطة واحدة)`,
        contribution: 0,
        note: input.bookSnapshots.length >= 2
          ? walls.map((w) => ("arabic" in w ? w.arabic : "")).filter(Boolean).slice(0, 3).join(" ")
          : "لقطة واحدة لا تكفي لمعرفة إن كانت الجدران ثابتة أم تُسحب عند الاقتراب — " +
            "والجدار الوهمي يبدو مطابقاً للحقيقي في أي لقطة منفردة.",
      });
      if (pulled.length > 0) {
        warnings.push(`${pulled.length} جدار سُحب عند اقتراب السعر — المستويات التي كان يوحي بها غير موجودة`);
      }
    }
  } else {
    factors.push({
      id: "book_imbalance", label: "دفتر الأوامر", value: null, display: "غير متاح",
      contribution: 0, note: "لا توجد لقطة لدفتر الأوامر",
    });
    unavailableParts.push("دفتر الأوامر");
  }

  // ── derivatives ──────────────────────────────────────────────────────────
  let funding: FundingRead | null = null;
  if (input.funding && input.fundingHistory) {
    funding = analyzeFunding(input.funding, input.fundingHistory);
    // Funding is contrarian: expensive longs argue AGAINST buying.
    const normalized = funding.percentile != null ? clamp(-(funding.percentile - 0.5) * 2, -1, 1) : 0;
    factors.push({
      id: "funding", label: "معدّل التمويل", value: funding.current,
      display: funding.percentile != null
        ? `المئوي ${fmt(funding.percentile * 100, 0)} · ${fmt(funding.annualizedPct, 1)}% سنوياً`
        : `${fmt(funding.annualizedPct, 1)}% سنوياً (بلا تاريخ كافٍ)`,
      contribution: normalized * WEIGHTS.funding,
      note: funding.arabic,
    });
  } else {
    factors.push({
      id: "funding", label: "معدّل التمويل", value: null, display: "غير متاح",
      contribution: 0, note: "لا بيانات تمويل — الزوج فوري أو المنصّة لا توفّرها",
    });
    unavailableParts.push("التمويل");
  }

  const openInterest = input.openInterest && input.openInterest.length >= 2
    ? analyzeOpenInterest(input.openInterest)
    : null;
  if (openInterest) {
    factors.push({
      id: "open_interest", label: "العقود المفتوحة", value: openInterest.changePct,
      display: `${openInterest.changePct != null && openInterest.changePct >= 0 ? "+" : "−"}${fmt(Math.abs(openInterest.changePct ?? 0), 2)}%`,
      contribution: 0, // read only through the composite, never on its own
      note: `${openInterest.arabic} العقود المفتوحة وحدها لا تحمل اتجاهاً — معناها يظهر فقط مقترنة بالسعر والتمويل.`,
    });
  } else {
    unavailableParts.push("العقود المفتوحة");
  }

  const positioning = input.longShort ? analyzePositioning(input.longShort) : null;
  if (positioning) {
    // Contrarian, and weakly: account ratios are noisy.
    const normalized = positioning.percentile != null
      ? clamp(-(positioning.percentile - 0.5) * 1.4, -1, 1)
      : 0;
    factors.push({
      id: "long_short", label: "نسبة الطويل للقصير", value: positioning.ratio,
      display: `${fmt(positioning.longPct, 1)}% / ${fmt(positioning.shortPct, 1)}%`,
      contribution: normalized * WEIGHTS.positioning,
      note: positioning.arabic,
    });
  } else {
    unavailableParts.push("نسبة الطويل للقصير");
  }

  // ── liquidation clusters ─────────────────────────────────────────────────
  //
  // Measured where the venue's own record exists; modelled otherwise. The
  // factor's label says which, because a level somebody's money actually died
  // on is a different object from a level a leverage model points at.
  const oiNotional = input.openInterest?.[input.openInterest.length - 1]?.openInterestValue;
  const measured =
    input.liquidationEvents && input.liquidationEvents.length > 0 && input.atr
      ? measureLiquidationClusters(input.liquidationEvents, price, input.atr)
      : [];

  const liquidations = measured.length > 0
    ? measured
    : Number.isFinite(oiNotional) && Number.isFinite(price)
      ? estimateLiquidationClusters(price, oiNotional as number)
      : [];

  if (liquidations.length > 0) {
    const isMeasured = measured.length > 0;
    // Nearest, not largest: proximity is what makes a cluster act as a magnet.
    const nearest = [...liquidations].sort(
      (a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct),
    )[0];
    const total = liquidations.reduce((sum, c) => sum + c.estimatedNotional, 0);

    factors.push({
      id: "liquidations",
      label: isMeasured ? "تجمّعات التصفيات (مقيسة)" : "تجمّعات التصفيات (تقدير)",
      value: nearest.distancePct,
      display: `أقربها ${fmt(nearest.distancePct, 2)}% (${nearest.side === "long" ? "شراء" : "بيع"})`,
      contribution: 0,
      note: isMeasured
        ? `مقيسة من سجلّ التصفيات الفعلي للمنصّة: ${liquidations.length} تجمّعاً ` +
          `بإجمالي ${fmt(total / 1e6, 1)} مليون دولار صُفّيت في النافذة. ` +
          "التجمّعات القريبة تعمل مغناطيساً: السعر يميل للوصول إليها قبل أن ينعكس."
        : "تقدير مبنيّ على توزيع العقود المفتوحة على شرائح الرافعة الشائعة — وليس قياساً. " +
          "استورد سجلّ التصفيات (npm run backfill) ليتحوّل هذا إلى قياس. " +
          "التجمّعات القريبة تعمل مغناطيساً: السعر يميل للوصول إليها قبل أن ينعكس.",
    });
  }

  // ── the composite read ───────────────────────────────────────────────────
  const priceChangePct = n >= 40
    ? ((input.candles[n - 1].close - input.candles[n - 40].close) / input.candles[n - 40].close) * 100
    : 0;

  const composite = funding
    ? compositeRead({
        priceChangePct,
        openInterestChangePct: openInterest?.changePct ?? null,
        funding,
        cvdNetRatio: cvd?.netRatio ?? null,
        direction: input.direction,
      })
    : { kind: "none" as const, confidenceMultiplier: 1, veto: false,
        arabic: "القراءات المركّبة تحتاج بيانات تمويل، وهي غير متاحة." };

  if (composite.kind !== "none") {
    factors.push({
      id: "composite", label: "القراءة المركّبة", value: composite.confidenceMultiplier,
      display: compositeLabel(composite.kind),
      contribution: 0,
      note: composite.arabic,
    });
  }

  const score = clamp(factors.reduce((s, f) => s + f.contribution, 0));
  const bias = score > 15 ? "bullish" : score < -15 ? "bearish" : "neutral";

  // Every missing input costs a declared share of this stage's weight.
  const penalty = Math.min(0.6, unavailableParts.length * 0.12);

  const arabic = [
    `التدفّقات والمشتقّات على ${input.symbol}: النتيجة ${fmt(score, 0)}.`,
    cvd?.arabic ?? "",
    funding?.arabic ?? "",
    openInterest?.arabic ?? "",
    composite.kind !== "none" ? composite.arabic : "",
    unavailableParts.length > 0 ? `غير متاح: ${unavailableParts.join("، ")}.` : "",
  ].filter(Boolean).join(" ");

  const base = {
    cvd, largeTrades, imbalance, walls, funding, openInterest, positioning,
    liquidations, composite,
    confidenceMultiplier: composite.confidenceMultiplier,
  };

  // The crowding veto fails the stage outright — it is not a deduction.
  if (composite.veto) {
    return {
      ...stageFail("flows", composite.arabic, {
        score, bias, factors, warnings, arabic, durationMs: Date.now() - started,
      }),
      ...base,
    };
  }

  // Nothing readable at all is "unavailable", not a pass with a zero.
  if (unavailableParts.length >= 4) {
    return {
      ...stageUnavailable("flows", `تعذّر قراءة: ${unavailableParts.join("، ")}`, 0.2, {
        factors, warnings, durationMs: Date.now() - started,
      }),
      ...base,
    };
  }

  return {
    ...stagePass("flows", {
      score, bias, factors, confidencePenalty: penalty, warnings, arabic,
      dataAgeMs: input.funding ? input.now - input.funding.fundingTime : null,
      durationMs: Date.now() - started,
    }),
    ...base,
  };
}

function compositeLabel(kind: CompositeRead["kind"]): string {
  const map: Record<CompositeRead["kind"], string> = {
    leveraged_fragile: "ارتفاع مموّل برافعة — هشّ",
    genuine_spot: "شراء نقدي حقيقي",
    crowded_against: "السوق مزدحم ضدّك",
    short_squeeze_fuel: "وقود لضغط البائعين",
    none: "لا قراءة واضحة",
  };
  return map[kind];
}
