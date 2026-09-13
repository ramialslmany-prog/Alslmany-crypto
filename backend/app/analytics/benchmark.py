"""Strategy versus simply holding, over the window the strategy actually traded.

A return reported without this comparison is close to meaningless. 18% sounds
like a result until the asset returned 60% over the same weeks, at which point
the strategy did not make money — it cost 42% and a great deal of risk.

Two things here are easy to get wrong and are handled explicitly.

**The window.** Holding is measured from the first trade opened on that symbol
to the last one closed, not from the start of whatever candle history happened
to be fetched. Comparing a strategy's six weeks against an asset's six months
is not a comparison.

**The denominator.** A price move is a percentage of the price; a trade's P/L
is a percentage of the *account*, and the account only ever risked 1% on each
trade. These two numbers are not the same kind of thing, and the payload says
so rather than subtracting one from the other and printing the difference as
though it meant something.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from app.market_data.schemas import Candle
from app.paper.models import PaperTrade

DENOMINATOR_NOTE = (
    "Hold return is a percentage of the asset's price. Strategy return is a "
    "percentage of the account, which risked a fraction of itself on each trade. "
    "They answer different questions and are shown side by side rather than "
    "subtracted."
)


@dataclass(frozen=True, slots=True)
class SymbolBenchmark:
    symbol: str
    first_trade: datetime
    last_trade: datetime
    trades: int
    hold_return_pct: Decimal | None
    strategy_pnl: Decimal
    strategy_return_pct: Decimal
    covered: bool
    note: str

    def to_dict(self) -> dict[str, object]:
        return {
            "symbol": self.symbol,
            "window": {
                "from": self.first_trade.isoformat(),
                "to": self.last_trade.isoformat(),
            },
            "trades": self.trades,
            "hold_return_pct": (
                None if self.hold_return_pct is None else str(self.hold_return_pct)
            ),
            "strategy_pnl": str(self.strategy_pnl),
            "strategy_return_pct": str(self.strategy_return_pct),
            "covered": self.covered,
            "note": self.note,
        }


def windows(trades: list[PaperTrade]) -> dict[str, tuple[datetime, datetime]]:
    """First open to last close, per symbol, over closed trades only."""
    out: dict[str, tuple[datetime, datetime]] = {}
    for trade in trades:
        if trade.status != "closed" or trade.closed_at is None:
            continue
        start, end = out.get(trade.symbol, (trade.opened_at, trade.closed_at))
        out[trade.symbol] = (
            min(start, trade.opened_at),
            max(end, trade.closed_at),
        )
    return out


def hold_return(
    candles: list[Candle], start: datetime, end: datetime
) -> tuple[Decimal | None, bool]:
    """Return of buying at `start` and selling at `end`, plus whether the candle
    history actually covers that window.

    `covered` is returned separately and never folded into the number. If the
    history begins after the first trade, the honest answer is "this is a
    partial window", not a percentage quietly measured over less time than the
    strategy had.
    """
    ordered = sorted(candles, key=lambda c: c.open_time)
    if not ordered:
        return None, False

    entry = next((c for c in ordered if c.open_time >= start), None)
    exits = [c for c in ordered if c.open_time <= end]
    if entry is None or not exits or entry.open <= 0:
        return None, False

    covered = ordered[0].open_time <= start and ordered[-1].open_time >= end
    pct = (exits[-1].close - entry.open) / entry.open * 100
    return pct.quantize(Decimal("0.01")), covered


def build(
    trades: list[PaperTrade],
    candles_by_symbol: dict[str, list[Candle]],
    starting_balance: Decimal,
) -> list[SymbolBenchmark]:
    closed = [t for t in trades if t.status == "closed" and t.closed_at is not None]
    spans = windows(closed)

    out: list[SymbolBenchmark] = []
    for symbol, (start, end) in spans.items():
        rows = [t for t in closed if t.symbol == symbol]
        pnl = sum((t.pnl or Decimal(0)) for t in rows)
        candles = candles_by_symbol.get(symbol, [])
        pct, covered = hold_return(candles, start, end)

        if pct is None:
            note = (
                "No price history was available for this window, so holding "
                "cannot be measured. No comparison is shown rather than a "
                "comparison against nothing."
            )
        elif not covered:
            note = (
                "The available price history does not span the whole trading "
                "window, so the hold figure covers only part of it."
            )
        else:
            note = ""

        out.append(
            SymbolBenchmark(
                symbol=symbol,
                first_trade=start,
                last_trade=end,
                trades=len(rows),
                hold_return_pct=pct,
                strategy_pnl=Decimal(pnl),
                strategy_return_pct=(Decimal(pnl) / starting_balance * 100).quantize(
                    Decimal("0.01")
                ),
                covered=covered,
                note=note,
            )
        )

    out.sort(key=lambda b: -b.trades)
    return out
