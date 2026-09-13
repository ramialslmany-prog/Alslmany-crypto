"""Correlation and portfolio heat.

The point of this module is a number the account already had and could not see:
five positions at 1% each are not a 5% risk unless they are independent, and in
crypto they never are.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.analysis.correlation import (
    ASSUMED_CORRELATION,
    MIN_OVERLAP,
    Exposure,
    aligned_returns,
    correlate,
    matrix,
    pearson,
    portfolio_heat,
    returns,
    series_window,
)
from app.analysis.series import Series

BASE = datetime(2026, 1, 1, tzinfo=UTC)
EQUITY = Decimal("10000")


def series(closes: list[float], *, start: datetime = BASE, step_hours: int = 1) -> Series:
    times = [start + timedelta(hours=i * step_hours) for i in range(len(closes))]
    return Series(
        open=closes[:],
        high=[c * 1.001 for c in closes],
        low=[c * 0.999 for c in closes],
        close=closes[:],
        volume=[1000.0] * len(closes),
        times=times,
        closed=[True] * len(closes),
    )


def walk(n: int, seed: int, drift: float = 0.0) -> list[float]:
    import random

    rng = random.Random(seed)
    price = 100.0
    out = []
    for _ in range(n):
        price *= 1 + drift + rng.uniform(-0.02, 0.02)
        out.append(price)
    return out


# --- returns, not prices ----------------------------------------------------


def test_two_unrelated_assets_that_both_trend_up_are_not_called_correlated():
    """The defect this module exists to avoid.

    Correlating PRICES here gives a number close to 1 — both series climb, and
    the shared trend swamps everything else. Correlating returns asks the
    question actually being asked: do they move together day to day?
    """
    a = series(walk(200, seed=1, drift=0.004))
    b = series(walk(200, seed=99, drift=0.004))

    price_rho = pearson(a.close, b.close)
    return_rho = correlate(a, b)

    assert price_rho is not None and price_rho > 0.8, (
        "the fixture does not reproduce the trap it is meant to demonstrate"
    )
    assert return_rho is not None
    assert abs(return_rho) < 0.3, f"returns should be near-independent, got {return_rho}"


def test_a_series_correlates_perfectly_with_itself():
    a = series(walk(120, seed=5))
    assert correlate(a, a) == 1.0


def test_an_inverted_series_correlates_at_minus_one():
    closes = walk(120, seed=6)
    inverted = [200 - c for c in closes]
    rho = correlate(series(closes), series(inverted))
    assert rho is not None and rho < -0.98


def test_a_pair_with_a_zero_close_drops_that_step_rather_than_dividing():
    assert returns([100.0, 0.0, 50.0]) == [-1.0]


# --- alignment --------------------------------------------------------------


def test_bars_are_matched_by_timestamp_not_by_position():
    """A venue that dropped a bar shifts everything after it. Zipping by index
    there correlates Tuesday against Wednesday and reports it as a finding."""
    closes = walk(80, seed=7)
    full = series(closes)

    # Same market, one bar missing in the middle.
    gapped = Series(
        open=closes[:40] + closes[41:],
        high=closes[:40] + closes[41:],
        low=closes[:40] + closes[41:],
        close=closes[:40] + closes[41:],
        volume=[1000.0] * (len(closes) - 1),
        times=full.times[:40] + full.times[41:],
        closed=[True] * (len(closes) - 1),
    )

    a, b = aligned_returns(full, gapped)
    assert len(a) == len(b)
    # Every shared bar still lines up, so the correlation stays perfect.
    assert correlate(full, gapped) == 1.0


def test_series_that_share_no_bars_produce_nothing():
    a = series(walk(60, seed=8), start=BASE)
    b = series(walk(60, seed=9), start=BASE + timedelta(days=365))
    assert correlate(a, b) is None


# --- refusing to guess ------------------------------------------------------


def test_too_few_overlapping_bars_is_unknown_rather_than_zero():
    """A spurious low correlation is worse than none: it tells the risk manager
    that five identical bets are safely spread out."""
    short = walk(MIN_OVERLAP - 5, seed=10)
    assert pearson(short, short) is None


def test_a_flat_series_has_no_correlation_with_anything():
    flat = [100.0] * 100
    assert pearson(flat, walk(100, seed=11)) is None


def test_an_unmeasurable_pair_is_absent_from_the_matrix_not_zero():
    long_enough = series(walk(100, seed=12))
    too_short = series(walk(10, seed=13))

    result = matrix({"BTCUSDT": long_enough, "TINYUSDT": too_short})
    assert ("BTCUSDT", "TINYUSDT") not in result
    assert result == {}


def test_the_matrix_is_symmetric():
    result = matrix({"A": series(walk(100, seed=14)), "B": series(walk(100, seed=15))})
    assert result[("A", "B")] == result[("B", "A")]


# --- portfolio heat ---------------------------------------------------------


def two(direction_b: str = "LONG", risk: str = "100") -> list[Exposure]:
    return [
        Exposure("BTCUSDT", "LONG", Decimal(risk)),
        Exposure("ETHUSDT", direction_b, Decimal(risk)),
    ]


def rho(value: float) -> dict[tuple[str, str], float]:
    return {("BTCUSDT", "ETHUSDT"): value, ("ETHUSDT", "BTCUSDT"): value}


def test_perfectly_correlated_positions_are_one_position():
    """The formula must collapse to the plain sum here, or it is not measuring
    what it claims to."""
    heat = portfolio_heat(two(), rho(1.0), EQUITY)
    assert heat.naive_risk == Decimal("200.00")
    assert heat.effective_risk == Decimal("200.00")
    assert heat.concentration == Decimal("1.000")


def test_independent_positions_combine_to_less_than_their_sum():
    heat = portfolio_heat(two(), rho(0.0), EQUITY)
    assert heat.effective_risk == Decimal("141.42")  # sqrt(2) * 100
    assert heat.effective_pct == Decimal("1.41")


def test_five_independent_one_percent_positions_are_not_a_five_percent_risk():
    exposures = [Exposure(f"SYM{i}USDT", "LONG", Decimal("100")) for i in range(5)]
    zeros = {
        (a.symbol, b.symbol): 0.0 for a in exposures for b in exposures if a.symbol != b.symbol
    }
    heat = portfolio_heat(exposures, zeros, EQUITY)

    assert heat.naive_risk == Decimal("500.00")
    assert heat.effective_pct == Decimal("2.24")  # sqrt(5) * 100 / 10000


def test_opposite_directions_are_a_hedge_not_a_concentration():
    """Long BTC against short ETH at rho = +0.9 offsets. Using the raw
    coefficient would report the safest book in the system as the most
    dangerous."""
    hedged = portfolio_heat(two(direction_b="SHORT"), rho(0.9), EQUITY)
    aligned = portfolio_heat(two(direction_b="LONG"), rho(0.9), EQUITY)

    assert hedged.effective_risk < aligned.effective_risk
    assert hedged.effective_risk < Decimal("100")  # less than either leg alone


def test_a_perfect_hedge_never_reports_negative_risk():
    heat = portfolio_heat(two(direction_b="SHORT"), rho(1.0), EQUITY)
    assert heat.effective_risk == Decimal("0.00")


def test_an_unmeasured_pair_is_assumed_correlated_and_said_so():
    """Guessing low would switch the limit off exactly when it is least
    measurable, which is when a new listing joins the book."""
    heat = portfolio_heat(two(), {}, EQUITY)

    assert heat.assumed_pairs == ("BTCUSDT/ETHUSDT",)
    assert heat.concentration > Decimal("0.95")
    assert ASSUMED_CORRELATION >= 0.9


def test_the_worst_pair_is_named_so_the_operator_knows_which_two():
    exposures = [
        Exposure("BTCUSDT", "LONG", Decimal("100")),
        Exposure("ETHUSDT", "LONG", Decimal("100")),
        Exposure("XRPUSDT", "LONG", Decimal("100")),
    ]
    correlations = {
        ("BTCUSDT", "ETHUSDT"): 0.95,
        ("ETHUSDT", "BTCUSDT"): 0.95,
        ("BTCUSDT", "XRPUSDT"): 0.20,
        ("XRPUSDT", "BTCUSDT"): 0.20,
        ("ETHUSDT", "XRPUSDT"): 0.15,
        ("XRPUSDT", "ETHUSDT"): 0.15,
    }
    heat = portfolio_heat(exposures, correlations, EQUITY)

    assert heat.worst_pair == ("BTCUSDT", "ETHUSDT", 0.95)


def test_an_empty_book_is_zero_rather_than_an_error():
    heat = portfolio_heat([], {}, EQUITY)
    assert heat.effective_risk == Decimal(0)
    assert heat.to_dict()["worst_pair"] is None


# --- the rolling window -----------------------------------------------------


def test_the_window_keeps_the_most_recent_bars():
    full = series(walk(500, seed=20))
    window = series_window(full, 100)

    assert len(window) == 100
    assert window.times[-1] == full.times[-1]
    assert window.close[-1] == full.close[-1]


def test_a_window_longer_than_the_series_returns_it_unchanged():
    full = series(walk(40, seed=21))
    assert series_window(full, 240) is full
