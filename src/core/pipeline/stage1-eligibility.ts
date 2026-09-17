/**
 * Stage 1 — eligibility.
 *
 * This runs FIRST and cheapest on purpose. Everything after it is expensive:
 * six timeframes of indicators, level clustering, pattern scanning. Spending
 * that on a coin listed nine days ago with a 40-basis-point spread is waste,
 * and worse, it produces a confident-looking analysis of something untradeable.
 *
 * Every rejection here names a number and the threshold it missed, because
 * "rejected coins" is a page on the site and "not eligible" is not an answer.
 */
import { stageFail, stagePass, type StageResult } from "@/core/pipeline/types";
import type { Factor } from "@/core/analysis/types";
import type { OrderBook, SymbolInfo, Ticker24h } from "@/core/types";

export interface EligibilityInput {
  readonly symbol: string;
  readonly info: SymbolInfo | null;
  readonly ticker: Ticker24h | null;
  readonly orderBook: OrderBook | null;
  /** Epoch ms of the coin's first candle. Null when unknown. */
  readonly listedAt: number | null;
  /** Scheduled token unlocks within the horizon, if known. */
  readonly upcomingUnlock: { at: number; percentOfSupply: number } | null;
  /** True when a recommendation on this symbol is already live. */
  readonly hasActiveRecommendation: boolean;
  readonly now: number;
}

export interface EligibilityThresholds {
  readonly minQuoteVolume24h: number;
  readonly maxSpreadBps: number;
  readonly minDepthWithin1PctUsd: number;
  readonly minListingAgeDays: number;
  readonly unlockWindowDays: number;
  readonly maxUnlockPercentOfSupply: number;
  /**
   * Whether the spread and depth gates require a live order book.
   *
   * True everywhere the bot actually trades. The ONLY caller that sets it
   * false is the backtester, because no free archive stores historical order
   * books — and rule #4 forbids inventing one. So instead of fabricating a
   * book and pretending the gate ran, the backtest SKIPS these two checks and
   * says so in a warning that follows the result all the way to the report.
   * A backtest is therefore optimistic about liquidity by exactly this much,
   * and the number of runs affected is counted rather than hidden.
   */
  readonly requireLiveBook: boolean;
}

export const DEFAULT_ELIGIBILITY: EligibilityThresholds = {
  // A coin that turns over less than this cannot absorb a position without
  // the exit itself moving the price.
  minQuoteVolume24h: 5_000_000,
  // 25bp round-trip is already a meaningful bite out of a 1.8R trade.
  maxSpreadBps: 25,
  minDepthWithin1PctUsd: 50_000,
  minListingAgeDays: 90,
  unlockWindowDays: 14,
  maxUnlockPercentOfSupply: 1,
  requireLiveBook: true,
};

const fmt = (n: number, d = 2): string =>
  Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";

const DAY = 86_400_000;

export function runEligibility(
  input: EligibilityInput,
  thresholds: EligibilityThresholds = DEFAULT_ELIGIBILITY,
): StageResult {
  const started = Date.now();
  const factors: Factor[] = [];
  const warnings: string[] = [];

  const fail = (reason: string): StageResult =>
    stageFail("eligibility", reason, {
      factors, warnings, arabic: `${input.symbol} سقطت في فلتر الأهلية: ${reason}`,
      durationMs: Date.now() - started,
    });

  // ── an existing position is the cheapest check of all ────────────────────
  if (input.hasActiveRecommendation) {
    return fail("توجد توصية نشطة على هذه العملة بالفعل — لا تُفتح ثانية");
  }

  if (!input.info) {
    return fail("العملة غير موجودة في قائمة المنصّة");
  }
  if (input.info.status !== "trading") {
    return fail(`حالة العملة على المنصّة «${input.info.status}» وليست قابلة للتداول`);
  }

  // ── listing age ──────────────────────────────────────────────────────────
  if (input.listedAt === null) {
    // Unknown age is not "old enough". Newly listed coins are exactly the ones
    // whose history we cannot read, so the unknown case must reject.
    return fail(
      `تاريخ الإدراج غير معروف — ولا يمكن التحقّق من شرط ${thresholds.minListingAgeDays} يوماً. ` +
        "العملات حديثة الإدراج هي بالضبط التي يتعذّر قراءة تاريخها، فالمجهول يُرفض.",
    );
  }
  const ageDays = (input.now - input.listedAt) / DAY;
  factors.push({
    id: "listing_age",
    label: "عمر الإدراج",
    value: ageDays,
    display: `${fmt(ageDays, 0)} يوم`,
    contribution: 0,
    note: `الحد الأدنى ${thresholds.minListingAgeDays} يوماً — قبله لا يوجد تاريخ كافٍ لأي تحليل موثوق`,
  });
  if (ageDays < thresholds.minListingAgeDays) {
    return fail(
      `مدرجة منذ ${fmt(ageDays, 0)} يوم فقط، والحد الأدنى ${thresholds.minListingAgeDays} يوماً`,
    );
  }

  // ── liquidity: volume ────────────────────────────────────────────────────
  if (!input.ticker) {
    return fail("تعذّر قراءة بيانات السعر والحجم — لا يمكن التحقّق من السيولة");
  }
  const volume = input.ticker.quoteVolume;
  factors.push({
    id: "volume_24h",
    label: "حجم التداول 24 ساعة",
    value: volume,
    display: `${fmt(volume / 1e6, 2)} مليون`,
    contribution: 0,
    note: `الحد الأدنى ${fmt(thresholds.minQuoteVolume24h / 1e6, 1)} مليون — دونه لا يستوعب السوق مركزاً دون أن يحرّك الخروج السعر بنفسه`,
  });
  if (!Number.isFinite(volume) || volume < thresholds.minQuoteVolume24h) {
    return fail(
      `حجم التداول ${fmt(volume / 1e6, 2)} مليون، والحد الأدنى ${fmt(thresholds.minQuoteVolume24h / 1e6, 1)} مليون`,
    );
  }

  // ── liquidity: spread ────────────────────────────────────────────────────
  const { bidPrice, askPrice, lastPrice } = input.ticker;
  if (!(lastPrice > 0)) {
    return fail("لا يوجد سعر صالح — تعذّر قياس السيولة");
  }

  // ── the two gates that need a live book ──────────────────────────────────
  if (!thresholds.requireLiveBook) {
    warnings.push(
      "لم يُفحص فارق العرض والطلب ولا عمق السيولة: لا يحفظ أي أرشيف مجاني دفاتر الأوامر التاريخية، " +
        "ولا تُختلق قيمة لمصدر غير متاح. النتيجة متفائلة بمقدار هذين الشرطين",
    );
    return finishPass(input, thresholds, factors, warnings, volume, ageDays, null, null, started);
  }

  if (!(bidPrice > 0 && askPrice > 0)) {
    return fail("لا توجد أسعار عرض وطلب صالحة — تعذّر قياس الفارق");
  }
  const spreadBps = ((askPrice - bidPrice) / lastPrice) * 10_000;
  factors.push({
    id: "spread",
    label: "فارق العرض والطلب",
    value: spreadBps,
    display: `${fmt(spreadBps, 1)} نقطة أساس`,
    contribution: 0,
    note: `الحد الأقصى ${thresholds.maxSpreadBps} نقطة — الفارق الواسع يقتطع من العائد قبل أن تبدأ الصفقة`,
  });
  if (spreadBps > thresholds.maxSpreadBps) {
    return fail(
      `الفارق ${fmt(spreadBps, 1)} نقطة أساس، والحد الأقصى ${thresholds.maxSpreadBps}`,
    );
  }

  // ── liquidity: real depth, not just a tight top of book ──────────────────
  if (!input.orderBook) {
    return fail("تعذّر قراءة دفتر الأوامر — لا يمكن التحقّق من عمق السيولة");
  }
  const band = lastPrice * 0.01;
  const bidDepth = input.orderBook.bids
    .filter((l) => l.price >= lastPrice - band)
    .reduce((s, l) => s + l.price * l.quantity, 0);
  const askDepth = input.orderBook.asks
    .filter((l) => l.price <= lastPrice + band)
    .reduce((s, l) => s + l.price * l.quantity, 0);
  // The THINNER side is what matters: that is the side an exit has to cross.
  const depth = Math.min(bidDepth, askDepth);

  factors.push({
    id: "depth",
    label: "عمق السيولة ضمن 1%",
    value: depth,
    display: `${fmt(depth / 1000, 0)} ألف دولار`,
    contribution: 0,
    note:
      `الحد الأدنى ${fmt(thresholds.minDepthWithin1PctUsd / 1000, 0)} ألف. ` +
      `يُقاس أضعف الجانبين (شراء ${fmt(bidDepth / 1000, 0)}ك · بيع ${fmt(askDepth / 1000, 0)}ك) ` +
      "لأن الخروج هو الذي يعبر ذلك الجانب",
  });
  if (depth < thresholds.minDepthWithin1PctUsd) {
    return fail(
      `عمق السيولة ${fmt(depth / 1000, 0)} ألف دولار ضمن 1%، والحد الأدنى ${fmt(thresholds.minDepthWithin1PctUsd / 1000, 0)} ألف`,
    );
  }

  // ── token unlock ─────────────────────────────────────────────────────────
  if (input.upcomingUnlock) {
    const daysUntil = (input.upcomingUnlock.at - input.now) / DAY;
    factors.push({
      id: "token_unlock",
      label: "فتح توكنات قادم",
      value: daysUntil,
      display: `بعد ${fmt(daysUntil, 1)} يوم · ${fmt(input.upcomingUnlock.percentOfSupply, 2)}% من المعروض`,
      contribution: 0,
      note: `يُرفض إذا كان خلال ${thresholds.unlockWindowDays} يوماً وتجاوز ${thresholds.maxUnlockPercentOfSupply}% من المعروض`,
    });
    if (
      daysUntil >= 0 &&
      daysUntil <= thresholds.unlockWindowDays &&
      input.upcomingUnlock.percentOfSupply >= thresholds.maxUnlockPercentOfSupply
    ) {
      return fail(
        `فتح توكنات بنسبة ${fmt(input.upcomingUnlock.percentOfSupply, 2)}% من المعروض بعد ${fmt(daysUntil, 1)} يوم`,
      );
    }
  } else {
    warnings.push("لا تتوفّر بيانات فتح التوكنات — لم يُتحقّق من هذا الشرط");
  }

  return finishPass(input, thresholds, factors, warnings, volume, ageDays, spreadBps, depth, started);
}

/**
 * The single pass exit.
 *
 * Shared so the book-less path cannot drift from the full one: both produce
 * the same shape, and the summary simply says "لم يُفحص" where a gate did not
 * run rather than printing a number nobody measured.
 */
function finishPass(
  input: EligibilityInput,
  _thresholds: EligibilityThresholds,
  factors: Factor[],
  warnings: string[],
  volume: number,
  ageDays: number,
  spreadBps: number | null,
  depth: number | null,
  started: number,
): StageResult {
  const arabic =
    `${input.symbol} اجتازت فلتر الأهلية. ` +
    `الحجم ${fmt(volume / 1e6, 1)} مليون، ` +
    `الفارق ${spreadBps === null ? "لم يُفحص" : `${fmt(spreadBps, 1)} نقطة أساس`}، ` +
    `عمق ${depth === null ? "لم يُفحص" : `${fmt(depth / 1000, 0)} ألف ضمن 1%`}، ` +
    `ومدرجة منذ ${fmt(ageDays, 0)} يوم.` +
    (warnings.length ? ` ملاحظة: ${warnings.join("، ")}.` : "");

  return stagePass("eligibility", {
    score: 0, // this stage gates, it does not vote on direction
    bias: "neutral",
    factors,
    confidencePenalty: 0,
    warnings,
    arabic,
    dataAgeMs: null,
    durationMs: Date.now() - started,
  });
}
