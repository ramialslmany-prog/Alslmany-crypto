/**
 * Position monitoring — evaluated on every CLOSED candle.
 *
 * Pure: state and a candle in, a list of actions out. Nothing here touches a
 * clock, a database or a network, which is what lets the backtester drive the
 * identical function over historical bars.
 *
 * TWO RULES THAT DECIDE WHETHER THE BACKTEST IS HONEST:
 *
 *  1. DETECTION HAPPENS ON THE CLOSE, EXECUTION ON THE NEXT OPEN. We learn
 *     that price entered the zone only when the candle finishes. Filling at
 *     that same candle's close — or worse, at the exact zone price — assumes
 *     we acted on information we did not yet have. Every action returned here
 *     is executed by the broker at the NEXT bar's open.
 *
 *  2. WHEN A BAR TOUCHES BOTH THE STOP AND A TARGET, THE STOP WINS. From
 *     daily OHLC we cannot know which came first, and assuming the favourable
 *     order is the single most common way a backtest invents profit that does
 *     not exist. Pessimism here is not conservatism, it is refusing to make
 *     up the sequence.
 */
import type { Candle } from "@/core/types";
import type { Position, PositionAction, ExitReason } from "@/core/execution/types";
import type { InvalidationCondition } from "@/core/recommendation/types";

export interface MonitorContext {
  /** The closed candle being evaluated. */
  readonly candle: Candle;
  /** Bar index, for elapsed-bar conditions. */
  readonly barIndex: number;
  /** ATR at this bar — drives the trailing stop distance. */
  readonly atr: number;
  /** Current structure state, for the structure-flip invalidation. */
  readonly structureState: string;
  /** Current stage scores, for the score-based invalidations. */
  readonly stageScores: Record<string, number>;
  /** Bitcoin's daily score, for the breakdown invalidation. */
  readonly btcDailyScore: number | null;
  /** True when the flows stage has turned against the position. */
  readonly flowsAgainst: boolean;
  readonly invalidation: readonly InvalidationCondition[];
  readonly now: number;
}

/** How far the trailing stop sits behind price, in ATR, after target 2. */
const TRAIL_ATR = 1.5;

export function evaluatePosition(position: Position, ctx: MonitorContext): PositionAction[] {
  if (position.status === "closed" || position.status === "expired" || position.status === "invalidated") {
    return [];
  }
  return position.status === "pending"
    ? evaluatePending(position, ctx)
    : evaluateOpen(position, ctx);
}

/**
 * A pending position is waiting for price to reach the entry zone.
 *
 * Three things can happen: price arrives (and we re-validate before acting),
 * the idea is invalidated before we ever enter, or it expires.
 */
function evaluatePending(position: Position, ctx: MonitorContext): PositionAction[] {
  const { candle } = ctx;

  // Expiry first — a stale idea should not be entered even if price arrives
  // on the same bar it times out.
  if (ctx.now >= position.expiresAt) {
    return [{
      kind: "expire",
      reason: `لم يصل السعر لمنطقة الدخول قبل انتهاء الصلاحية — أُلغيت التوصية دون تنفيذ`,
    }];
  }

  // Invalidation BEFORE entry: the spec's "re-check immediately before
  // executing". If something material changed, we cancel rather than enter a
  // trade whose premise no longer holds.
  const broken = checkInvalidation(position, ctx, { preEntry: true });
  if (broken) {
    return [{ kind: "invalidate", reason: `تغيّر جوهري قبل التنفيذ: ${broken}` }];
  }

  // Did this candle trade inside the entry zone?
  const touched = candle.low <= position.plannedEntry.high && candle.high >= position.plannedEntry.low;
  if (!touched) return [];

  // The stop being taken out on the very bar that reached the entry means the
  // idea failed before it started — do not enter.
  const stopBreached = position.direction === "long"
    ? candle.low <= position.currentStop
    : candle.high >= position.currentStop;
  if (stopBreached) {
    return [{
      kind: "invalidate",
      reason: "السعر لمس منطقة الدخول والوقف في نفس الشمعة — الفكرة سقطت قبل أن تبدأ",
    }];
  }

  return [{
    kind: "fill_entry",
    price: position.plannedEntry.mid,
    quantity: position.plannedSize,
    reason: "وصل السعر لمنطقة الدخول والشروط ما زالت قائمة",
  }];
}

function evaluateOpen(position: Position, ctx: MonitorContext): PositionAction[] {
  const actions: PositionAction[] = [];
  const { candle } = ctx;
  const long = position.direction === "long";

  // ── 1. invalidation conditions come first ────────────────────────────────
  const broken = checkInvalidation(position, ctx, { preEntry: false });
  if (broken) {
    return [{
      kind: "hit_stop",
      price: candle.close,
      quantity: position.openQuantity,
      reason: "invalidated" as ExitReason,
    }, { kind: "alert", reason: `خروج فوري: ${broken}` }];
  }

  // ── 2. the stop ──────────────────────────────────────────────────────────
  const stopHit = long ? candle.low <= position.currentStop : candle.high >= position.currentStop;

  // ── 3. which targets this bar reached ────────────────────────────────────
  const reached = position.plannedTargets.filter((t) => {
    if (position.targetsHit.includes(t.index)) return false;
    return long ? candle.high >= t.price : candle.low <= t.price;
  });

  // THE AMBIGUOUS BAR. Both the stop and a target are inside this bar's range
  // and OHLC cannot tell us the order. We take the stop.
  if (stopHit && reached.length > 0) {
    return [
      {
        kind: "hit_stop",
        price: position.currentStop,
        quantity: position.openQuantity,
        reason: stopReasonFor(position),
      },
      {
        kind: "alert",
        reason:
          "الشمعة لمست الوقف والهدف معاً. ترتيبهما داخل الشمعة غير معروف من بيانات OHLC، " +
          "فيُحتسب الوقف — افتراض الترتيب المواتي هو أشهر طرق اختراع ربح غير موجود.",
      },
    ];
  }

  if (stopHit) {
    return [{
      kind: "hit_stop",
      price: position.currentStop,
      quantity: position.openQuantity,
      reason: stopReasonFor(position),
    }];
  }

  // ── 4. targets, in order ─────────────────────────────────────────────────
  for (const target of reached.sort((a, b) => a.index - b.index)) {
    const quantity = position.plannedSize * target.closeFraction;
    actions.push({
      kind: "hit_target",
      target: target.index,
      price: target.price,
      quantity: Math.min(quantity, position.openQuantity),
    });

    // At target 1: move the stop to breakeven. This is what makes the
    // remainder genuinely free — the trade can no longer lose money.
    if (target.index === 1 && !position.stopMovedToBreakeven) {
      actions.push({
        kind: "move_stop",
        to: position.averageEntry || position.plannedEntry.mid,
        reason: "بلوغ الهدف الأول — نُقل الوقف إلى التعادل تلقائياً، فلم يعد المركز قادراً على الخسارة",
      });
    }
  }

  // ── 5. trailing stop, after target 2 ─────────────────────────────────────
  const hitTwo = position.targetsHit.includes(2) || actions.some((a) => a.kind === "hit_target" && a.target === 2);
  if (hitTwo && ctx.atr > 0) {
    const trail = long ? candle.close - ctx.atr * TRAIL_ATR : candle.close + ctx.atr * TRAIL_ATR;
    // A trailing stop only ever moves in the favourable direction. Letting it
    // loosen would be giving back locked-in profit to hold a losing idea.
    const better = long ? trail > position.currentStop : trail < position.currentStop;
    if (better) {
      actions.push({
        kind: "move_stop",
        to: trail,
        reason: `وقف متتبّع بعد الهدف الثاني على بُعد ${TRAIL_ATR} من ATR (${ctx.atr.toFixed(6)})`,
      });
    }
  }

  // ── 6. flows turning against the position: an ALERT, not an exit ─────────
  if (ctx.flowsAgainst) {
    actions.push({
      kind: "alert",
      reason: "انقلبت التدفّقات ضد المركز — تنبيه فقط، ولا خروج ما لم يتحقّق شرط إبطال",
    });
  }

  return actions;
}

function stopReasonFor(position: Position): ExitReason {
  if (position.trailingActive) return "trailing_stop";
  if (position.stopMovedToBreakeven) return "breakeven_stop";
  return "stop_loss";
}

/**
 * Evaluate the machine-checkable invalidation conditions literally.
 *
 * Each condition names a subject, an operator and a value. There is no
 * interpretation here — that is the whole point of having expressed them that
 * way rather than as prose.
 */
function checkInvalidation(
  position: Position,
  ctx: MonitorContext,
  opts: { preEntry: boolean },
): string | null {
  for (const condition of ctx.invalidation) {
    // The stop condition is handled by the stop logic itself, and an expiry
    // condition only applies before entry.
    if (condition.id === "stop_hit" && !opts.preEntry) continue;
    if (condition.id === "expiry" && !opts.preEntry) continue;

    const actual = resolveSubject(condition, position, ctx);
    if (actual === null) continue; // unknown input: never fires on ignorance

    if (compare(actual, condition.operator, condition.value)) {
      return condition.arabic;
    }
  }
  return null;
}

function resolveSubject(
  condition: InvalidationCondition,
  position: Position,
  ctx: MonitorContext,
): number | string | null {
  switch (condition.subject) {
    case "price":
      return ctx.candle.close;
    case "close":
      return ctx.candle.close;
    case "structure_state":
      return ctx.structureState;
    case "stage_score":
      return condition.stage ? (ctx.stageScores[condition.stage] ?? null) : null;
    case "btc_daily_score":
      return ctx.btcDailyScore;
    case "elapsed_bars":
      return position.openedAt === null
        ? ctx.barIndex
        : ctx.barIndex - (position.barsHeld === 0 ? ctx.barIndex : 0);
    case "funding_rate":
      return null; // wired when the flows stage lands
  }
}

function compare(actual: number | string, operator: string, expected: number | string): boolean {
  if (typeof actual === "string" || typeof expected === "string") {
    const a = String(actual);
    const b = String(expected);
    return operator === "eq" ? a === b : operator === "neq" ? a !== b : false;
  }
  switch (operator) {
    case "lt": return actual < expected;
    case "lte": return actual <= expected;
    case "gt": return actual > expected;
    case "gte": return actual >= expected;
    case "eq": return actual === expected;
    case "neq": return actual !== expected;
    default: return false;
  }
}

/**
 * Track the best and worst the trade ever looked, in R.
 *
 * These two numbers say more about a strategy than the final result: a
 * winner that first went 1.5R against you is a different trade from one that
 * never dipped, and a loser that reached 2R before reversing means the exit
 * rules are wrong, not the entry.
 */
export function updateExcursions(
  position: Position,
  candle: Candle,
  riskPerUnit: number,
): { maxFavorableR: number; maxAdverseR: number } {
  if (position.status !== "open" || riskPerUnit <= 0 || position.averageEntry <= 0) {
    return { maxFavorableR: position.maxFavorableR, maxAdverseR: position.maxAdverseR };
  }
  const long = position.direction === "long";
  const bestPrice = long ? candle.high : candle.low;
  const worstPrice = long ? candle.low : candle.high;

  const favorableR = (long ? bestPrice - position.averageEntry : position.averageEntry - bestPrice) / riskPerUnit;
  const adverseR = (long ? worstPrice - position.averageEntry : position.averageEntry - worstPrice) / riskPerUnit;

  return {
    maxFavorableR: Math.max(position.maxFavorableR, favorableR),
    // Adverse excursion is negative; the "worst" is the most negative.
    maxAdverseR: Math.min(position.maxAdverseR, adverseR),
  };
}

export const __testing = { TRAIL_ATR, compare, checkInvalidation };
