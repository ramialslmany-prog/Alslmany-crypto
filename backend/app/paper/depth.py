"""What an order of a given size would actually cost, read from the book.

Until now slippage was a flat 0.03% whatever the trade. That constant is wrong
in both directions and wrong by more the further you get from a typical order:
a small trade in BTC pays less, and a large one in a thin altcoin pays very
much more. A simulation using one number for both reports a strategy that
scales perfectly, which is the single most expensive illusion in backtesting —
the strategy looks identical at $1,000 and $1,000,000, and only one of those is
true.

The cost of crossing is two separate things, and they are kept separate here
because they behave differently:

**The spread.** Paid by every order, however small — you buy at the ask and
sell at the bid. Half the spread is the cost of immediacy.

**Impact.** Paid only by orders large enough to eat past the best quote. This
is the part that scales with size, and the part a flat percentage cannot model
at all.

The total is their sum, applied adversely. And when the book cannot cover the
order, the answer is not a price: it is `exhausted`, and the caller is expected
to treat that as "this size does not trade here" rather than filling at a
number the market never offered.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from app.market_data.schemas import OrderBook


@dataclass(frozen=True, slots=True)
class DepthCost:
    """The cost of crossing, split into the parts that behave differently."""

    # Half the bid-ask spread, as a percentage of the mid. Paid by any size.
    spread_pct: Decimal
    # The extra paid for eating past the best quote. Scales with size.
    impact_pct: Decimal
    levels_consumed: int
    # True when the visible book could not cover the order. The percentages
    # then describe what WAS available, which is strictly better than reality.
    exhausted: bool
    # How much of the order the book could actually fill, 0-1.
    filled_fraction: Decimal

    @property
    def total_pct(self) -> Decimal:
        return (self.spread_pct + self.impact_pct).quantize(Decimal("0.0001"))

    def to_dict(self) -> dict[str, object]:
        return {
            "spread_pct": str(self.spread_pct),
            "impact_pct": str(self.impact_pct),
            "total_pct": str(self.total_pct),
            "levels_consumed": self.levels_consumed,
            "exhausted": self.exhausted,
            "filled_fraction": str(self.filled_fraction),
        }


def cost_to_cross(book: OrderBook, side: str, quantity: Decimal) -> DepthCost | None:
    """Walk the book for `quantity` and report what it costs.

    Returns `None` when the side needed is empty — an absent book is a missing
    measurement, and the caller has to decide what to assume rather than being
    handed a zero that reads as "free".
    """
    if quantity <= 0:
        return None

    levels = book.asks if side == "buy" else book.bids
    if not levels:
        return None

    best = levels[0].price
    if best <= 0:
        return None

    mid = _mid(book) or best

    remaining = quantity
    cost = Decimal(0)
    consumed = 0

    for level in levels:
        if remaining <= 0:
            break
        take = min(remaining, level.quantity)
        if take <= 0:
            continue
        cost += take * level.price
        remaining -= take
        consumed += 1

    filled = quantity - remaining
    if filled <= 0:
        return None

    average = cost / filled

    # Impact is measured against the best quote, not the mid: crossing the
    # spread is charged separately below, and adding it here would bill the
    # trade for it twice.
    impact = abs(average - best) / best * 100

    half_spread = Decimal(0)
    if book.best_bid is not None and book.best_ask is not None and mid > 0:
        half_spread = (book.best_ask - book.best_bid) / 2 / mid * 100

    return DepthCost(
        spread_pct=half_spread.quantize(Decimal("0.0001")),
        impact_pct=impact.quantize(Decimal("0.0001")),
        levels_consumed=consumed,
        exhausted=remaining > 0,
        filled_fraction=(filled / quantity).quantize(Decimal("0.0001")),
    )


def _mid(book: OrderBook) -> Decimal | None:
    if book.best_bid is None or book.best_ask is None:
        return None
    return (book.best_bid + book.best_ask) / 2
