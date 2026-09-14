"""A long run through the real engine.

Unit tests establish that each piece is correct once. This one asks a different
question: does the system stay correct over thousands of trades, where rounding
accumulates, limits interact, and a one-cent drift per trade becomes a
forty-dollar lie about the balance?

The trades are synthetic, but nothing else is. The broker, the engine, the
sizer, the risk manager and the performance calculator are the ones the bot
uses, in the order it uses them.
"""

from __future__ import annotations

import random
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest

from app.paper.broker import PaperBroker
from app.paper.engine import OpenRequest, PaperEngine
from app.paper.models import PaperTrade
from app.paper.portfolio import equity_curve, performance
from app.risk.manager import PortfolioState, RiskLimits, RiskManager
from app.risk.sizing import position_size

START = Decimal("10000")
TRADES = 2000
SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]


class Run:
    """One full simulated account history, with every decision recorded."""

    def __init__(
        self,
        seed: int,
        win_rate: float,
        limits: RiskLimits,
        *,
        acknowledge_halts: bool = False,
    ) -> None:
        self.rng = random.Random(seed)
        self.win_rate = win_rate
        self.limits = limits
        self.engine = PaperEngine(PaperBroker())
        self.risk = RiskManager(limits)
        self.closed: list[PaperTrade] = []
        self.rejections: list[tuple[str, ...]] = []
        self.balance = START
        self.peak = START
        # Stands in for an operator clearing a drawdown halt, so the resumed
        # path is exercised rather than assumed.
        self.acknowledge_halts = acknowledge_halts
        self.acknowledgements = 0

    def state(self, day: date, realised_today: Decimal) -> PortfolioState:
        return PortfolioState(
            balance=self.balance,
            equity=self.balance,
            peak_equity=self.peak,
            open_symbols=frozenset(),
            realised_today=realised_today,
            day=day,
        )

    async def run(self, n: int = TRADES) -> None:
        start_day = datetime(2026, 1, 1, tzinfo=UTC)
        realised_today = Decimal(0)
        current_day = start_day.date()

        for i in range(n):
            at = start_day + timedelta(hours=i * 3)
            if at.date() != current_day:
                current_day = at.date()
                realised_today = Decimal(0)

            symbol = self.rng.choice(SYMBOLS)
            entry = Decimal(str(round(self.rng.uniform(0.4, 90000), 4)))
            # Stops between 0.4% and 3% away, both directions.
            distance = (entry * Decimal(str(round(self.rng.uniform(0.004, 0.03), 6)))).quantize(
                Decimal("0.00000001")
            )
            long = self.rng.random() < 0.5
            stop = entry - distance if long else entry + distance
            rr = Decimal(str(round(self.rng.uniform(1.5, 3.5), 2)))
            target = entry + distance * rr if long else entry - distance * rr

            size = position_size(
                balance=self.balance,
                risk_pct=self.limits.risk_per_trade_pct,
                entry=entry,
                stop=stop,
            )
            if size.quantity <= 0:
                continue

            confidence = Decimal(str(round(self.rng.uniform(75, 98), 2)))
            decision = self.risk.evaluate(
                symbol=symbol,
                portfolio=self.state(current_day, realised_today),
                confidence=confidence,
                reward_risk=rr,
                notional=size.notional,
                data_is_live=True,
                volatility_tradeable=True,
                now=at,
            )
            if not decision.approved:
                self.rejections.append(tuple(decision.reasons))
                if (
                    self.acknowledge_halts
                    and self.risk.halt_state(self.state(current_day, realised_today), now=at)[
                        "halted"
                    ]
                ):
                    # What the acknowledgement endpoint does: the high-water
                    # mark moves to today's equity. The old peak is not
                    # restored — the loss stays on the record.
                    self.peak = self.balance
                    self.acknowledgements += 1
                continue

            trade = await self.engine.open(
                OpenRequest(
                    symbol=symbol,
                    direction="LONG" if long else "SHORT",
                    timeframe="1h",
                    entry=entry,
                    stop=stop,
                    take_profit=target,
                    quantity=size.quantity,
                    risk_amount=size.risk_amount,
                    reward_risk=rr,
                    confidence=confidence,
                    strategy="simulation",
                    reason="simulated",
                ),
                data_is_live=True,
            )
            trade.opened_at = at

            win = self.rng.random() < self.win_rate
            exit_price = trade.take_profit if win else trade.stop_loss
            result = await self.engine.close(
                trade,
                price=exit_price,
                reason="take_profit" if win else "stop_loss",
            )
            result.trade.closed_at = at + timedelta(hours=2)

            self.closed.append(result.trade)
            self.balance += result.trade.pnl or Decimal(0)
            realised_today += result.trade.pnl or Decimal(0)
            self.peak = max(self.peak, self.balance)


@pytest.fixture(scope="module")
def anyio_backend():
    return "asyncio"


async def test_the_balance_never_drifts_from_the_sum_of_the_trades():
    """Recomputed balance versus running balance, after two thousand trades.

    This is the failure the portfolio module is built to make impossible — a
    cached total and a ledger that disagree — and a cent per trade would be
    twenty dollars by the end.
    """
    run = Run(seed=13, win_rate=0.5, limits=RiskLimits())
    await run.run()

    assert len(run.closed) > 300, "the simulation never got going"

    from_ledger = START + sum((t.pnl or Decimal(0)) for t in run.closed)
    assert from_ledger == run.balance

    curve = equity_curve(run.closed, START)
    assert curve[-1][1] == run.balance


async def test_risk_per_trade_is_honoured_on_every_single_trade():
    """Not on average — on every one. An average hides the trade that risked
    four times the limit."""
    run = Run(seed=12, win_rate=0.5, limits=RiskLimits())
    await run.run()

    for trade in run.closed:
        # The loss a stop-out actually produces, before costs.
        distance = abs(trade.entry - trade.stop_loss)
        exposure = distance * trade.quantity
        cap = START.max(run.balance) * Decimal("1.5") / 100
        assert exposure <= cap, f"{trade.symbol} risked {exposure} against a cap of {cap}"


async def test_performance_totals_stay_internally_consistent():
    run = Run(seed=13, win_rate=0.5, limits=RiskLimits())
    await run.run()
    perf = performance(run.closed, START)

    assert perf.total_trades == len(run.closed)
    assert perf.wins + perf.losses + perf.breakeven == perf.total_trades
    assert perf.total_pnl == sum((t.pnl or Decimal(0)) for t in run.closed)
    assert perf.total_fees == sum(t.fees for t in run.closed)
    assert Decimal(0) <= perf.max_drawdown_pct <= Decimal(100)


async def test_a_losing_strategy_is_stopped_by_the_drawdown_limit():
    """The limit that matters most is the one that only fires on the worst run.

    At a 20% win rate the account bleeds steadily; the risk manager must refuse
    to keep opening once the drawdown limit is passed, rather than trading the
    balance to zero.
    """
    run = Run(seed=14, win_rate=0.20, limits=RiskLimits())
    await run.run()

    drawdown = (run.peak - run.balance) / run.peak * 100
    assert drawdown <= Decimal(25), f"drawdown reached {drawdown}% — the limit did not hold"
    assert any("drawdown" in " ".join(r) for r in run.rejections), (
        "the drawdown limit never fired, so this test proved nothing"
    )
    assert run.balance > START * Decimal("0.5"), "the account was traded into the ground"


async def test_the_same_seed_produces_the_same_account():
    """Determinism is what makes any of this measurable. A simulation that
    differs run to run cannot be used to check a change."""
    a = Run(seed=15, win_rate=0.5, limits=RiskLimits())
    b = Run(seed=15, win_rate=0.5, limits=RiskLimits())
    await a.run(300)
    await b.run(300)

    assert a.balance == b.balance
    assert [t.pnl for t in a.closed] == [t.pnl for t in b.closed]


async def test_fees_and_slippage_are_charged_on_every_trade():
    """A simulation that forgets costs reports a strategy nobody can trade."""
    run = Run(seed=16, win_rate=0.5, limits=RiskLimits())
    await run.run(400)

    assert all(t.fees > 0 for t in run.closed)
    perf = performance(run.closed, START)
    assert perf.total_fees > 0


async def test_both_legs_of_the_round_trip_are_charged():
    """A two-thousand-trade run is what made this visible.

    Only the exit fee was being deducted from P/L, while both legs were
    recorded in `fees` — so every trade reported a result better than it was,
    by an amount that at the taker rate on a typical notional came to roughly a
    tenth of what the trade risked. A single trade hides that inside rounding;
    a thousand of them do not.
    """
    run = Run(seed=17, win_rate=0.5, limits=RiskLimits())
    await run.run(300)

    for trade in run.closed:
        gross = (
            (trade.exit_price - trade.entry)
            if trade.direction == "LONG"
            else (trade.entry - trade.exit_price)
        ) * trade.quantity
        assert trade.pnl == (gross - trade.fees).quantize(Decimal("0.01")), (
            f"{trade.symbol}: P/L does not account for both legs' fees"
        )

    perf = performance(run.closed, START)
    assert perf.total_fees == sum(t.fees for t in run.closed), (
        "the reported fee total and the fees on the trades disagree"
    )


async def test_a_drawdown_halt_is_permanent_until_a_human_clears_it():
    """The property that makes the acknowledgement necessary.

    Drawdown is measured from the account's high-water mark, and equity only
    rises by trading — so once the limit is passed, the state is absorbing. The
    bot does not recover, it simply goes quiet, which is the worst way for a
    safety limit to behave.
    """
    run = Run(seed=14, win_rate=0.20, limits=RiskLimits())
    await run.run()

    assert any("drawdown" in " ".join(r) for r in run.rejections)

    # Every rejection after the first drawdown block is also a drawdown block:
    # nothing the bot can do on its own clears it.
    reasons = [" ".join(r) for r in run.rejections]
    first = next(i for i, r in enumerate(reasons) if "drawdown" in r)
    assert all("drawdown" in r for r in reasons[first:]), (
        "the halt cleared by itself, which would mean the limit does not hold"
    )


async def test_acknowledging_the_halt_lets_the_bot_trade_again():
    """And the acknowledgement does not restore the old peak.

    Resetting the high-water mark to the equity that survived is the whole
    point: the loss stays on the record, and the next 10% is measured from
    where the account actually is.
    """
    halted = Run(seed=14, win_rate=0.20, limits=RiskLimits())
    await halted.run()

    resumed = Run(seed=14, win_rate=0.20, limits=RiskLimits(), acknowledge_halts=True)
    await resumed.run()

    assert resumed.acknowledgements > 0, "no halt was ever acknowledged"
    assert len(resumed.closed) > len(halted.closed) * 3, (
        f"acknowledging changed almost nothing: {len(halted.closed)} trades "
        f"halted versus {len(resumed.closed)} resumed"
    )
    # A losing strategy that keeps being resumed keeps losing. That is the
    # operator's decision to make, and the numbers do not hide it.
    assert resumed.balance < START
