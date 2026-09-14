"""Resampling and the higher-timeframe check.

Two properties carry the weight here: a resampled candle must match the one the
venue would have published, and the penalty must be able to veto a setup that
would otherwise have been taken.
"""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.analysis.resample import HIGHER_TIMEFRAME, SECONDS, resample
from app.analysis.series import Series
from app.analysis.trend import Trend, TrendReading
from app.signals.analyzer import analyse, build_signal
from app.signals.confluence import (
    ALIGNED,
    MIN_HIGHER_BARS,
    STRONGLY_AGAINST,
    Confluence,
    apply,
    assess,
)

BASE = datetime(2026, 1, 1, tzinfo=UTC)


def series(closes: list[float], *, start: datetime = BASE, hours: int = 1) -> Series:
    return Series(
        open=[c * 0.999 for c in closes],
        high=[c * 1.004 for c in closes],
        low=[c * 0.996 for c in closes],
        close=closes[:],
        volume=[100.0] * len(closes),
        times=[start + timedelta(hours=i * hours) for i in range(len(closes))],
        closed=[True] * len(closes),
    )


def walk(n: int, seed: int, drift: float = 0.0) -> list[float]:
    rng = random.Random(seed)
    price = 100.0
    out = []
    for _ in range(n):
        price *= 1 + drift + rng.uniform(-0.006, 0.006)
        out.append(price)
    return out


# --- resampling -------------------------------------------------------------


def test_a_resampled_candle_is_open_first_high_max_low_min_close_last():
    """Hand-checked against the definition, not against the code's own output."""
    closes = [100.0, 110.0, 90.0, 105.0, 200.0, 210.0, 190.0, 205.0]
    source = series(closes)

    coarse = resample(source, "4h")

    assert len(coarse) == 2
    assert coarse.open[0] == source.open[0]
    assert coarse.high[0] == max(source.high[:4])
    assert coarse.low[0] == min(source.low[:4])
    assert coarse.close[0] == source.close[3]
    assert coarse.volume[0] == sum(source.volume[:4])


def test_buckets_are_aligned_to_the_clock_not_to_the_start_of_the_data():
    """Grouping every four bars from wherever the array begins produces a "4h
    candle" spanning 01:00-05:00, whose close is a price no chart shows."""
    # Starts at 02:00, so the first two bars belong to the 00:00-04:00 bucket.
    offset = BASE + timedelta(hours=2)
    source = series(walk(48, seed=1), start=offset)

    coarse = resample(source, "4h")

    for at in coarse.times:
        assert at.hour % 4 == 0, f"bucket starts at {at.hour}:00, off the 4h grid"


def test_an_incomplete_final_bucket_is_dropped():
    """The 4h candle containing the current hour has not closed: its high, low
    and close can all still move. Using it is the forming-bar mistake one level
    up."""
    source = series(walk(10, seed=2))  # 2 complete 4h buckets, then 2 spare bars

    coarse = resample(source, "4h")

    assert len(coarse) == 2
    assert coarse.times[-1] == BASE + timedelta(hours=4)


def test_a_bucket_containing_a_forming_bar_is_dropped():
    source = series(walk(8, seed=3))
    source.closed[-1] = False

    coarse = resample(source, "4h")

    assert len(coarse) == 1, "the bucket holding the forming bar was kept"


def test_upsampling_returns_nothing_rather_than_inventing_bars():
    """Going finer would have to invent the bars in between."""
    source = series(walk(40, seed=4))
    assert len(resample(source, "15m")) == 0
    assert len(resample(source, "1h")) == 0


def test_one_missing_bar_does_not_change_the_inferred_interval():
    """The most common gap is used rather than the first: a single hole would
    otherwise double the inferred interval and halve every bucket."""
    closes = walk(40, seed=5)
    full = series(closes)
    gapped = Series(
        open=full.open[:10] + full.open[11:],
        high=full.high[:10] + full.high[11:],
        low=full.low[:10] + full.low[11:],
        close=full.close[:10] + full.close[11:],
        volume=full.volume[:-1],
        times=full.times[:10] + full.times[11:],
        closed=[True] * (len(closes) - 1),
    )

    # The bucket with the hole is incomplete and dropped; every other one
    # survives, which it would not if the interval had been read as 2h.
    assert len(resample(gapped, "4h")) == len(resample(full, "4h")) - 1


def test_every_timeframe_maps_to_a_coarser_one_or_to_nothing():
    for lower, higher in HIGHER_TIMEFRAME.items():
        if not higher:
            continue
        assert SECONDS[higher] > SECONDS[lower], f"{lower} -> {higher} is not coarser"


# --- the judgement ----------------------------------------------------------


def reading(trend: Trend) -> TrendReading:
    return TrendReading(
        trend=trend,
        ema20=1.0,
        ema50=1.0,
        ema200=1.0,
        price_vs_ema200_pct=0.0,
        evidence=(),
    )


def test_a_long_with_the_higher_trend_is_not_penalised():
    result = assess(series(walk(300, seed=6, drift=0.0015)), "1h", "LONG")
    assert result.agreement == "aligned"
    assert result.multiplier == ALIGNED


def test_a_long_into_a_higher_downtrend_is_penalised():
    result = assess(series(walk(300, seed=7, drift=-0.0015)), "1h", "LONG")
    assert result.agreement in ("against", "strongly-against")
    assert result.multiplier < 1.0
    assert "trading against" in result.note


def test_strong_opposition_can_veto_a_setup_that_would_otherwise_qualify():
    """The property that makes this worth having. A setup at 85 — comfortably
    over the floor — must not be taken into a decisive higher-timeframe trend."""
    against = Confluence(
        timeframe="1h",
        higher_timeframe="4h",
        agreement="strongly-against",
        multiplier=STRONGLY_AGAINST,
        higher_trend="strong_down",
        bars=75,
        note="",
    )
    assert apply(85.0, against) < 75.0


def test_alignment_never_raises_confidence():
    """The seven dimensions already measured how good the evidence is. A higher
    timeframe agreeing does not make it stronger — it just fails to contradict
    it — and paying a bonus would inflate confidence past what was measured."""
    aligned = Confluence(
        timeframe="1h",
        higher_timeframe="4h",
        agreement="aligned",
        multiplier=ALIGNED,
        higher_trend="up",
        bars=75,
        note="",
    )
    assert apply(80.0, aligned) == 80.0
    assert ALIGNED == 1.0


def test_confidence_is_never_pushed_past_one_hundred():
    generous = Confluence(
        timeframe="1h",
        higher_timeframe="4h",
        agreement="aligned",
        multiplier=2.0,
        higher_trend="up",
        bars=75,
        note="",
    )
    assert apply(99.0, generous) == 100.0


# --- refusing to guess ------------------------------------------------------


def test_too_little_history_is_unavailable_and_costs_nothing():
    """Docking confidence for data the engine does not have would punish the
    newest listings hardest, for a fact about the feed rather than the setup."""
    result = assess(series(walk(80, seed=8)), "1h", "LONG")

    assert result.agreement == "unavailable"
    assert result.multiplier == ALIGNED
    assert str(MIN_HIGHER_BARS) in result.note


def test_the_highest_timeframe_has_nothing_above_it_to_check():
    result = assess(series(walk(300, seed=9), hours=24), "1d", "LONG")
    assert result.agreement == "unavailable"
    assert "highest timeframe" in result.note


def test_an_undecided_higher_trend_neither_supports_nor_opposes():
    """A directionless market, which is a random walk with no drift.

    The first version of this used a repeating sawtooth as "flat"; resampling by
    four aliased it into a rising staircase and the 4h read came back bullish.
    Aliasing is a real property of resampling, and the fixture has to avoid it
    rather than the code pretending it does not exist.
    """
    result = assess(series(walk(300, seed=1, drift=0.0)), "1h", "LONG")

    assert result.agreement == "undecided"
    assert result.higher_trend == "neutral"
    assert 0.9 <= result.multiplier < 1.0
    assert "neither supports" in result.note


# --- the signal it produces -------------------------------------------------


def signal_for(closes: list[float]):
    analysis = analyse(series(closes), "BTCUSDT", "1h")
    assert analysis is not None
    return build_signal(analysis, balance=Decimal("10000"), risk_pct=Decimal("1"))


def test_the_signal_publishes_both_numbers_and_the_reason_quotes_the_final_one():
    """A card that prints "confidence 82" above "confidence 75 is below the 75
    floor" is the self-contradiction this reporting exists to prevent."""
    sig = signal_for(walk(300, seed=10, drift=-0.0015))

    before = sig.evidence["confidence_before_confluence"]
    after = sig.confidence
    assert "confluence" in sig.evidence

    if sig.decision == "NO_TRADE" and after < 75:
        assert f"confidence {after:.0f}" in sig.reason
        if after < before:
            assert "cut from" in sig.reason


def test_a_counter_trend_trade_carries_a_warning_naming_the_timeframe():
    sig = signal_for(walk(300, seed=11, drift=-0.0015))
    confluence = sig.evidence["confluence"]

    if confluence["multiplier"] < 1.0 and confluence["agreement"] != "undecided":
        assert "against-4h-trend" in sig.warnings


def test_the_check_is_reported_even_when_it_changes_nothing():
    """ "No penalty" and "not checked" are different facts, and a reader has to
    be able to tell them apart."""
    sig = signal_for(walk(300, seed=12, drift=0.0015))
    confluence = sig.evidence["confluence"]

    assert confluence["agreement"] in {
        "aligned",
        "against",
        "strongly-against",
        "undecided",
        "unavailable",
    }
    assert confluence["bars"] >= 0
    assert confluence["higher_timeframe"] == "4h"


def test_the_higher_timeframe_is_derived_from_the_same_candles():
    """No extra fetch, and — the part that matters for the backtester — nothing
    the visible window could not already see."""
    closes = walk(300, seed=13, drift=0.001)
    analysis = analyse(series(closes), "BTCUSDT", "1h")

    assert analysis.series is not None
    assert len(analysis.series) == len(closes)
    assert len(resample(analysis.series, "4h")) == len(closes) // 4
