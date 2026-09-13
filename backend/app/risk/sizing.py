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

    def to_dict(self) -> dict[str, object]:
        return {
            "quantity": format_quantity(self.quantity),
            "notional": str(self.notional),
            "risk_amount": str(self.risk_amount),
            "risk_pct_of_balance": str(self.risk_pct_of_balance),
            "stop_distance_pct": str(self.stop_distance_pct),
            "capped": self.capped,
            "cap_note": self.cap_note,
        }

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


def format_quantity(value: Decimal) -> str:
    """A size a human can act on.

    Sizing quantises to eight places because a satoshi-scale asset needs them,
    which leaves a four-unit position reading "4.00000000". Trailing zeros are
    dropped so the number carries only the precision it actually has.
    """
    text = f"{value.quantize(Decimal('0.00000001')):f}"
    return text.rstrip("0").rstrip(".") if "." in text else text


@dataclass(frozen=True, slots=True)
class Target:
    price: Decimal
    r_multiple: Decimal
    allocation_pct: int

    def to_dict(self) -> dict[str, object]:
        return {
            "price": str(self.price),
            "price_display": format_price(self.price),
            "r_multiple": str(self.r_multiple),
            "allocation_pct": self.allocation_pct,
        }


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

    def ladder(self) -> list[dict[str, object]]:
        """The staged exit, priced.

        A target expressed only as a price and an R-multiple is a number the
        reader has to convert before it means anything. What a trader actually
        wants to know at each rung is: how much of the position leaves here,
        what does that slice pay, and what is banked by the time it fills.

        The slice profit is the allocated FRACTION of the position, not the
        whole of it — the commonest way a staged plan is read wrong is to price
        every target as though the full size exited there, which triples the
        apparent reward of a 50/30/20 ladder.
        """
        quantity = self.size.quantity
        rows: list[dict[str, object]] = []
        banked = Decimal(0)

        for target in self.targets:
            slice_qty = quantity * Decimal(target.allocation_pct) / 100
            profit = (slice_qty * abs(target.price - self.entry)).quantize(Decimal("0.01"))
            banked += profit
            row = target.to_dict()
            row["quantity"] = format_quantity(slice_qty)
            row["profit"] = str(profit)
            row["banked"] = str(banked)
            row["distance_pct"] = str(
                (abs(target.price - self.entry) / self.entry * 100).quantize(Decimal("0.01"))
                if self.entry > 0
                else Decimal(0)
            )
            rows.append(row)

        return rows

    @property
    def blended_reward_risk(self) -> Decimal:
        """What the ladder actually pays, weighted by what exits where.

        `reward_risk` is the distance to the FINAL target over the stop
        distance — the reward of holding the whole position to the end. This
        plan does not do that: it sells half at 1R and another three tenths at
        2R, so only a fifth of the position ever sees the final target.

        For the standard 50/30/20 ladder at 1R/2R/3R that is 1.7R against a
        headline of 3.0R. Both numbers are true about different things, and
        showing only the larger one describes a trade the plan will not take.
        It moves below 1.7 whenever a target was clamped to a real level, which
        is exactly when the reader most needs to see it.
        """
        distance = abs(self.entry - self.stop)
        if distance <= 0:
            return Decimal(0)
        total = sum(
            (abs(t.price - self.entry) / distance) * Decimal(t.allocation_pct) / 100
            for t in self.targets
        )
        return Decimal(total).quantize(Decimal("0.01"))

    def to_dict(self) -> dict[str, object]:
        """The plan as money, for a screen that has to show it.

        `realistic_loss` rather than the planned loss is the number beside the
        reward here, and the two are deliberately not symmetrical: the loss
        carries fees and adverse fills on both legs, the ladder's profits do
        not. Costs on the way out are real but they are charged per slice at
        prices not yet known, and inventing them would be worse than naming
        the asymmetry.
        """
        ladder = self.ladder()
        return {
            "direction": self.direction,
            "entry": str(self.entry),
            "entry_display": format_price(self.entry),
            "stop": str(self.stop),
            "stop_display": format_price(self.stop),
            "reward_risk": str(self.reward_risk),
            "blended_reward_risk": str(self.blended_reward_risk),
            "invalidation": self.invalidation,
            "size": self.size.to_dict(),
            "targets": ladder,
            "max_profit": ladder[-1]["banked"] if ladder else "0",
            "planned_loss": str(self.size.risk_amount),
            "realistic_loss": str(self.realistic_loss),
            "cost_note": (
                "The loss includes taker fees and adverse fills on both legs. "
                "The target profits do not: exit costs land at prices that are "
                "not known yet."
            ),
        }


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
