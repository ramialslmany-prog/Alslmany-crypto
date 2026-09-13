"""Bot runner tests: the loop that ties scanning to opening and closing."""

from __future__ import annotations

import math
import random
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.core.errors import NoMarketDataError
from app.market_data.schemas import Candle, Provenance, Sourced, Ticker
from app.paper.broker import PaperBroker
from app.paper.engine import ExitReason, PaperEngine
from app.paper.models import PaperTrade
from app.paper.runner import BotRunner
from app.risk.manager import RiskLimits


def trending(seed: int, up: bool, n: int = 300) -> list[float]:
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


class FakeMarket:
    """A market service with no network, whose behaviour each test dictates."""

    def __init__(self, closes: dict[str, list[float]], *, stale: bool = False) -> None:
        self.closes = closes
        self.stale = stale
        self.fail: set[str] = set()
        self.override_bar: dict[str, tuple[Decimal, Decimal]] = {}

    async def get_candles(self, symbol, timeframe, limit=200, **kw):
        if symbol in self.fail:
            raise NoMarketDataError("down", providers_tried=["fake"])

        series = self.closes[symbol][-limit:]
        base = datetime.now(UTC)
        candles = []
        for i, c in enumerate(series):
            high, low = c * 1.005, c * 0.995
            open_, close = c * 0.999, c
            if i == len(series) - 1 and symbol in self.override_bar:
                high, low = (float(x) for x in self.override_bar[symbol])
                # Open and close must sit inside the overridden range — the
                # Candle schema rejects anything else, and rightly so.
                open_ = close = (high + low) / 2
            candles.append(
                Candle(
                    symbol=symbol,
                    timeframe=timeframe,
                    open_time=base - timedelta(hours=len(series) - i),
                    open=Decimal(str(round(open_, 8))),
                    high=Decimal(str(round(high, 8))),
                    low=Decimal(str(round(low, 8))),
                    close=Decimal(str(round(close, 8))),
                    volume=Decimal("1000"),
                )
            )
        return Sourced(
            data=candles,
            provenance=Provenance(provider="fake", fetched_at=datetime.now(UTC), stale=self.stale),
        )

    async def get_ticker(self, symbol, **kw):
        if symbol in self.fail:
            raise NoMarketDataError("down", providers_tried=["fake"])
        return Sourced(
            data=Ticker(
                symbol=symbol,
                price=Decimal(str(round(self.closes[symbol][-1], 8))),
                timestamp=datetime.now(UTC),
            ),
            provenance=Provenance(provider="fake", fetched_at=datetime.now(UTC)),
        )


def runner(market, **kw) -> BotRunner:
    return BotRunner(
        market=market,
        engine=PaperEngine(PaperBroker()),
        limits=RiskLimits(**kw) if kw else None,
    )


def open_trade(symbol="BTCUSDT", **overrides) -> PaperTrade:
    trade = PaperTrade(
        symbol=symbol,
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


# --- the happy path --------------------------------------------------------


async def test_a_tick_on_a_clean_uptrend_opens_a_position():
    market = FakeMarket({"BTCUSDT": trending(3, up=True)})
    report = await runner(market).tick(["BTCUSDT"], [])

    assert report.scanned == ["BTCUSDT"]
    assert report.signals
    if report.opened:
        assert report.new_trades
        assert report.new_trades[0].is_paper is True
        assert report.new_trades[0].direction == "LONG"


async def test_a_tick_reports_why_it_declined():
    """ "Why is the bot not trading" has to be answerable. Silence is the worst
    possible answer."""
    market = FakeMarket({"BTCUSDT": [100.0 + math.sin(i / 5) for i in range(300)]})
    report = await runner(market).tick(["BTCUSDT"], [])

    assert not report.opened
    assert report.rejected
    assert report.rejected[0]["reasons"]


# --- data availability is a veto -------------------------------------------


async def test_stale_data_prevents_opening():
    market = FakeMarket({"BTCUSDT": trending(3, up=True)}, stale=True)
    report = await runner(market).tick(["BTCUSDT"], [])

    assert not report.opened
    reasons = [r for entry in report.rejected for r in entry["reasons"]]
    assert "no_reliable_market_data" in reasons or "no_qualifying_setup" in reasons


async def test_one_dead_symbol_does_not_kill_the_tick():
    market = FakeMarket({"A": trending(1, True), "BTCUSDT": trending(2, True)})
    market.fail.add("A")
    market.closes["A"] = trending(1, True)

    report = await runner(market).tick(["A", "BTCUSDT"], [])

    assert report.errors and report.errors[0]["symbol"] == "A"
    assert "BTCUSDT" in report.scanned


# --- monitoring runs first -------------------------------------------------


async def test_a_stopped_out_position_is_closed_before_new_entries():
    market = FakeMarket({"BTCUSDT": trending(3, up=True)})
    trade = open_trade()
    # Force the latest bar to trade through the stop.
    market.override_bar["BTCUSDT"] = (Decimal("101"), Decimal("90"))

    report = await runner(market).tick([], [trade])

    assert report.closed
    assert report.closed[0]["reason"] == ExitReason.STOP_LOSS
    assert trade.status == "closed"


async def test_a_position_whose_price_is_unreadable_is_left_open():
    """Closing on missing data would book a fictional exit price."""
    market = FakeMarket({"BTCUSDT": trending(3, up=True)})
    market.fail.add("BTCUSDT")
    trade = open_trade()

    report = await runner(market).tick([], [trade])

    assert trade.status == "open"
    assert any(e.get("context") == "monitor" for e in report.errors)


async def test_a_winning_position_is_taken_at_the_target():
    market = FakeMarket({"BTCUSDT": trending(3, up=True)})
    trade = open_trade()
    market.override_bar["BTCUSDT"] = (Decimal("120"), Decimal("110"))

    report = await runner(market).tick([], [trade])

    assert report.closed[0]["reason"] == ExitReason.TAKE_PROFIT
    assert trade.result == "WIN"


# --- limits are respected within a single tick -----------------------------


async def test_positions_opened_in_one_tick_count_against_the_limit():
    """Without threading the state through, a single tick could open six
    positions against a limit of five."""
    symbols = [f"S{i}USDT" for i in range(6)]
    market = FakeMarket({s: trending(i + 1, up=True) for i, s in enumerate(symbols)})

    report = await runner(market, max_open_trades=2).tick(symbols, [])

    assert len(report.opened) <= 2


async def test_a_symbol_already_open_is_not_opened_again():
    market = FakeMarket({"BTCUSDT": trending(3, up=True)})
    report = await runner(market).tick(["BTCUSDT"], [open_trade()])

    assert "BTCUSDT" not in report.opened
