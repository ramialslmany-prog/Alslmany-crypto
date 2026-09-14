"""The no-look-ahead guarantee, enforced by construction.

A backtester that can see the future is not optimistic, it is fiction — and the
mistake is almost never deliberate. It arrives as an indicator computed over the
whole series and then indexed at bar `i`, or a stop checked against a bar that
has not happened yet. Both look correct in review.

So the guarantee is structural here rather than a matter of discipline: the
replay hands the strategy a `Window`, and a Window physically cannot contain a
bar after its cursor. There is no argument that widens it and no method that
reaches past it. Getting this wrong the other way — being too strict — costs
nothing; getting it wrong this way invalidates every number the backtest
produces.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.analysis.series import Series
from app.market_data.schemas import Candle


@dataclass(frozen=True, slots=True)
class Window:
    """Bars 0..cursor inclusive. Nothing after the cursor exists."""

    candles: tuple[Candle, ...]
    cursor: int

    def __post_init__(self) -> None:
        if not 0 <= self.cursor < len(self.candles):
            raise IndexError(
                f"cursor {self.cursor} is outside a series of {len(self.candles)} bars"
            )

    @property
    def visible(self) -> tuple[Candle, ...]:
        return self.candles[: self.cursor + 1]

    @property
    def current(self) -> Candle:
        """The bar the strategy is deciding ON, not the one it will act in."""
        return self.candles[self.cursor]

    @property
    def next_bar(self) -> Candle | None:
        """The bar a decision made now would actually fill in.

        Deliberately NOT part of `visible`. The strategy never sees it; only
        the execution step does, and only after the decision is made.
        """
        nxt = self.cursor + 1
        return self.candles[nxt] if nxt < len(self.candles) else None

    def to_series(self) -> Series:
        """The visible history as an indicator-ready series."""
        from app.analysis.series import to_series

        return to_series(list(self.visible))
