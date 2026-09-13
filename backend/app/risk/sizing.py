"""Position sizing and the trade plan.

This module is where Decimal stops being a preference and becomes a
requirement. Everything above computes statistics; everything here computes
money, and a rounding error that is invisible in an RSI is a real loss in a
position size.

The ordering is deliberate and is the single most important rule in the system:

    1. Find where the idea is WRONG.  -> the stop
    2. Decide what being wrong COSTS. -> the risk budget
    3. Derive the SIZE from those two.

Never the other way round. Picking a size first and then hunting for a stop that
justifies it is how accounts are lost, and it is not expressible in this code.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_DOWN, Decimal

# Costs charged against every simulated trade. A backtest that fills at the
# exact signal price flatters any strategy passed through it.
TAKER_FEE_PCT = Decimal("0.04")  # a typical taker fee, each way
SLIPPAGE_PCT = Decimal("0.03")  # assumed adverse fill, each way


@dataclass(frozen=True, slots=True)
class PositionSize:
    quantity: Decimal
    notional: Decimal
    risk_amount: Decimal
    risk_pct_of_balance: Decimal
    stop_distance_pct: Decimal
    # Set when the exposure ceiling reduced the position below the requested
    # risk. This must be surfaced, never swallowed: a trader who asks to risk
    # 1% and silently gets 0.32% is being told something untrue about the
    # system's own risk model, and will size their expectations on it.
    capped: bool = False
    requested_risk_amount: Decimal = Decimal(0)

    @property
    def is_valid(self) -> bool:
        return self.quantity > 0

    @property
    def cap_note(self) -> str | None:
        """Why the position is smaller than requested, in one line."""
        if not self.capped:
            return None
        return (
            f"Stop is {self.stop_distance_pct}% away, so risking the full "
            f"{self.requested_risk_amount} would need more exposure than spot "
            f"sizing allows. Risk reduced to {self.risk_amount}."
        )


def position_size(
    *,
    balance: Decimal,
    risk_pct: Decimal,
    entry: Decimal,
    stop: Decimal,
    max_notional_pct: Decimal = Decimal("100"),
) -> PositionSize:
    """Size a position from what it costs to be wrong.

    quantity = (balance x risk%) / |entry - stop|

    Worked example from the specification:
        balance 10,000, risk 1% = 100, entry 108,500, stop 107,800
        distance = 700  ->  100 / 700 = 0.142857 units
        notional = 0.142857 x 108,500 = 15,500

    Note the notional exceeds the balance: correct for a derivative, impossible
    for spot. `max_notional_pct` caps exposure so a very tight stop cannot
    silently imply leverage this platform does not model.
    """
    if entry <= 0 or balance <= 0 or risk_pct <= 0:
        return _empty(entry, stop)

    distance = abs(entry - stop)
    if distance <= 0:
        # A stop at the entry is not a stop. Sizing it would divide by zero.
        return _empty(entry, stop)

    requested_risk = balance * risk_pct / Decimal(100)
    quantity = requested_risk / distance
    risk_amount = requested_risk
    capped = False

    # Spot sizing: exposure cannot exceed the balance. A very tight stop implies
    # a notional larger than the account, which is leverage this platform does
    # not model and must not quietly assume.
    ceiling = balance * max_notional_pct / Decimal(100)
    if quantity * entry > ceiling:
        quantity = ceiling / entry
        risk_amount = quantity * distance
        capped = True

    quantity = quantity.quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)
    risk_amount = quantity * distance

    return PositionSize(
        quantity=quantity,
        notional=(quantity * entry).quantize(Decimal("0.01")),
        risk_amount=risk_amount.quantize(Decimal("0.01")),
        risk_pct_of_balance=(risk_amount / balance * 100).quantize(Decimal("0.01")),
        stop_distance_pct=(distance / entry * 100).quantize(Decimal("0.01")),
        capped=capped,
        requested_risk_amount=requested_risk.quantize(Decimal("0.01")),
    )


def _empty(entry: Decimal, stop: Decimal) -> PositionSize:
    return PositionSize(
        quantity=Decimal(0),
        notional=Decimal(0),
        risk_amount=Decimal(0),
        risk_pct_of_balance=Decimal(0),
        stop_distance_pct=(abs(entry - stop) / entry * 100 if entry > 0 else Decimal(0)).quantize(
            Decimal("0.01")
        ),
    )


def format_price(value: Decimal) -> str:
    """A price a human can read.

    Decimal keeps every digit of the arithmetic that produced a value, which is
    exactly right for storage and wrong for a sentence: an invalidation level
    printed as 114177.74098213758276 is not more precise to the reader, it is
    unreadable.
    """
    magnitude = abs(value)
    places = 2 if magnitude >= 1000 else 4 if magnitude >= 1 else 8
    return f"{value.quantize(Decimal(1).scaleb(-places)):f}"


@dataclass(frozen=True, slots=True)
class Target:
    price: Decimal
    r_multiple: Decimal
    allocation_pct: int


@dataclass(frozen=True, slots=True)
class TradePlan:
    direction: str  # "LONG" | "SHORT"
    entry: Decimal
    stop: Decimal
    targets: tuple[Target, ...]
    reward_risk: Decimal
    size: PositionSize
    invalidation: str

    @property
    def take_profit(self) -> Decimal:
        """The final target, for callers that want a single number."""
        return self.targets[-1].price if self.targets else self.entry

    @property
    def realistic_loss(self) -> Decimal:
        """What being wrong actually costs.

        The planned loss is the floor, not the figure. Fees are charged on the
        way in and the way out, and the fill is assumed to be adverse at both
        ends. Reporting only the planned loss understates every trade by a
        consistent margin, which compounds into a materially wrong drawdown.
        """
        planned = self.size.quantity * abs(self.entry - self.stop)
        fees = self.size.notional * TAKER_FEE_PCT / 100 * 2
        slippage = self.size.notional * SLIPPAGE_PCT / 100 * 2
        return (planned + fees + slippage).quantize(Decimal("0.01"))


def build_plan(
    *,
    direction: str,
    entry: Decimal,
    stop: Decimal,
    balance: Decimal,
    risk_pct: Decimal,
    atr: Decimal | None = None,
    resistance: Decimal | None = None,
    support: Decimal | None = None,
) -> TradePlan | None:
    """Build a staged exit plan around an entry and its invalidation.

    Targets are taken in three parts rather than one. A single exit is a bet
    that the move ends exactly where it was predicted to; staging takes money
    off the table while leaving something on for the case where it keeps going.
    """
    if entry <= 0:
        return None

    is_long = direction == "LONG"
    # Quantised once, here, so the stop stored on the plan and the stop shown in
    # the invalidation sentence are the same number.
    stop = stop.quantize(Decimal("0.00000001"))
    distance = abs(entry - stop)
    if distance <= 0:
        return None

    # Targets at 1R, 2R and 3R, adjusted toward a real level when one is in the
    # way — a target beyond known resistance is a target that will not be hit.
    multiples = (Decimal("1"), Decimal("2"), Decimal("3"))
    allocations = (50, 30, 20)

    targets: list[Target] = []
    for multiple, allocation in zip(multiples, allocations, strict=True):
        price = entry + distance * multiple if is_long else entry - distance * multiple
        barrier = resistance if is_long else support

        if barrier is not None:
            blocks = (is_long and entry < barrier < price) or (
                not is_long and price < barrier < entry
            )
            # A level closer than half the stop distance sits INSIDE the noise
            # the stop is sized to survive, so it cannot meaningfully cap the
            # trade. Clamping to it anyway dragged all three targets onto a
            # trivial obstacle and collapsed reward-to-risk to ~0.05, which then
            # failed the 1.5 floor and silently killed the setup.
            meaningful = abs(barrier - entry) >= distance * Decimal("0.5")
            if blocks and meaningful:
                price = barrier

        targets.append(
            Target(
                price=price.quantize(Decimal("0.00000001")),
                r_multiple=multiple,
                allocation_pct=allocation,
            )
        )

    final = targets[-1].price
    reward = abs(final - entry)
    reward_risk = (reward / distance).quantize(Decimal("0.01"))

    size = position_size(balance=balance, risk_pct=risk_pct, entry=entry, stop=stop)

    return TradePlan(
        direction=direction,
        entry=entry,
        stop=stop,
        targets=tuple(targets),
        reward_risk=reward_risk,
        size=size,
        invalidation=(
            f"Close beyond {format_price(stop)} invalidates the idea"
            if atr is None or atr <= 0
            else (
                f"Close beyond {format_price(stop)} "
                f"(approximately {(distance / atr):.1f} ATR) invalidates the idea"
            )
        ),
    )
