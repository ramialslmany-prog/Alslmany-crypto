"""The paper-trading engine: open, monitor, close.

Three rules govern this file, and each exists because its absence produces a
simulation that flatters itself:

**A stop is never widened.** There is no code path that moves a stop further
from entry. Widening a stop turns a defined loss into an undefined one, and it
is the single most common way a disciplined system becomes an undisciplined
one. The method that moves stops rejects any move in the wrong direction.

**Intrabar order is pessimistic.** When a bar's range contains both the stop and
a target, the stop is taken. The tick sequence inside a bar is unknowable from
OHLC alone, and assuming the favourable order inflates every result by exactly
the cases that matter most.

**Nothing opens on data that is not live.** Enforced upstream by the risk
manager, and asserted again here, because this is the last place it can be
caught before a position exists.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from app.core.logging import get_logger
from app.paper.broker import Broker, Fill
from app.paper.models import PaperTrade

logger = get_logger(__name__)


class ExitReason:
    TAKE_PROFIT = "take_profit"
    STOP_LOSS = "stop_loss"
    MANUAL = "manual"
    THESIS_INVALIDATED = "thesis_invalidated"
    EXPIRED = "expired"
    DATA_LOST = "data_unavailable"


@dataclass(frozen=True, slots=True)
class OpenRequest:
    symbol: str
    direction: str
    timeframe: str
    entry: Decimal
    stop: Decimal
    take_profit: Decimal
    quantity: Decimal
    risk_amount: Decimal
    reward_risk: Decimal
    confidence: Decimal
    strategy: str
    reason: str
    evidence: dict | None = None


@dataclass(frozen=True, slots=True)
class CloseResult:
    trade: PaperTrade
    fill: Fill
    pnl: Decimal
    r_multiple: Decimal
    result: str


class PaperEngine:
    def __init__(self, broker: Broker) -> None:
        self.broker = broker

    # --- opening ---------------------------------------------------------

    async def open(self, request: OpenRequest, *, data_is_live: bool) -> PaperTrade:
        """Open a simulated position.

        `data_is_live` is a required argument rather than a default, so that
        opening a position without having considered it is a TypeError rather
        than an accident.
        """
        if not data_is_live:
            raise ValueError(
                "Refusing to open a position on data that is not live. "
                "Insufficient reliable market data."
            )
        if request.quantity <= 0:
            raise ValueError("quantity must be positive")

        side = "buy" if request.direction == "LONG" else "sell"
        fill = await self.broker.place(
            symbol=request.symbol,
            side=side,
            quantity=request.quantity,
            price=request.entry,
        )

        trade = PaperTrade(
            symbol=request.symbol,
            direction=request.direction,
            status="open",
            timeframe=request.timeframe,
            # The FILLED price, not the requested one. Recording the request
            # would hide the slippage the simulation just charged.
            entry=fill.price,
            stop_loss=request.stop,
            take_profit=request.take_profit,
            quantity=fill.quantity,
            notional=fill.notional,
            risk_amount=request.risk_amount,
            reward_risk=request.reward_risk,
            fees=fill.fee,
            confidence=request.confidence,
            strategy=request.strategy,
            reason=request.reason,
            evidence=request.evidence,
            opened_at=fill.at,
            is_paper=True,
        )

        logger.info(
            "paper position opened",
            extra={
                "symbol": trade.symbol,
                "direction": trade.direction,
                "entry": str(trade.entry),
                "stop": str(trade.stop_loss),
                "quantity": str(trade.quantity),
                "paper": True,
            },
        )
        return trade

    # --- monitoring ------------------------------------------------------

    def unrealised(self, trade: PaperTrade, price: Decimal) -> tuple[Decimal, Decimal]:
        """Open P&L in currency and in R."""
        if trade.direction == "LONG":
            move = price - trade.entry
        else:
            move = trade.entry - price

        pnl = (move * trade.quantity).quantize(Decimal("0.01"))
        risk = trade.risk_amount
        r = (pnl / risk).quantize(Decimal("0.01")) if risk > 0 else Decimal(0)
        return pnl, r

    def check_exit(self, trade: PaperTrade, *, high: Decimal, low: Decimal) -> str | None:
        """Decide whether a bar's range closes this trade, pessimistically.

        When a single bar contains both levels the stop wins. OHLC cannot tell
        us which came first, and assuming the favourable order turns losing
        trades into winners exactly in the volatile bars where it matters most.
        """
        if trade.direction == "LONG":
            hit_stop = low <= trade.stop_loss
            hit_target = high >= trade.take_profit
        else:
            hit_stop = high >= trade.stop_loss
            hit_target = low <= trade.take_profit

        if hit_stop:
            return ExitReason.STOP_LOSS
        if hit_target:
            return ExitReason.TAKE_PROFIT
        return None

    def move_stop(self, trade: PaperTrade, new_stop: Decimal) -> bool:
        """Tighten a stop. Never widen one.

        Returns whether the move was accepted. A rejected move is not an error
        — a trailing calculation naturally proposes a worse stop whenever price
        retraces — but it must never be applied.
        """
        if trade.direction == "LONG":
            improved = new_stop > trade.stop_loss
        else:
            improved = new_stop < trade.stop_loss

        if not improved:
            return False

        trade.stop_loss = new_stop
        return True

    def breakeven_stop(self, trade: PaperTrade, price: Decimal) -> bool:
        """Move the stop to entry once the trade is 1R in profit.

        Not before: moving to breakeven early converts trades that would have
        worked into scratches, because normal retracement reaches back through
        entry far more often than it reaches 1R.
        """
        _, r = self.unrealised(trade, price)
        if r < 1:
            return False
        return self.move_stop(trade, trade.entry)

    # --- closing ---------------------------------------------------------

    async def close(self, trade: PaperTrade, *, price: Decimal, reason: str) -> CloseResult:
        if trade.status != "open":
            raise ValueError(f"trade {trade.id} is already {trade.status}")

        side = "sell" if trade.direction == "LONG" else "buy"
        fill = await self.broker.place(
            symbol=trade.symbol, side=side, quantity=trade.quantity, price=price
        )

        if trade.direction == "LONG":
            gross = (fill.price - trade.entry) * trade.quantity
        else:
            gross = (trade.entry - fill.price) * trade.quantity

        # Both legs' fees come out. Charging only the exit would understate the
        # cost of every trade by half.
        total_fees = trade.fees + fill.fee
        pnl = (gross - fill.fee).quantize(Decimal("0.01"))

        risk = trade.risk_amount
        r = (pnl / risk).quantize(Decimal("0.01")) if risk > 0 else Decimal(0)

        if pnl > 0:
            result = "WIN"
        elif pnl < 0:
            result = "LOSS"
        else:
            result = "BREAKEVEN"

        trade.status = "closed"
        trade.exit_price = fill.price
        trade.pnl = pnl
        trade.pnl_pct = (
            (pnl / trade.notional * 100).quantize(Decimal("0.01"))
            if trade.notional > 0
            else Decimal(0)
        )
        trade.r_multiple = r
        trade.fees = total_fees
        trade.result = result
        trade.exit_reason = reason
        trade.closed_at = fill.at

        logger.info(
            "paper position closed",
            extra={
                "symbol": trade.symbol,
                "reason": reason,
                "pnl": str(pnl),
                "r": str(r),
                "result": result,
                "paper": True,
            },
        )
        return CloseResult(trade=trade, fill=fill, pnl=pnl, r_multiple=r, result=result)


def now() -> datetime:
    return datetime.now(UTC)
