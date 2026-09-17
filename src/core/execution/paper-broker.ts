/**
 * The paper broker.
 *
 * Applies the monitor's decisions, accounting for real fees and modelled
 * slippage. Pure: state in, new state and events out. The broker never
 * decides anything — it only executes what the monitor decided on the
 * previous closed candle, at the CURRENT candle's open.
 *
 * That separation is what makes the backtest and the live worker the same
 * code. If the broker could also decide, the live path would inevitably grow
 * a shortcut the backtest does not have.
 */
import { DEFAULT_COSTS, fillFromBook, fillFromLiquidity, type CostModel, type FillEstimate } from "@/core/execution/fills";
import { updateExcursions } from "@/core/execution/monitor";
import type {
  ExitReason, Fill, Position, PositionAction, PositionStatus,
} from "@/core/execution/types";
import { EXIT_REASON_AR } from "@/core/execution/types";
import type { RecommendationEvent, RecommendationEventKind } from "@/core/recommendation/types";
import type { Candle, OrderBook } from "@/core/types";

export interface ExecutionContext {
  /** The candle the fills happen on — actions were decided on the PREVIOUS one. */
  readonly candle: Candle;
  /** Book snapshot, when available. Absent in a candle-only backtest. */
  readonly orderBook: OrderBook | null;
  readonly costs: CostModel;
  readonly now: number;
}

export interface ExecutionResult {
  readonly position: Position;
  readonly events: readonly Omit<RecommendationEvent, "id">[];
  readonly realizedDelta: number;
}

/**
 * Apply actions to a position.
 *
 * ENTRY AND EXIT BOTH EXECUTE AT THE CANDLE'S OPEN. The monitor observed a
 * closed candle; this is the next one. Filling at the trigger price instead
 * would assume we could act inside a bar we had not seen yet.
 *
 * The exception is a stop: we fill at the stop price when the bar opened
 * beyond it in our favour, but at the OPEN when the bar gapped through it —
 * because a gap means the stop price was never available.
 */
export function applyActions(
  position: Position,
  actions: readonly PositionAction[],
  ctx: ExecutionContext,
): ExecutionResult {
  let next = position;
  const events: Omit<RecommendationEvent, "id">[] = [];
  let realizedDelta = 0;

  for (const action of actions) {
    switch (action.kind) {
      case "fill_entry": {
        const side = position.direction === "long" ? "buy" : "sell";
        // Execution price is this bar's OPEN, not the zone price.
        const reference = ctx.candle.open;
        const estimate = estimate_(ctx, side, action.quantity, reference);
        const fill = toFill(estimate, ctx, side, action.quantity, reference, action.reason);

        next = {
          ...next,
          status: "open" as PositionStatus,
          openedAt: ctx.now,
          fills: [...next.fills, fill],
          openQuantity: action.quantity,
          averageEntry: fill.price,
          // The ENTRY fee belongs in the position's own P&L, not only in the
          // account's equity. It used to be charged to equity alone, which
          // left every reported trade result — and therefore every backtest
          // statistic built on it — better than the account actually was, by
          // exactly one fee per trade.
          realizedPnl: next.realizedPnl - fill.fee,
        };
        realizedDelta -= fill.fee;

        events.push({
          recommendationId: position.recommendationId,
          kind: "entry_filled" as RecommendationEventKind,
          at: ctx.now,
          candleTime: ctx.candle.openTime,
          price: fill.price,
          payload: {
            quantity: action.quantity, referencePrice: reference,
            slippageBps: fill.slippageBps, fee: fill.fee, basis: estimate.basis,
          },
          arabic:
            `نُفّذ الدخول على فتح الشمعة التالية عند ${fill.price.toFixed(6)} ` +
            `(المرجع ${reference.toFixed(6)}، انزلاق ${fill.slippageBps.toFixed(1)} نقطة أساس، ` +
            `رسوم ${fill.fee.toFixed(4)}). ${estimate.basis}.`,
        });
        break;
      }

      case "hit_target": {
        const side = position.direction === "long" ? "sell" : "buy";
        const quantity = Math.min(action.quantity, next.openQuantity);
        if (quantity <= 0) break;
        // A target is a limit order resting at the level, so it fills there —
        // unless the bar opened beyond it, in which case we got the open.
        const gappedPast = position.direction === "long"
          ? ctx.candle.open > action.price
          : ctx.candle.open < action.price;
        const reference = gappedPast ? ctx.candle.open : action.price;

        const estimate = estimate_(ctx, side, quantity, reference);
        const fill = toFill(estimate, ctx, side, quantity, reference, `الهدف ${action.target}`);
        const pnl = pnlOf(next, fill, quantity);

        realizedDelta += pnl - fill.fee;
        next = {
          ...next,
          fills: [...next.fills, fill],
          openQuantity: next.openQuantity - quantity,
          targetsHit: [...next.targetsHit, action.target],
          realizedPnl: next.realizedPnl + pnl - fill.fee,
        };

        events.push({
          recommendationId: position.recommendationId,
          kind: "target_hit" as RecommendationEventKind,
          at: ctx.now,
          candleTime: ctx.candle.openTime,
          price: fill.price,
          payload: { target: action.target, quantity, pnl, fee: fill.fee, gappedPast },
          arabic:
            `بلغ الهدف ${action.target} عند ${fill.price.toFixed(6)} — ` +
            `خروج جزئي بـ${quantity.toFixed(6)} وحدة بربح ${pnl.toFixed(4)}` +
            (gappedPast ? " (فتحت الشمعة متجاوزة الهدف، فالتنفيذ على الفتح)" : "") + ".",
        });
        break;
      }

      case "hit_stop": {
        const side = position.direction === "long" ? "sell" : "buy";
        const quantity = Math.min(action.quantity, next.openQuantity);
        if (quantity <= 0) break;

        // A gap through the stop means the stop price never traded. Filling
        // there anyway is how a backtest hides its worst days.
        const gapped = position.direction === "long"
          ? ctx.candle.open < next.currentStop
          : ctx.candle.open > next.currentStop;
        const reference = action.reason === "invalidated"
          ? ctx.candle.open
          : gapped ? ctx.candle.open : next.currentStop;

        const estimate = estimate_(ctx, side, quantity, reference);
        const fill = toFill(estimate, ctx, side, quantity, reference, EXIT_REASON_AR[action.reason]);
        const pnl = pnlOf(next, fill, quantity);

        realizedDelta += pnl - fill.fee;
        next = {
          ...next,
          fills: [...next.fills, fill],
          openQuantity: 0,
          realizedPnl: next.realizedPnl + pnl - fill.fee,
          status: "closed" as PositionStatus,
          closedAt: ctx.now,
          exitReason: action.reason,
        };

        events.push({
          recommendationId: position.recommendationId,
          kind: (action.reason === "invalidated" ? "invalidated" : "stop_hit") as RecommendationEventKind,
          at: ctx.now,
          candleTime: ctx.candle.openTime,
          price: fill.price,
          payload: { reason: action.reason, quantity, pnl, fee: fill.fee, gapped },
          arabic:
            `أُغلق المركز — ${EXIT_REASON_AR[action.reason]} عند ${fill.price.toFixed(6)} ` +
            `بنتيجة ${pnl.toFixed(4)}` +
            (gapped ? ". فتحت الشمعة متجاوزة الوقف، فسعر الوقف لم يُتداول أصلاً والتنفيذ على الفتح" : "") + ".",
        });
        break;
      }

      case "move_stop": {
        const isBreakeven = !next.stopMovedToBreakeven && action.reason.includes("التعادل");
        next = {
          ...next,
          currentStop: action.to,
          stopMovedToBreakeven: next.stopMovedToBreakeven || isBreakeven,
          trailingActive: next.trailingActive || action.reason.includes("متتبّع"),
        };
        events.push({
          recommendationId: position.recommendationId,
          kind: "stop_moved" as RecommendationEventKind,
          at: ctx.now,
          candleTime: ctx.candle.openTime,
          price: action.to,
          payload: { to: action.to, breakeven: isBreakeven },
          arabic: `نُقل الوقف إلى ${action.to.toFixed(6)} — ${action.reason}.`,
        });
        break;
      }

      case "invalidate": {
        next = { ...next, status: "invalidated" as PositionStatus, closedAt: ctx.now, exitReason: "invalidated" };
        events.push({
          recommendationId: position.recommendationId,
          kind: "invalidated" as RecommendationEventKind,
          at: ctx.now, candleTime: ctx.candle.openTime, price: ctx.candle.close,
          payload: { reason: action.reason },
          arabic: `أُلغيت التوصية قبل التنفيذ: ${action.reason}.`,
        });
        break;
      }

      case "expire": {
        next = { ...next, status: "expired" as PositionStatus, closedAt: ctx.now, exitReason: "time_exit" };
        events.push({
          recommendationId: position.recommendationId,
          kind: "expired" as RecommendationEventKind,
          at: ctx.now, candleTime: ctx.candle.openTime, price: ctx.candle.close,
          payload: { reason: action.reason },
          arabic: `انتهت صلاحية التوصية: ${action.reason}.`,
        });
        break;
      }

      case "alert": {
        next = { ...next, notes: [...next.notes, action.reason] };
        events.push({
          recommendationId: position.recommendationId,
          kind: "note" as RecommendationEventKind,
          at: ctx.now, candleTime: ctx.candle.openTime, price: ctx.candle.close,
          payload: {},
          arabic: action.reason,
        });
        break;
      }
    }
  }

  // Track how good and how bad it ever looked.
  const riskPerUnit = Math.abs(position.plannedEntry.mid - position.plannedStop);
  const excursions = updateExcursions(next, ctx.candle, riskPerUnit);
  next = { ...next, ...excursions };

  // Once closed, express the result in R — the only unit comparable across
  // symbols, sizes and time.
  if (next.status === "closed" && next.realizedR === 0 && next.plannedRisk > 0) {
    next = { ...next, realizedR: next.realizedPnl / next.plannedRisk };
  }

  return { position: next, events, realizedDelta };
}

function estimate_(
  ctx: ExecutionContext,
  side: "buy" | "sell",
  quantity: number,
  reference: number,
): FillEstimate {
  if (ctx.orderBook && ctx.orderBook.bids.length > 0 && ctx.orderBook.asks.length > 0) {
    return fillFromBook(ctx.orderBook, side, quantity, ctx.costs);
  }
  return fillFromLiquidity(ctx.candle, side, quantity, reference, ctx.costs);
}

function toFill(
  estimate: FillEstimate,
  ctx: ExecutionContext,
  side: "buy" | "sell",
  quantity: number,
  reference: number,
  reason: string,
): Fill {
  return {
    at: ctx.now,
    candleTime: ctx.candle.openTime,
    side,
    quantity,
    referencePrice: reference,
    price: estimate.price,
    slippage: estimate.slippage,
    slippageBps: estimate.slippageBps,
    fee: estimate.fee,
    feeBps: estimate.feeBps,
    notional: estimate.price * quantity,
    reason,
  };
}

/** Gross P&L on a closing fill, before its own fee. */
function pnlOf(position: Position, fill: Fill, quantity: number): number {
  const entry = position.averageEntry;
  if (!(entry > 0)) return 0;
  return position.direction === "long"
    ? (fill.price - entry) * quantity
    : (entry - fill.price) * quantity;
}

/** Create the pending position a recommendation implies. */
export function openPending(x: {
  id: string;
  recommendationId: string;
  symbol: string;
  direction: Position["direction"];
  timeframe: Position["timeframe"];
  entry: Position["plannedEntry"];
  stop: number;
  targets: Position["plannedTargets"];
  size: number;
  risk: number;
  expiresAt: number;
}): Position {
  return {
    id: x.id,
    recommendationId: x.recommendationId,
    symbol: x.symbol,
    direction: x.direction,
    timeframe: x.timeframe,
    status: "pending",
    plannedEntry: x.entry,
    plannedStop: x.stop,
    plannedTargets: x.targets,
    plannedSize: x.size,
    plannedRisk: x.risk,
    currentStop: x.stop,
    stopMovedToBreakeven: false,
    trailingActive: false,
    fills: [],
    openQuantity: 0,
    averageEntry: 0,
    targetsHit: [],
    openedAt: null,
    closedAt: null,
    exitReason: null,
    realizedPnl: 0,
    realizedR: 0,
    maxFavorableR: 0,
    maxAdverseR: 0,
    barsHeld: 0,
    expiresAt: x.expiresAt,
    notes: [],
  };
}

/** The close record the spec asks for, in Arabic. */
export function closeSummary(position: Position): string {
  if (position.status !== "closed" && position.status !== "expired" && position.status !== "invalidated") {
    return "المركز ما زال مفتوحاً.";
  }
  const reason = position.exitReason ? EXIT_REASON_AR[position.exitReason] : "غير محدّد";
  const totalFees = position.fills.reduce((s, f) => s + f.fee, 0);
  const totalSlippage = position.fills.reduce((s, f) => s + Math.abs(f.slippage) * f.quantity, 0);

  return [
    `سبب الخروج: ${reason}.`,
    `النتيجة ${position.realizedR.toFixed(2)}R (${position.realizedPnl.toFixed(4)} صافي بعد الرسوم والانزلاق).`,
    `أقصى ربح عائم ${position.maxFavorableR.toFixed(2)}R، وأقصى خسارة عائمة ${position.maxAdverseR.toFixed(2)}R.`,
    `مدة الاحتفاظ ${position.barsHeld} شمعة.`,
    `إجمالي الرسوم ${totalFees.toFixed(4)} والانزلاق ${totalSlippage.toFixed(4)}.`,
    position.maxFavorableR > 1.5 && position.realizedR < 0
      ? "ملاحظة: بلغ المركز ربحاً عائماً معتبراً ثم أُغلق خاسراً — الخلل في قواعد الخروج لا في الدخول."
      : "",
  ].filter(Boolean).join(" ");
}
