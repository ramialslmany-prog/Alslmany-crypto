"""Portfolio state and performance, derived from the trade ledger.

Nothing here stores a running total. Balance, equity, win rate and drawdown are
all computed from the trades themselves on every read.

That is deliberate. A cached balance and a ledger that disagree is the worst
failure this system could have — the number on screen would be confidently
wrong, and there would be no way to tell which was right. Recomputing is cheap
at this scale, and it cannot drift.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal

from app.paper.models import PaperTrade
from app.risk.manager import PortfolioState


@dataclass(frozen=True, slots=True)
class Performance:
    total_trades: int
    wins: int
    losses: int
    breakeven: int
    win_rate: Decimal
    total_pnl: Decimal
    average_win: Decimal
    average_loss: Decimal
    profit_factor: Decimal | None
    largest_win: Decimal
    largest_loss: Decimal
    longest_losing_streak: int
    total_r: Decimal
    expectancy_r: Decimal
    max_drawdown_pct: Decimal
    total_fees: Decimal

    def to_dict(self) -> dict[str, object]:
        return {
            "total_trades": self.total_trades,
            "wins": self.wins,
            "losses": self.losses,
            "breakeven": self.breakeven,
            "win_rate": str(self.win_rate),
            "total_pnl": str(self.total_pnl),
            "average_win": str(self.average_win),
            "average_loss": str(self.average_loss),
            "profit_factor": str(self.profit_factor) if self.profit_factor else None,
            "largest_win": str(self.largest_win),
            "largest_loss": str(self.largest_loss),
            "longest_losing_streak": self.longest_losing_streak,
            "total_r": str(self.total_r),
            "expectancy_r": str(self.expectancy_r),
            "max_drawdown_pct": str(self.max_drawdown_pct),
            "total_fees": str(self.total_fees),
        }


def equity_curve(
    closed: list[PaperTrade], starting_balance: Decimal
) -> list[tuple[datetime, Decimal]]:
    """Balance after each closed trade, oldest first."""
    ordered = sorted(closed, key=lambda t: t.closed_at or datetime.min.replace(tzinfo=UTC))
    balance = starting_balance
    curve: list[tuple[datetime, Decimal]] = []
    for trade in ordered:
        balance += trade.pnl or Decimal(0)
        curve.append((trade.closed_at, balance))
    return curve


def max_drawdown_pct(curve: list[tuple[datetime, Decimal]], starting: Decimal) -> Decimal:
    """Largest peak-to-trough fall, as a percentage of the peak.

    Measured against the running peak rather than the starting balance. A
    strategy that doubles and then halves has had a 50% drawdown, even though it
    never went below where it started — and that is the number that decides
    whether someone could actually have held on through it.
    """
    peak = starting
    worst = Decimal(0)
    for _, balance in curve:
        peak = max(peak, balance)
        if peak > 0:
            fall = (peak - balance) / peak * 100
            worst = max(worst, fall)
    return worst.quantize(Decimal("0.01"))


def performance(closed: list[PaperTrade], starting_balance: Decimal) -> Performance:
    if not closed:
        zero = Decimal("0.00")
        return Performance(
            total_trades=0,
            wins=0,
            losses=0,
            breakeven=0,
            win_rate=zero,
            total_pnl=zero,
            average_win=zero,
            average_loss=zero,
            profit_factor=None,
            largest_win=zero,
            largest_loss=zero,
            longest_losing_streak=0,
            total_r=zero,
            expectancy_r=zero,
            max_drawdown_pct=zero,
            total_fees=zero,
        )

    wins = [t for t in closed if t.result == "WIN"]
    losses = [t for t in closed if t.result == "LOSS"]
    breakeven = [t for t in closed if t.result == "BREAKEVEN"]

    gross_profit = sum((t.pnl or Decimal(0)) for t in wins)
    gross_loss = abs(sum((t.pnl or Decimal(0)) for t in losses))

    # Consecutive losses, because the number that ends a strategy is rarely the
    # average loss — it is the run of them nobody planned to sit through.
    streak = worst_streak = 0
    for trade in sorted(closed, key=lambda t: t.closed_at or datetime.min.replace(tzinfo=UTC)):
        if trade.result == "LOSS":
            streak += 1
            worst_streak = max(worst_streak, streak)
        else:
            streak = 0

    total_r = sum((t.r_multiple or Decimal(0)) for t in closed)
    curve = equity_curve(closed, starting_balance)

    return Performance(
        total_trades=len(closed),
        wins=len(wins),
        losses=len(losses),
        breakeven=len(breakeven),
        win_rate=(Decimal(len(wins)) / len(closed) * 100).quantize(Decimal("0.01")),
        total_pnl=sum((t.pnl or Decimal(0)) for t in closed).quantize(Decimal("0.01")),
        average_win=(gross_profit / len(wins)).quantize(Decimal("0.01"))
        if wins
        else Decimal("0.00"),
        average_loss=(gross_loss / len(losses)).quantize(Decimal("0.01"))
        if losses
        else Decimal("0.00"),
        # None rather than infinity when nothing has lost yet: a profit factor
        # of "inf" on three winning trades reads as a track record and is not one.
        profit_factor=(gross_profit / gross_loss).quantize(Decimal("0.01"))
        if gross_loss > 0
        else None,
        largest_win=max((t.pnl or Decimal(0) for t in closed), default=Decimal(0)).quantize(
            Decimal("0.01")
        ),
        largest_loss=min((t.pnl or Decimal(0) for t in closed), default=Decimal(0)).quantize(
            Decimal("0.01")
        ),
        longest_losing_streak=worst_streak,
        total_r=total_r.quantize(Decimal("0.01")),
        # Expectancy in R is the one figure that compares strategies fairly:
        # it is independent of account size and of position sizing.
        expectancy_r=(total_r / len(closed)).quantize(Decimal("0.01")),
        max_drawdown_pct=max_drawdown_pct(curve, starting_balance),
        total_fees=sum(t.fees for t in closed).quantize(Decimal("0.01")),
    )


def portfolio_state(
    *,
    trades: list[PaperTrade],
    starting_balance: Decimal,
    marks: dict[str, Decimal],
    today: date | None = None,
    peak_reset: tuple[datetime, Decimal] | None = None,
) -> PortfolioState:
    """Current state, for the risk manager's limit checks.

    `marks` are current prices for open positions. A symbol with no mark is
    carried at its entry rather than being dropped: excluding it would quietly
    understate exposure exactly when prices are unavailable, which is when
    exposure matters most.

    `peak_reset` is an operator's acknowledgement of a drawdown halt: `(at,
    equity)`. After it, the high-water mark is measured from that equity and
    the trades that followed, not from a peak the account reached before the
    loss. Without it the drawdown limit is an absorbing state — equity rises
    only by trading, and trading is exactly what the limit has stopped — so the
    bot would go quiet forever with nothing to say why.
    """
    today = today or datetime.now(UTC).date()
    closed = [t for t in trades if t.status == "closed"]
    open_trades = [t for t in trades if t.status == "open"]

    balance = starting_balance + sum((t.pnl or Decimal(0)) for t in closed)

    unrealised = Decimal(0)
    for trade in open_trades:
        mark = marks.get(trade.symbol, trade.entry)
        move = mark - trade.entry if trade.direction == "LONG" else trade.entry - mark
        unrealised += move * trade.quantity

    curve = equity_curve(closed, starting_balance)
    if peak_reset is None:
        peak = max([starting_balance, *[b for _, b in curve]], default=starting_balance)
    else:
        reset_at, baseline = peak_reset
        after = [b for at, b in curve if at >= reset_at]
        peak = max([baseline, *after], default=baseline)

    realised_today = sum(
        (t.pnl or Decimal(0))
        for t in closed
        if t.closed_at is not None and t.closed_at.date() == today
    )

    return PortfolioState(
        balance=balance.quantize(Decimal("0.01")),
        equity=(balance + unrealised).quantize(Decimal("0.01")),
        peak_equity=peak.quantize(Decimal("0.01")),
        open_symbols=frozenset(t.symbol for t in open_trades),
        realised_today=Decimal(realised_today).quantize(Decimal("0.01")),
        day=today,
    )
