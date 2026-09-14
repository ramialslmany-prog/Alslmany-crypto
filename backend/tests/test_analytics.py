"""Analytics tests.

Most of these check the same thing from different angles: that a small sample
is reported as a small sample, and that nothing in here can change the engine.
"""

from __future__ import annotations

import ast
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from app.analytics.breakdown import MIN_SAMPLE, breakdown, wilson_interval
from app.analytics.insights import APPLIED, observe
from app.paper.models import PaperTrade

START = Decimal("10000")
BASE = datetime(2026, 1, 1, tzinfo=UTC)


def trade(
    *,
    symbol: str = "BTCUSDT",
    direction: str = "LONG",
    timeframe: str = "1h",
    confidence: str = "82",
    r: str = "2",
    pnl: str = "200",
    reason: str = "take_profit",
    i: int = 0,
) -> PaperTrade:
    r_dec = Decimal(r)
    return PaperTrade(
        symbol=symbol,
        direction=direction,
        status="closed",
        timeframe=timeframe,
        entry=Decimal("100"),
        stop_loss=Decimal("95"),
        take_profit=Decimal("115"),
        quantity=Decimal("20"),
        notional=Decimal("2000"),
        risk_amount=Decimal("100"),
        reward_risk=Decimal("3"),
        exit_price=Decimal("115"),
        pnl=Decimal(pnl),
        r_multiple=r_dec,
        fees=Decimal("2"),
        result="WIN" if r_dec > 0 else "LOSS" if r_dec < 0 else "BREAKEVEN",
        exit_reason=reason,
        confidence=Decimal(confidence),
        strategy="multi-factor-v1",
        reason="test",
        opened_at=BASE + timedelta(hours=i),
        closed_at=BASE + timedelta(hours=i + 1),
        is_paper=True,
    )


def wins_and_losses(n_win: int, n_loss: int, **kw) -> list[PaperTrade]:
    """Interleaved, not blocked.

    Appending every win and then every loss would hand the analytics a losing
    streak the length of `n_loss`, which is an artefact of the fixture and not
    of anything under test. Alternating keeps streaks in the range real trading
    produces.
    """
    out: list[PaperTrade] = []
    wins, losses = n_win, n_loss
    i = 0
    while wins or losses:
        if wins:
            out.append(trade(r="2", pnl="200", i=i, **kw))
            wins -= 1
            i += 1
        if losses:
            out.append(trade(r="-1", pnl="-100", reason="stop_loss", i=i, **kw))
            losses -= 1
            i += 1
    return out


# --- the statistics ---------------------------------------------------------


def test_five_wins_out_of_five_is_not_certainty():
    """The normal approximation returns [1.0, 1.0] here — a claim of certainty
    from five coin flips. Wilson is used precisely because it refuses to."""
    low, high = wilson_interval(5, 5)
    assert high == 1.0
    assert low < 0.7, f"a 5/5 sample should admit real doubt, got low={low}"


def test_a_large_sample_narrows_the_interval():
    small = wilson_interval(12, 20)
    large = wilson_interval(120, 200)
    assert (large[1] - large[0]) < (small[1] - small[0]) / 2


def test_no_trades_means_the_whole_range_not_zero():
    """Zero wins out of zero is unknown, not 0%. Reporting 0% would be a claim."""
    assert wilson_interval(0, 0) == (0.0, 1.0)


# --- breakdown --------------------------------------------------------------


def test_a_small_group_is_flagged_and_never_ranked_above_a_real_one():
    trades = wins_and_losses(30, 20, symbol="BTCUSDT")
    # A tiny, perfect sample — the exact shape that fools a naive table.
    trades += [trade(symbol="SOLUSDT", r="3", pnl="300", i=100 + i) for i in range(4)]

    groups = breakdown(trades, "symbol", START)
    by_key = {g.key: g for g in groups}

    assert by_key["SOLUSDT"].performance.win_rate == Decimal("100.00")
    assert by_key["SOLUSDT"].reliable is False
    assert str(MIN_SAMPLE) in by_key["SOLUSDT"].note
    assert groups[0].key == "BTCUSDT", "the underpowered group outranked the real one"


def test_shares_account_for_every_closed_trade():
    trades = wins_and_losses(10, 10, symbol="BTCUSDT") + wins_and_losses(5, 5, symbol="ETHUSDT")
    groups = breakdown(trades, "symbol", START)
    assert sum(g.share_pct for g in groups) == Decimal("100.00")


def test_open_trades_are_excluded_from_every_cut():
    """An open position has no result yet. Counting it as anything is inventing
    an outcome."""
    trades = wins_and_losses(20, 10)
    still_open = trade(i=999)
    still_open.status = "open"
    still_open.result = None
    trades.append(still_open)

    groups = breakdown(trades, "symbol", START)
    assert groups[0].performance.total_trades == 30


def test_confidence_bands_group_by_the_score_that_opened_the_trade():
    trades = [trade(confidence="76", i=i) for i in range(3)]
    trades += [trade(confidence="84", i=10 + i) for i in range(3)]
    trades += [trade(confidence="95", i=20 + i) for i in range(3)]
    keys = {g.key for g in breakdown(trades, "confidence", START)}
    assert keys == {"75-79", "80-84", "90+"}


def test_every_documented_dimension_actually_works():
    trades = wins_and_losses(10, 5)
    from app.analytics.breakdown import KEYS

    for dimension in KEYS:
        groups = breakdown(trades, dimension, START)
        assert groups, f"{dimension} produced no groups"


def test_an_unknown_dimension_is_refused_rather_than_silently_empty():
    with pytest.raises(ValueError, match="unknown breakdown dimension"):
        breakdown(wins_and_losses(5, 5), "phase_of_moon", START)


# --- insights ---------------------------------------------------------------


def test_too_few_trades_produces_a_refusal_not_a_finding():
    found = observe(wins_and_losses(5, 2), START)
    assert len(found) == 1
    assert found[0].strength == "insufficient"
    assert "not yet enough" in found[0].finding


def test_no_observation_is_ever_marked_applied():
    trades = wins_and_losses(40, 30, symbol="BTCUSDT")
    trades += wins_and_losses(3, 25, symbol="XRPUSDT")
    for observation in observe(trades, START):
        assert observation.to_dict()["applied"] is False
        assert "Human review" in observation.to_dict()["requires"]
    assert APPLIED is False


def test_an_inverted_confidence_score_is_reported_as_the_serious_finding():
    """If the trades the engine rated highest do worst, the gate is selecting
    the wrong setups — and that outranks every other observation here."""
    trades = [trade(confidence="76", r="3", pnl="300", i=i) for i in range(25)]
    trades += [
        trade(confidence="95", r="-1", pnl="-100", reason="stop_loss", i=100 + i) for i in range(25)
    ]

    found = {o.topic: o for o in observe(trades, START)}
    assert "confidence" in found
    assert "inverted" in found["confidence"].finding
    assert "factor weights" in found["confidence"].consider


def test_a_well_ordered_confidence_score_suggests_no_change():
    trades = [
        trade(confidence="76", r="-1", pnl="-100", reason="stop_loss", i=i) for i in range(25)
    ]
    trades += [trade(confidence="95", r="3", pnl="300", i=100 + i) for i in range(25)]

    found = {o.topic: o for o in observe(trades, START)}
    assert "outperforming" in found["confidence"].finding
    assert found["confidence"].consider.startswith("Nothing")


def test_a_losing_symbol_is_named_but_not_condemned():
    trades = wins_and_losses(40, 20, symbol="BTCUSDT")
    trades += wins_and_losses(5, 35, symbol="XRPUSDT")

    found = [o for o in observe(trades, START) if o.topic == "symbol"]
    assert [o for o in found if "XRPUSDT" in o.finding]
    loser = next(o for o in found if "XRPUSDT" in o.finding)
    assert "curve-fitting" in loser.consider, (
        "naming a losing symbol without naming the risk of dropping it is half the advice"
    )


def test_a_quiet_ledger_says_so_rather_than_inventing_something():
    found = observe(wins_and_losses(15, 15), START)
    assert any("stands out" in o.finding for o in found)


# --- the constraint that matters -------------------------------------------


def test_the_analytics_package_cannot_reach_the_engine():
    """The spec's hard rule: the system must not tune itself on its own results.

    This is enforced structurally rather than by intent — the analytics package
    imports nothing from scoring, risk or execution, so there is no path by
    which an observation could become a parameter change.
    """
    forbidden = ("app.signals", "app.risk", "app.paper.engine", "app.paper.runner")
    package = Path(__file__).resolve().parents[1] / "app" / "analytics"

    for source in package.glob("*.py"):
        tree = ast.parse(source.read_text())
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module]
            for name in names:
                assert not any(name.startswith(f) for f in forbidden), (
                    f"{source.name} imports {name}: analytics must not be able to "
                    "reach the engine it is measuring"
                )


def test_a_win_rate_decided_by_the_grouping_is_not_reported_as_a_finding():
    """Every take-profit exit is a win by construction. Printing "take_profit:
    100% win rate" restates the definition in the costume of evidence."""
    trades = wins_and_losses(30, 20)
    groups = {g.key: g for g in breakdown(trades, "exit_reason", START)}

    tp = groups["take_profit"]
    assert tp.performance.win_rate == Decimal("100.00")
    assert tp.win_rate_low is None and tp.win_rate_high is None
    assert tp.to_dict()["win_rate_ci"] is None
    assert "fixed by the exit type" in tp.note

    # And the ranking follows share, not an expectancy the key already decided.
    order = [g.key for g in breakdown(trades, "exit_reason", START)]
    assert order[0] == "take_profit"  # 30 of 50, the largest share


def test_targets_the_plan_never_reaches_are_named():
    """A plan that projects 3R and delivers 1.5R is not a winning strategy with
    a small flaw — it is a different strategy from the one being reported."""
    trades = wins_and_losses(30, 10)
    for t in trades:
        t.reward_risk = Decimal("3")  # every plan projected 3R

    found = {o.topic: o for o in observe(trades, START)}
    assert "targets" in found, "winners realising 2R against a planned 3R went unreported"
    assert "3.00R" in found["targets"].evidence
    assert "exit-reason breakdown" in found["targets"].consider


def test_targets_that_are_being_reached_produce_no_complaint():
    trades = wins_and_losses(30, 10)
    for t in trades:
        t.reward_risk = Decimal("2")  # matches the 2R the winners actually got

    assert "targets" not in {o.topic for o in observe(trades, START)}


def test_cost_drag_is_reported_when_fees_eat_the_winners():
    trades = wins_and_losses(20, 20)
    for t in trades:
        t.fees = Decimal("60")  # 20 winners at 200 gross; 40 trades at 60 = 2400 in fees

    found = {o.topic: o for o in observe(trades, START)}
    assert "costs" in found
    assert "how often the bot trades" in found["costs"].consider


# --- versus holding ---------------------------------------------------------


def _candles(n: int, first_close: float, last_close: float, start: datetime):
    from app.market_data.schemas import Candle
    from app.market_data.timeframes import Timeframe

    step = (last_close - first_close) / max(n - 1, 1)
    return [
        Candle(
            symbol="BTCUSDT",
            timeframe=Timeframe.D1,
            open_time=start + timedelta(days=i),
            open=Decimal(str(round(first_close + step * i, 8))),
            high=Decimal(str(round(first_close + step * i + 1, 8))),
            low=Decimal(str(round(first_close + step * i - 1, 8))),
            close=Decimal(str(round(first_close + step * i, 8))),
            volume=Decimal("10"),
            closed=True,
        )
        for i in range(n)
    ]


def test_the_hold_window_is_the_window_the_strategy_actually_traded():
    from app.analytics.benchmark import windows

    trades = [
        trade(symbol="BTCUSDT", i=0),
        trade(symbol="BTCUSDT", i=48),
        trade(symbol="ETHUSDT", i=10),
    ]
    spans = windows(trades)

    start, end = spans["BTCUSDT"]
    assert start == BASE
    assert end == BASE + timedelta(hours=49)
    assert set(spans) == {"BTCUSDT", "ETHUSDT"}


def test_an_open_trade_does_not_stretch_the_window():
    from app.analytics.benchmark import windows

    closed = trade(symbol="BTCUSDT", i=0)
    still_open = trade(symbol="BTCUSDT", i=500)
    still_open.status = "open"
    still_open.closed_at = None

    _, end = windows([closed, still_open])["BTCUSDT"]
    assert end == BASE + timedelta(hours=1)


def test_holding_is_measured_from_the_open_of_the_window_to_its_close():
    from app.analytics.benchmark import hold_return

    candles = _candles(30, 100.0, 200.0, BASE)
    pct, covered = hold_return(candles, BASE, BASE + timedelta(days=29))

    assert covered is True
    assert pct == Decimal("100.00")


def test_price_history_that_starts_too_late_is_flagged_not_quietly_used():
    """Measuring a six-week strategy against four weeks of the asset and calling
    it a comparison is the failure this flag exists to prevent."""
    from app.analytics.benchmark import hold_return

    candles = _candles(20, 100.0, 150.0, BASE + timedelta(days=10))
    pct, covered = hold_return(candles, BASE, BASE + timedelta(days=29))

    assert pct is not None
    assert covered is False


def test_no_price_history_means_no_comparison_rather_than_a_zero():
    from app.analytics.benchmark import build, hold_return

    assert hold_return([], BASE, BASE + timedelta(days=5)) == (None, False)

    rows = build(wins_and_losses(10, 5), {}, START)
    assert rows[0].hold_return_pct is None
    assert "cannot be measured" in rows[0].note


def test_the_two_returns_are_never_subtracted_from_each_other():
    """They have different denominators — price versus account. A single
    "outperformance" number would be arithmetic on incompatible units."""
    from app.analytics.benchmark import DENOMINATOR_NOTE, build

    rows = build(
        wins_and_losses(10, 5),
        {"BTCUSDT": _candles(30, 100.0, 200.0, BASE)},
        START,
    )
    payload = rows[0].to_dict()

    assert "hold_return_pct" in payload and "strategy_return_pct" in payload
    assert not any("vs" in k or "difference" in k or "beat" in k for k in payload)
    assert "different questions" in DENOMINATOR_NOTE
