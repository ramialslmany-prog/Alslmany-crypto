"""The execution boundary.

`Broker` is a port with exactly one implementation: `PaperBroker`, which moves
numbers in memory. There is no second implementation, no adapter for an
exchange, and no code path from here to a venue.

The port exists so that adding real execution later would be a deliberate,
reviewable act — a new class, a new configuration switch, a new set of tests —
rather than something that could arrive by accident through a refactor. Today,
`place` cannot reach the internet: it has no HTTP client and no credentials.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Protocol

from app.risk.sizing import SLIPPAGE_PCT, TAKER_FEE_PCT


@dataclass(frozen=True, slots=True)
class Fill:
    """A simulated execution.

    `requested` and `price` differ by the assumed slippage. Keeping both means
    the simulation's optimism is measurable rather than assumed away.
    """

    symbol: str
    side: str  # "buy" | "sell"
    quantity: Decimal
    requested: Decimal
    price: Decimal
    fee: Decimal
    at: datetime
    simulated: bool = True  # always true; there is no other kind here

    @property
    def slippage(self) -> Decimal:
        return abs(self.price - self.requested)

    @property
    def notional(self) -> Decimal:
        return self.quantity * self.price


class Broker(Protocol):
    async def place(self, *, symbol: str, side: str, quantity: Decimal, price: Decimal) -> Fill: ...


class PaperBroker:
    """Simulated execution, with costs charged against us.

    Slippage is always adverse — worse fills on entry, worse on exit. A
    simulation that fills at the requested price makes every strategy look
    better than it is, and the error is systematic rather than random, so it
    never averages out over more trades.
    """

    def __init__(
        self,
        *,
        fee_pct: Decimal = TAKER_FEE_PCT,
        slippage_pct: Decimal = SLIPPAGE_PCT,
    ) -> None:
        self.fee_pct = fee_pct
        self.slippage_pct = slippage_pct
        self.fills: list[Fill] = []

    async def place(self, *, symbol: str, side: str, quantity: Decimal, price: Decimal) -> Fill:
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        if price <= 0:
            raise ValueError("price must be positive")

        drift = price * self.slippage_pct / Decimal(100)
        # Buying fills higher than asked; selling fills lower. Never the reverse.
        filled = price + drift if side == "buy" else price - drift
        fee = (quantity * filled) * self.fee_pct / Decimal(100)

        fill = Fill(
            symbol=symbol,
            side=side,
            quantity=quantity,
            requested=price,
            price=filled.quantize(Decimal("0.00000001")),
            fee=fee.quantize(Decimal("0.00000001")),
            at=datetime.now(UTC),
        )
        self.fills.append(fill)
        return fill
