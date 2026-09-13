"""Paper-trading engine tests.

The properties asserted here are the ones that separate an honest simulation
from a flattering one.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from app.paper.broker import PaperBroker
from app.paper.engine import ExitReason, OpenRequest, PaperEngine
from app.paper.models import PaperTrade


def request(**overrides) -> OpenRequest:
    base = {
        "symbol": "BTCUSDT",
        "direction": "LONG",
        "timeframe": "1h",
        "entry": Decimal("100"),
        "stop": Decimal("95"),
        "take_profit": Decimal("115"),
        "quantity": Decimal("20"),
        "risk_amount": Decimal("100"),
        "reward_risk": Decimal("3"),
        "confidence": Decimal("82"),
        "strategy": "trend-continuation",
        "reason": "Higher highs with volume confirmation.",
    }
    return OpenRequest(**{**base, **overrides})


def engine() -> PaperEngine:
    return PaperEngine(PaperBroker())


def open_trade(**overrides) -> PaperTrade:
    """A trade opened without slippage, so arithmetic assertions stay readable."""
    trade = PaperTrade(
        symbol="BTCUSDT",
        direction="LONG",
        status="open",
        timeframe="1h",
        entry=Decimal("100"),
        stop_loss=Decimal("95"),
        take_profit=Decimal("115"),
        quantity=Decimal("20"),
        notional=Decimal("2000"),
        risk_amount=Decimal("100"),
        reward_risk=Decimal("3"),
        fees=Decimal("0"),
        confidence=Decimal("82"),
        strategy="test",
        reason="test",
        opened_at=datetime.now(UTC),
        is_paper=True,
    )
    for key, value in overrides.items():
        setattr(trade, key, value)
    return trade


# --- it is paper, structurally ---------------------------------------------


async def test_an_opened_trade_is_marked_paper():
    trade = await engine().open(request(), data_is_live=True)
    assert trade.is_paper is True


async def test_the_broker_only_ever_produces_simulated_fills():
    broker = PaperBroker()
    fill = await broker.place(
        symbol="BTCUSDT", side="buy", quantity=Decimal("1"), price=Decimal("100")
    )
    assert fill.simulated is True


async def test_opening_on_data_that_is_not_live_is_refused():
    """The last place this can be caught before a position exists."""
    with pytest.raises(ValueError, match="Insufficient reliable market data"):
        await engine().open(request(), data_is_live=False)


# --- costs are charged against us ------------------------------------------


async def test_a_buy_fills_worse_than_requested_and_a_sell_fills_lower():
    """Slippage is always adverse. A simulation that fills at the requested
    price is wrong systematically, not randomly, so it never averages out."""
    broker = PaperBroker()

    buy = await broker.place(symbol="X", side="buy", quantity=Decimal("1"), price=Decimal("100"))
    sell = await broker.place(symbol="X", side="sell", quantity=Decimal("1"), price=Decimal("100"))

    assert buy.price > buy.requested
    assert sell.price < sell.requested
    assert buy.fee > 0 and sell.fee > 0


async def test_a_round_trip_at_the_same_price_loses_money():
    """Entry and exit at an identical price must be a small loss, never zero.
    Costs are the difference between a backtest and a broker statement."""
    eng = engine()
    trade = await eng.open(request(), data_is_live=True)

    result = await eng.close(trade, price=Decimal("100"), reason=ExitReason.MANUAL)

    assert result.pnl < 0
    assert result.result == "LOSS"


async def test_both_legs_fees_are_recorded():
    eng = engine()
    trade = await eng.open(request(), data_is_live=True)
    entry_fee = trade.fees

    await eng.close(trade, price=Decimal("110"), reason=ExitReason.TAKE_PROFIT)

    assert trade.fees > entry_fee, "charging only the exit halves the real cost"


# --- intrabar pessimism ----------------------------------------------------


def test_a_bar_containing_both_levels_takes_the_stop():
    """OHLC cannot tell us which came first. Assuming the favourable order turns
    losing trades into winners exactly in the bars where it matters most."""
    eng = engine()
    trade = open_trade()

    reason = eng.check_exit(trade, high=Decimal("120"), low=Decimal("90"))

    assert reason == ExitReason.STOP_LOSS


def test_a_target_alone_closes_at_the_target():
    eng = engine()
    trade = open_trade()
    assert eng.check_exit(trade, high=Decimal("116"), low=Decimal("99")) == ExitReason.TAKE_PROFIT


def test_a_bar_touching_neither_level_stays_open():
    eng = engine()
    trade = open_trade()
    assert eng.check_exit(trade, high=Decimal("110"), low=Decimal("97")) is None


def test_short_exits_are_mirrored():
    eng = engine()
    trade = open_trade(
        direction="SHORT",
        entry=Decimal("100"),
        stop_loss=Decimal("105"),
        take_profit=Decimal("85"),
    )

    assert eng.check_exit(trade, high=Decimal("106"), low=Decimal("99")) == ExitReason.STOP_LOSS
    assert eng.check_exit(trade, high=Decimal("101"), low=Decimal("84")) == ExitReason.TAKE_PROFIT
    assert eng.check_exit(trade, high=Decimal("101"), low=Decimal("95")) is None


# --- a stop is never widened -----------------------------------------------


def test_a_long_stop_can_be_tightened():
    eng = engine()
    trade = open_trade()
    assert eng.move_stop(trade, Decimal("98")) is True
    assert trade.stop_loss == Decimal("98")


def test_a_long_stop_cannot_be_widened():
    """There is no code path that moves a stop further from entry. Widening
    turns a defined loss into an undefined one."""
    eng = engine()
    trade = open_trade()

    assert eng.move_stop(trade, Decimal("90")) is False
    assert trade.stop_loss == Decimal("95"), "the stop must not have moved"


def test_a_short_stop_cannot_be_widened_either():
    eng = engine()
    trade = open_trade(direction="SHORT", entry=Decimal("100"), stop_loss=Decimal("105"))

    assert eng.move_stop(trade, Decimal("110")) is False
    assert eng.move_stop(trade, Decimal("102")) is True
    assert trade.stop_loss == Decimal("102")


def test_breakeven_only_applies_once_the_trade_is_one_r_up():
    """Moving to breakeven early converts trades that would have worked into
    scratches: retracement reaches back through entry far more often than 1R."""
    eng = engine()
    trade = open_trade()

    assert eng.breakeven_stop(trade, Decimal("102")) is False  # 0.4R
    assert trade.stop_loss == Decimal("95")

    assert eng.breakeven_stop(trade, Decimal("105")) is True  # 1R
    assert trade.stop_loss == trade.entry


# --- P&L arithmetic --------------------------------------------------------


def test_unrealised_pnl_and_r_multiple():
    eng = engine()
    trade = open_trade()

    pnl, r = eng.unrealised(trade, Decimal("105"))

    assert pnl == Decimal("100.00")  # 5 x 20 units
    assert r == Decimal("1.00")  # risk was 100


def test_unrealised_is_mirrored_for_shorts():
    eng = engine()
    trade = open_trade(direction="SHORT")

    pnl, r = eng.unrealised(trade, Decimal("95"))

    assert pnl == Decimal("100.00")
    assert r == Decimal("1.00")


async def test_closing_records_the_full_outcome():
    eng = engine()
    trade = await eng.open(request(), data_is_live=True)

    result = await eng.close(trade, price=Decimal("115"), reason=ExitReason.TAKE_PROFIT)

    assert trade.status == "closed"
    assert trade.result == "WIN"
    assert trade.exit_reason == ExitReason.TAKE_PROFIT
    assert trade.closed_at is not None
    assert trade.exit_price is not None
    assert trade.r_multiple > 0
    assert result.pnl == trade.pnl


async def test_a_closed_trade_cannot_be_closed_again():
    """Double-closing would book the same P&L twice."""
    eng = engine()
    trade = await eng.open(request(), data_is_live=True)
    await eng.close(trade, price=Decimal("110"), reason=ExitReason.TAKE_PROFIT)

    with pytest.raises(ValueError, match="already closed"):
        await eng.close(trade, price=Decimal("110"), reason=ExitReason.MANUAL)


async def test_a_stopped_out_long_loses_roughly_one_r():
    eng = engine()
    trade = await eng.open(request(), data_is_live=True)

    result = await eng.close(trade, price=trade.stop_loss, reason=ExitReason.STOP_LOSS)

    assert result.result == "LOSS"
    # Slightly worse than -1R once costs are charged — never better.
    assert result.r_multiple < Decimal("-1.0")
    assert result.r_multiple > Decimal("-1.3")


async def test_the_thesis_is_frozen_at_entry():
    """Judging a closed trade against an explanation regenerated afterwards is
    judging it against hindsight."""
    eng = engine()
    trade = await eng.open(
        request(reason="Bullish CHoCH with a swept low.", evidence={"factors": ["choch"]}),
        data_is_live=True,
    )

    await eng.close(trade, price=Decimal("90"), reason=ExitReason.STOP_LOSS)

    assert trade.reason == "Bullish CHoCH with a swept low."
    assert trade.evidence == {"factors": ["choch"]}


# --- input validation ------------------------------------------------------


async def test_a_zero_quantity_order_is_refused():
    with pytest.raises(ValueError):
        await engine().open(request(quantity=Decimal("0")), data_is_live=True)


async def test_a_negative_price_is_refused():
    with pytest.raises(ValueError):
        await PaperBroker().place(
            symbol="X", side="buy", quantity=Decimal("1"), price=Decimal("-5")
        )
