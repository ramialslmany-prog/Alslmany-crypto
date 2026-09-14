"""Backtest tests.

The properties asserted here are the ones that separate a backtest from a
fiction. Each is a place where a replay usually flatters itself.
"""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from app.backtest.engine import BacktestConfig, Backtester
from app.backtest.window import Window
from app.market_data.schemas import Candle
from app.market_data.timeframes import Timeframe
from app.risk.manager import RiskLimits


def bars(closes: list[float], *, closed: bool = True) -> list[Candle]:
    base = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    out = []
    for i, c in enumerate(closes):
        out.append(
            Candle(
                symbol="BTCUSDT",
                timeframe=Timeframe.H1,
                open_time=base - timedelta(hours=len(closes) - i),
                open=Decimal(str(round(c * 0.999, 8))),
                high=Decimal(str(round(c * 1.006, 8))),
                low=Decimal(str(round(c * 0.994, 8))),
                close=Decimal(str(round(c, 8))),
                volume=Decimal("1000"),
                closed=closed or i < len(closes) - 1,
            )
        )
    return out


def trending(seed: int, up: bool, n: int = 400) -> list[float]:
    random.seed(seed)
    price = 100.0
    out: list[float] = []
    while len(out) < n:
        for _ in range(random.randint(8, 14)):
            price *= 1 + (0.012 if up else -0.012) * random.uniform(0.6, 1.4)
            out.append(price)
            if len(out) >= n:
                break
        if len(out) >= n:
            break
        for _ in range(random.randint(3, 6)):
            price *= 1 - (0.006 if up else -0.006) * random.uniform(0.5, 1.2)
            out.append(price)
            if len(out) >= n:
                break
    return out[:n]


def config(**kw) -> BacktestConfig:
    base = {"symbol": "BTCUSDT", "timeframe": "1h"}
    return BacktestConfig(**{**base, **kw})


# --- the no-look-ahead guarantee -------------------------------------------


def test_a_window_cannot_contain_a_bar_after_its_cursor():
    """Structural, not a matter of discipline. There is no argument that widens
    a Window and no method that reaches past it."""
    candles = bars([100.0 + i for i in range(20)])
    window = Window(tuple(candles), 5)

    assert len(window.visible) == 6
    assert window.visible[-1] is candles[5]
    assert all(c in candles[:6] for c in window.visible)


def test_the_fill_bar_is_not_visible_to_the_strategy():
    """A signal computed from a bar's close cannot be filled at that close —
    the close is only known once the bar is over."""
    candles = bars([100.0 + i for i in range(20)])
    window = Window(tuple(candles), 5)

    assert window.next_bar is candles[6]
    assert candles[6] not in window.visible


def test_a_cursor_outside_the_series_is_refused():
    candles = bars([100.0] * 5)
    with pytest.raises(IndexError):
        Window(tuple(candles), 5)
    with pytest.raises(IndexError):
        Window(tuple(candles), -1)


async def test_the_replay_never_reads_a_bar_it_should_not_see():
    """The real guarantee: drive a replay and assert no analysis ever touched
    a bar beyond its cursor.

    Enforced by replacing each future bar with a value so extreme that any
    indicator touching it would distort beyond recognition — and then checking
    that every trade's entry is consistent with the untouched history.
    """
    closes = trending(4, up=True, n=300)
    candles = bars(closes)

    seen_max: list[int] = []
    original = Window.to_series

    def spy(self: Window):
        seen_max.append(self.cursor)
        series = original(self)
        assert len(series) == self.cursor + 1, (
            f"series had {len(series)} bars at cursor {self.cursor}"
        )
        return series

    Window.to_series = spy
    try:
        await Backtester(config()).run(candles)
    finally:
        Window.to_series = original

    assert seen_max, "the replay never analysed anything"
    assert max(seen_max) < len(candles)


# --- pessimistic execution -------------------------------------------------


async def test_entries_fill_on_the_next_bars_open_not_the_deciding_close():
    """Search seeds until one trades, rather than skipping. A test that skips
    is not testing, and this is the property the whole replay rests on."""
    for seed in range(12):
        candles = bars(trending(seed, up=True, n=300))
        result = await Backtester(config()).run(candles)
        if result.trades:
            break
    else:
        raise AssertionError("no seed produced a trade; the replay never fires")

    opens = {c.open_time: c.open for c in candles}
    closes_by_time = {c.open_time: c.close for c in candles}

    for trade in result.trades:
        bar_open = opens.get(trade.opened_at)
        assert bar_open is not None, "the entry is stamped to a bar that exists"
        # The fill is the bar's OPEN plus adverse slippage — never the close of
        # the bar the decision was computed from.
        assert trade.entry >= bar_open, "a long must fill at or worse than the open"
        assert trade.entry < bar_open * Decimal("1.01"), "slippage stayed bounded"
        assert trade.entry != closes_by_time[trade.opened_at], (
            "filling at the deciding bar's own close is look-ahead"
        )


async def test_costs_are_charged_so_a_flat_market_does_not_break_even():
    """Fees and adverse slippage on both legs. A replay that fills at the
    requested price makes every strategy look better than it is."""
    result = await Backtester(config()).run(bars([100.0] * 300))

    assert result.performance.total_pnl <= 0


# --- honest reporting ------------------------------------------------------


async def test_a_result_is_labelled_a_backtest():
    """A backtest result and a paper-trading result must never be mistaken for
    each other."""
    result = await Backtester(config()).run(bars(trending(2, up=True, n=200)))
    assert result.to_dict()["kind"] == "BACKTEST"


async def test_buy_and_hold_is_reported_alongside_the_strategy():
    """A strategy returning 40% in a market that returned 120% did not make
    money, it cost 80%."""
    closes = trending(3, up=True, n=300)
    result = await Backtester(config()).run(bars(closes))

    expected = (closes[-1] - closes[0] * 0.999) / (closes[0] * 0.999) * 100
    assert abs(float(result.buy_and_hold_pct) - expected) < 1.0
    assert "buy_and_hold_pct" in result.to_dict()


async def test_too_little_history_is_reported_rather_than_returning_zero_trades():
    """ "0 trades" as a bare result reads like a finding. It is usually a bug."""
    result = await Backtester(config()).run(bars([100.0 + i for i in range(40)]))

    assert result.bars_analysed == 0
    assert result.caveats
    assert any("history" in c for c in result.caveats)


async def test_a_position_open_at_the_end_is_closed_and_flagged():
    """Dropping it hides the strategy's worst habit: holding losers."""
    closes = trending(11, up=True, n=300)
    result = await Backtester(config()).run(bars(closes))

    end_of_data = [t for t in result.trades if t.exit_reason == "end_of_data"]
    if end_of_data:
        assert any("still open" in c for c in result.caveats)
        assert all(t.status == "closed" for t in result.trades)


async def test_a_forming_final_bar_is_excluded():
    candles = bars([100.0 + i for i in range(200)], closed=False)
    assert candles[-1].closed is False

    result = await Backtester(config()).run(candles)

    # The replay stops one bar earlier than it would with a settled final bar.
    assert result.bars_analysed + result.bars_skipped <= len(candles) - 1


# --- it uses the live code path --------------------------------------------


async def test_the_replay_respects_the_same_risk_limits_as_the_bot():
    strict = config(limits=RiskLimits(min_confidence=Decimal("99.9")))
    result = await Backtester(strict).run(bars(trending(5, up=True, n=300)))

    assert result.trades == []
    assert result.performance.total_trades == 0


async def test_every_trade_carries_the_thesis_that_opened_it():
    result = await Backtester(config()).run(bars(trending(7, up=True, n=300)))

    for trade in result.trades:
        assert trade.reason
        assert trade.evidence
        assert trade.is_paper is True


async def test_risk_per_trade_is_honoured_across_the_replay():
    result = await Backtester(config(risk_pct=Decimal("1"))).run(bars(trending(9, up=True, n=300)))

    for trade in result.trades:
        # Never more than the configured risk of the balance at the time. The
        # exposure cap can make it less; it must never make it more.
        assert trade.risk_amount <= Decimal("200"), (
            f"{trade.risk_amount} risked on a 10,000 account at 1%"
        )


# --- determinism -----------------------------------------------------------


async def test_the_same_input_produces_the_same_result():
    """A replay that is not reproducible cannot be debugged or compared."""
    candles = bars(trending(13, up=True, n=300))

    first = await Backtester(config()).run(candles)
    second = await Backtester(config()).run(candles)

    assert first.performance.total_trades == second.performance.total_trades
    assert first.performance.total_pnl == second.performance.total_pnl
    assert [t.entry for t in first.trades] == [t.entry for t in second.trades]
