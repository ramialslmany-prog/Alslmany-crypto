"""Replaying the whole book.

The single-symbol replay answers "would this have worked on BTC". These tests
are about the questions only a portfolio replay can answer, all of which are
about limits that cannot bind when there is one position in the world.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from itertools import pairwise

from app.backtest.portfolio import (
    PortfolioBacktestConfig,
    PortfolioBacktester,
    PortfolioBacktestResult,
)
from app.market_data.schemas import Candle
from app.market_data.timeframes import Timeframe
from app.risk.manager import RiskLimits
from tests.test_backtest import trending

BASE = datetime(2026, 1, 1, tzinfo=UTC)


def candles(
    closes: list[float], symbol: str = "BTCUSDT", *, start: datetime = BASE
) -> list[Candle]:
    return [
        Candle(
            symbol=symbol,
            timeframe=Timeframe.H1,
            open_time=start + timedelta(hours=i),
            open=Decimal(str(round(c * 0.999, 8))),
            high=Decimal(str(round(c * 1.006, 8))),
            low=Decimal(str(round(c * 0.994, 8))),
            close=Decimal(str(round(c, 8))),
            volume=Decimal("1000"),
            closed=True,
        )
        for i, c in enumerate(closes)
    ]


SEEDS = {"S0USDT": 0, "S1USDT": 1, "S2USDT": 6, "S3USDT": 10, "S4USDT": 13}


def diverse(n: int = 260) -> dict[str, list[Candle]]:
    return {s: candles(trending(seed, up=True, n=n), s) for s, seed in SEEDS.items()}


def identical(n: int = 260) -> dict[str, list[Candle]]:
    """Five symbols on one price path — the limiting case of a selloff."""
    path = trending(12, up=True, n=n)
    return {s: candles(list(path), s) for s in SEEDS}


def replay(**kw) -> PortfolioBacktester:
    base = {"symbols": tuple(SEEDS), "timeframe": "1h"}
    return PortfolioBacktester(PortfolioBacktestConfig(**{**base, **kw}))


# Replaying five symbols over 260 bars runs the analyser 1,300 times, and most
# of the tests below assert different properties of the SAME replay. Running it
# once and sharing it is what keeps this file from dominating the suite.
#
# Safe because the replay is deterministic — `test_the_same_input_produces_the_
# same_account` is the test that says so — and because nothing here mutates the
# result it is handed. A test needing different inputs or limits builds its own.
_CACHE: dict[int, PortfolioBacktestResult] = {}


async def standard(n: int = 260) -> PortfolioBacktestResult:
    if n not in _CACHE:
        _CACHE[n] = await replay().run(diverse(n))
    return _CACHE[n]


# --- what only a portfolio replay can see -----------------------------------


async def test_the_correlation_limit_refuses_trades_in_the_replay():
    """The first historical test of the heat limit. A single-symbol replay can
    never trip it, because it never has a second position to correlate with.

    This one gets the long window: the limit only binds once several positions
    can coexist, which takes a while to happen.
    """
    result = await replay().run(diverse(400))

    assert result.refusals.get("portfolio_heat", 0) > 0, (
        f"concentration never bound; refusals were {result.refusals}"
    )


async def test_five_symbols_on_one_path_trade_less_than_five_unrelated_ones():
    """Identical price paths are one bet five times over, and the account-level
    replay is the only place that is visible."""
    together = await replay().run(identical())
    spread = await standard()

    assert together.peak_open_positions < spread.peak_open_positions or len(together.trades) < len(
        spread.trades
    ), f"identical paths took {len(together.trades)} trades, unrelated took {len(spread.trades)}"


async def test_the_open_position_limit_binds_across_symbols():
    result = await replay(limits=RiskLimits(max_open_trades=2)).run(diverse())
    assert result.peak_open_positions <= 2


async def test_a_symbol_already_held_is_not_opened_again():
    result = await standard()
    assert result.refusals.get("duplicate_position", 0) > 0

    # And no two open positions ever shared a symbol, which is the property the
    # refusal count is evidence for.
    by_symbol: dict[str, list[tuple]] = {}
    for trade in result.trades:
        by_symbol.setdefault(trade.symbol, []).append((trade.opened_at, trade.closed_at))
    for symbol, spans in by_symbol.items():
        spans.sort()
        for (_, first_close), (second_open, _) in pairwise(spans):
            assert first_close is None or second_open >= first_close, (
                f"{symbol} held two overlapping positions"
            )


async def test_refusals_separate_no_setup_from_the_account_saying_no():
    """The most useful number in the result. "The bot did not trade" means two
    completely different things, and only one of them is a portfolio effect."""
    result = await standard()

    assert "no_qualifying_setup" in result.refusals
    account_level = {"portfolio_heat", "duplicate_position", "max_open_trades"}
    assert account_level & set(result.refusals), (
        "no account-level refusal was recorded, so nothing portfolio-shaped was tested"
    )


# --- the guarantees the single-symbol replay already had --------------------


async def test_bars_are_matched_by_timestamp_not_by_index():
    """Two symbols with the same bar count are not necessarily the same window.
    Pairing by position would replay Tuesday's BTC against Wednesday's ETH."""
    shifted = {
        "S0USDT": candles(trending(0, up=True, n=300), "S0USDT"),
        # Same length, starts a week later: they share far fewer bars than
        # either has, and only the overlap may be replayed.
        "S1USDT": candles(trending(1, up=True, n=300), "S1USDT", start=BASE + timedelta(days=7)),
    }

    result = await PortfolioBacktester(
        PortfolioBacktestConfig(symbols=("S0USDT", "S1USDT"), timeframe="1h")
    ).run(shifted)

    assert result.bars_replayed < 300, "the disjoint window was replayed in full"


async def test_a_window_too_short_to_share_is_refused_rather_than_guessed():
    tiny = {s: candles(trending(i, up=True, n=30), s) for i, s in enumerate(SEEDS)}
    result = await replay().run(tiny)

    assert result.trades == []
    assert any("shared by all" in c for c in result.caveats)


async def test_no_candles_at_all_is_stated_not_reported_as_zero_trades():
    result = await replay().run({})
    assert result.bars_replayed == 0
    assert any("No candles" in c for c in result.caveats)


async def test_entries_still_fill_on_the_next_bars_open():
    data = diverse()
    result = await replay().run(data)
    assert result.trades, "nothing traded, so the fill rule was not exercised"

    for trade in result.trades:
        rows = {c.open_time: c for c in data[trade.symbol]}
        bar = rows.get(trade.opened_at)
        assert bar is not None, "a trade opened on a bar that is not in the data"
        # Entry is the fill price, which is the bar's open plus adverse
        # slippage — never the close the decision was made on.
        assert trade.entry != bar.close


async def test_positions_still_open_at_the_end_are_closed_and_flagged():
    result = await standard()
    if any(t.exit_reason == "end_of_data" for t in result.trades):
        assert any("still open" in c for c in result.caveats)


async def test_the_benchmark_is_the_basket_not_one_lucky_symbol():
    """Comparing a five-symbol strategy against one symbol's return would
    flatter or damn it depending on which symbol was picked."""
    data = diverse()
    result = await replay().run(data)

    singles = []
    for rows in data.values():
        singles.append((rows[-1].close - rows[0].open) / rows[0].open * 100)

    assert min(singles) <= result.buy_and_hold_pct <= max(singles)


async def test_the_result_is_labelled_a_portfolio_backtest():
    result = await standard()
    assert result.to_dict()["kind"] == "PORTFOLIO_BACKTEST"


async def test_the_same_input_produces_the_same_account():
    """Symbols are considered in sorted order precisely so this holds: capital
    is finite, so the order decides who gets it.

    Deliberately not the shared replay: comparing a cached result against
    itself would prove nothing at all.
    """
    data = diverse(200)
    first = await replay().run(data)
    second = await replay().run(data)

    assert first.total_return_pct == second.total_return_pct
    assert [t.symbol for t in first.trades] == [t.symbol for t in second.trades]


async def test_no_trade_loses_more_than_it_set_out_to_risk():
    """Stated as a bound on the realised loss, which is the thing that actually
    matters and the only version of this that survives contact with the engine.

    Two earlier attempts were wrong about the code rather than the code being
    wrong. Checking `exposure <= 1% of 10,000` fails because the account
    compounds, so 1% is a moving number. Checking `entry - stop_loss` against
    `risk_amount` fails because `breakeven_stop` moves the stop TO entry once a
    trade is 1R up, making that distance legitimately zero.
    """
    result = await standard()
    assert result.trades

    for trade in result.trades:
        assert trade.risk_amount > 0
        loss = -(trade.pnl or Decimal(0))
        if loss <= 0:
            continue
        # Costs are charged on top of the planned loss, on both legs.
        assert loss <= trade.risk_amount * Decimal("1.25"), (
            f"{trade.symbol} lost {loss} against an intended risk of {trade.risk_amount}"
        )
