"""Indicator tests, verified against values derived independently of the code.

Every expectation here is either computed from first principles inside the test
or taken from a published worked example. Asserting an indicator against its own
output only proves it is deterministic — a formula can be confidently, stably
wrong.
"""

from __future__ import annotations

import math

import pytest

from app.analysis.levels import SwingKind, find_levels, find_swings
from app.analysis.momentum import macd, rsi, rsi_series
from app.analysis.series import Series, to_series
from app.analysis.trend import (
    Trend,
    classify_trend,
    ema,
    ema_series,
    sma,
    sma_series,
)
from app.analysis.volatility import (
    Volatility,
    atr,
    bollinger,
    classify_volatility,
    true_range,
)
from app.analysis.volume import analyse_volume, obv, vwap

# Wilder's worked example, "New Concepts in Technical Trading Systems" (1978).
WILDER_CLOSE = [
    44.3389,
    44.0902,
    44.1497,
    43.6124,
    44.3278,
    44.8264,
    45.0955,
    45.4245,
    45.8433,
    46.0826,
    45.8931,
    46.0328,
    45.6140,
    46.2820,
    46.2820,
    46.0028,
    46.0328,
    46.4116,
    46.2222,
    45.6439,
    46.2122,
    46.2521,
    45.7137,
    46.4515,
    45.7835,
    45.3548,
    44.0288,
    44.1783,
    44.2181,
    44.5672,
    43.4205,
    42.6628,
    43.1314,
]


# --- RSI -------------------------------------------------------------------


def test_first_rsi_matches_a_hand_calculation_not_a_lookup_table():
    """Derived here from the definition, using none of the code under test.

    A published table was wrong about this value by 0.07 and would have had me
    "fix" correct code to match it. The arithmetic is the authority.
    """
    changes = [WILDER_CLOSE[i] - WILDER_CLOSE[i - 1] for i in range(1, 15)]
    avg_gain = sum(c for c in changes if c > 0) / 14
    avg_loss = sum(-c for c in changes if c < 0) / 14
    expected = 100 - 100 / (1 + avg_gain / avg_loss)

    assert expected == pytest.approx(70.5328, abs=0.001)
    assert rsi_series(WILDER_CLOSE, 14)[14] == pytest.approx(expected, abs=1e-9)


def test_the_second_rsi_applies_wilders_smoothing_not_an_ema():
    """Wilder's multiplier is 1/period; an EMA of the same period uses
    2/(period+1) — for 14 that is 0.071 against 0.133, nearly double."""
    changes = [WILDER_CLOSE[i] - WILDER_CLOSE[i - 1] for i in range(1, 15)]
    avg_gain = sum(c for c in changes if c > 0) / 14
    avg_loss = sum(-c for c in changes if c < 0) / 14

    change = WILDER_CLOSE[15] - WILDER_CLOSE[14]
    avg_gain = (avg_gain * 13 + max(change, 0.0)) / 14
    avg_loss = (avg_loss * 13 + max(-change, 0.0)) / 14
    expected = 100 - 100 / (1 + avg_gain / avg_loss)

    assert expected == pytest.approx(66.3186, abs=0.001)
    assert rsi_series(WILDER_CLOSE, 14)[15] == pytest.approx(expected, abs=1e-9)


def test_the_published_series_is_reproduced_within_table_rounding():
    """The remaining published values, which agree once the smoothing has run
    long enough for 1978's rounded intermediates to wash out."""
    published = [
        66.549,
        69.407,
        66.354,
        57.975,
        62.929,
        63.259,
        56.059,
        62.377,
        54.707,
        50.429,
        39.989,
        41.463,
        41.868,
        45.463,
        37.302,
        33.084,
        37.775,
    ]
    computed = rsi_series(WILDER_CLOSE, 14)[16:]

    assert len(computed) == len(published)
    for expected, got in zip(published, computed, strict=True):
        assert got == pytest.approx(expected, abs=0.01)


def test_rsi_is_none_until_it_has_enough_data():
    """Never 0.0 — that reads as "extremely oversold" to every downstream check,
    which is the most dangerous possible way to say "I don't know"."""
    assert rsi([1.0, 2.0, 3.0], 14) is None
    series = rsi_series(WILDER_CLOSE, 14)
    assert all(v is None for v in series[:14])
    assert series[14] is not None


def test_an_unbroken_run_of_gains_is_100_not_a_division_by_zero():
    assert rsi([float(i) for i in range(1, 30)], 14) == pytest.approx(100.0)


def test_an_unbroken_run_of_losses_is_0():
    assert rsi([float(i) for i in range(30, 1, -1)], 14) == pytest.approx(0.0)


# --- moving averages -------------------------------------------------------


def test_sma_is_the_arithmetic_mean_of_the_window():
    values = [2.0, 4.0, 6.0, 8.0, 10.0]
    assert sma(values, 5) == pytest.approx(6.0)
    assert sma(values, 3) == pytest.approx(8.0)  # (6+8+10)/3
    assert sma(values, 6) is None


def test_the_rolling_sma_matches_a_naive_recomputation():
    """The rolling update is O(n); a bug in it would be invisible on a chart."""
    values = [float((i * 37) % 100) for i in range(200)]
    rolled = sma_series(values, 20)
    for i in range(19, len(values)):
        assert rolled[i] == pytest.approx(sum(values[i - 19 : i + 1]) / 20)


def test_ema_is_seeded_with_an_sma_and_then_follows_the_definition():
    values = [float(i) for i in range(1, 21)]
    series = ema_series(values, 10)

    assert series[9] == pytest.approx(sum(values[:10]) / 10)  # seed
    multiplier = 2 / 11
    expected = series[9] + (values[10] - series[9]) * multiplier
    assert series[10] == pytest.approx(expected)


def test_ema_reacts_faster_than_sma_to_a_jump():
    values = [10.0] * 30 + [20.0] * 5
    assert ema(values, 10) > sma(values, 10)


# --- MACD ------------------------------------------------------------------


def test_macd_line_is_the_gap_between_the_two_emas():
    values = [float(100 + math.sin(i / 5) * 10) for i in range(120)]
    result = macd(values)

    assert result is not None
    fast = ema(values, 12)
    slow = ema(values, 26)
    assert result.macd == pytest.approx(fast - slow)
    assert result.histogram == pytest.approx(result.macd - result.signal)


def test_macd_needs_enough_history_for_the_signal_line():
    """Padding the leading bars with zeros would drag the early signal toward
    zero and manufacture a crossover that never happened."""
    assert macd([float(i) for i in range(30)]) is None


def test_macd_is_positive_in_an_uptrend_and_negative_in_a_downtrend():
    up = [float(i) for i in range(1, 120)]
    down = [float(i) for i in range(120, 1, -1)]

    assert macd(up).macd > 0
    assert macd(down).macd < 0


# --- ATR -------------------------------------------------------------------


def test_true_range_counts_the_gap_against_the_previous_close():
    """A market that opens far from yesterday's close has moved that distance
    even though no single bar spans it."""
    high = [10.0, 20.0]
    low = [9.0, 19.0]
    close = [9.5, 19.5]

    tr = true_range(high, low, close)

    assert tr[0] == pytest.approx(1.0)  # first bar: high - low
    # |20 - 9.5| = 10.5 dominates the 1.0 intrabar range.
    assert tr[1] == pytest.approx(10.5)


def test_atr_of_a_constant_range_is_that_range():
    high = [11.0] * 30
    low = [10.0] * 30
    close = [10.5] * 30
    assert atr(high, low, close, 14) == pytest.approx(1.0)


def test_atr_uses_wilders_smoothing():
    high = [float(10 + i % 3) for i in range(40)]
    low = [float(8 + i % 3) for i in range(40)]
    close = [float(9 + i % 3) for i in range(40)]

    tr = true_range(high, low, close)
    expected = sum(tr[:14]) / 14
    for i in range(14, len(tr)):
        expected = (expected * 13 + tr[i]) / 14

    assert atr(high, low, close, 14) == pytest.approx(expected)


def test_atr_is_none_without_enough_bars():
    assert atr([1.0], [1.0], [1.0], 14) is None


# --- Bollinger -------------------------------------------------------------


def test_bollinger_bands_sit_two_population_deviations_from_the_mean():
    values = [float(i) for i in range(1, 21)]
    band = bollinger(values, 20, 2.0)

    mean = sum(values) / 20
    sd = math.sqrt(sum((v - mean) ** 2 for v in values) / 20)

    assert band.middle == pytest.approx(mean)
    assert band.upper == pytest.approx(mean + 2 * sd)
    assert band.lower == pytest.approx(mean - 2 * sd)


def test_percent_b_locates_price_within_the_bands():
    values = [10.0] * 19 + [10.0]
    band = bollinger(values, 20)
    # A flat series has no width; the honest answer is the midpoint.
    assert band.percent_b == pytest.approx(0.5)


def test_a_flat_series_is_squeezed():
    assert bollinger([10.0] * 20).is_squeezed is True


# --- volatility regime -----------------------------------------------------


def test_a_dead_flat_market_is_not_reported_as_extreme_volatility():
    """Percentile rank alone calls a flat market "extreme" the instant it ticks
    above its own floor. Magnitude has to agree."""
    high = [100.0 + (i % 2) * 0.01 for i in range(200)]
    low = [100.0 - (i % 2) * 0.01 for i in range(200)]
    close = [100.0] * 200

    reading = classify_volatility(high, low, close)

    assert reading.regime is not Volatility.EXTREME
    assert reading.is_tradeable is True


def test_a_genuine_volatility_explosion_is_flagged_and_not_tradeable():
    high = [100.0 + 0.1] * 180 + [140.0] * 20
    low = [100.0 - 0.1] * 180 + [60.0] * 20
    close = [100.0] * 180 + [100.0] * 20

    reading = classify_volatility(high, low, close)

    assert reading.regime is Volatility.EXTREME
    assert reading.is_tradeable is False


# --- volume ----------------------------------------------------------------


def test_vwap_weights_price_by_volume():
    high = [10.0, 20.0]
    low = [10.0, 20.0]
    close = [10.0, 20.0]
    volume = [1.0, 3.0]
    # Typical prices 10 and 20, weights 1 and 3 -> (10 + 60) / 4
    assert vwap(high, low, close, volume) == pytest.approx(17.5)


def test_vwap_is_none_when_nothing_traded():
    assert vwap([1.0], [1.0], [1.0], [0.0]) is None


def test_obv_adds_volume_on_up_bars_and_subtracts_on_down_bars():
    close = [10.0, 11.0, 10.0, 10.0]
    volume = [100.0, 50.0, 30.0, 20.0]
    assert obv(close, volume) == [0.0, 50.0, 20.0, 20.0]


def test_the_current_bar_is_excluded_from_its_own_volume_baseline():
    """Including it pulls the average toward the value being judged and mutes
    exactly the spikes this is meant to detect."""
    volume = [100.0] * 25 + [1000.0]
    high = [10.0] * 26
    low = [9.0] * 26
    close = [9.5] * 26

    reading = analyse_volume(high, low, close, volume)

    assert reading.average == pytest.approx(100.0)
    assert reading.relative == pytest.approx(10.0)
    assert reading.confirms_move is True


def test_average_volume_does_not_confirm_a_move():
    volume = [100.0] * 30
    reading = analyse_volume([10.0] * 30, [9.0] * 30, [9.5] * 30, volume)
    assert reading.confirms_move is False


# --- trend -----------------------------------------------------------------


def test_a_clean_uptrend_reads_as_strongly_up_with_its_evidence():
    close = [float(i) for i in range(1, 300)]
    reading = classify_trend(close)

    assert reading.trend is Trend.STRONG_UP
    assert reading.is_bullish
    assert "price-above-ema200" in reading.evidence
    assert "ema50-above-ema200" in reading.evidence


def test_a_clean_downtrend_reads_as_strongly_down():
    close = [float(i) for i in range(300, 1, -1)]
    assert classify_trend(close).trend is Trend.STRONG_DOWN


def test_a_strong_verdict_is_unreachable_without_the_long_term_evidence():
    """With under 200 bars the 200 EMA does not exist, so the score cannot reach
    the extremes. A confident verdict must not be available on thin data."""
    close = [float(i) for i in range(1, 60)]
    reading = classify_trend(close)

    assert reading.ema200 is None
    assert reading.trend is Trend.UP  # not STRONG_UP


# --- levels ----------------------------------------------------------------


def test_a_double_top_registers_as_a_swing():
    """A symmetric strict comparison silently discards flat tops — which are
    exactly the formations that matter most for resistance."""
    high = [1, 2, 3, 5, 3, 2, 3, 5, 3, 2, 1]
    low = [float(v) for v in high]
    swings = find_swings([float(v) for v in high], low, lookback=2)

    tops = [s for s in swings if s.kind is SwingKind.HIGH]
    assert len(tops) >= 2
    assert all(t.price == pytest.approx(5.0) for t in tops)


def test_levels_split_around_the_current_price():
    high = [10, 12, 15, 12, 10, 12, 15, 12, 10, 8, 5, 8, 10, 9, 10]
    low = [8, 10, 12, 10, 8, 10, 12, 10, 8, 6, 3, 6, 8, 7, 8]
    close = [9, 11, 13, 11, 9, 11, 13, 11, 9, 7, 4, 7, 9, 8, 9]

    levels = find_levels(
        [float(v) for v in high], [float(v) for v in low], [float(v) for v in close]
    )

    for level in levels.support:
        assert level.price < close[-1]
    for level in levels.resistance:
        assert level.price > close[-1]


def test_a_level_touched_repeatedly_is_stronger():
    high = [float(v) for v in [1, 2, 5, 2, 1, 2, 5, 2, 1, 2, 5, 2, 1]]
    low = [float(v) for v in [1, 2, 5, 2, 1, 2, 5, 2, 1, 2, 5, 2, 1]]
    close = [float(v) for v in [1, 2, 5, 2, 1, 2, 5, 2, 1, 2, 5, 2, 1]]

    levels = find_levels(high, low, close)
    strongest = max(
        (level for level in levels.support + levels.resistance),
        key=lambda level: level.touches,
        default=None,
    )
    assert strongest is not None
    assert strongest.touches >= 2
    assert strongest.strength in ("confirmed", "major")


# --- series ----------------------------------------------------------------


def test_a_forming_bar_can_be_dropped_before_any_signal_is_computed():
    series = Series(
        open=[1.0, 2.0],
        high=[1.0, 2.0],
        low=[1.0, 2.0],
        close=[1.0, 2.0],
        volume=[1.0, 1.0],
        times=[],
        closed=[True, False],
    )
    assert len(series.closed_only()) == 1


def test_to_series_sorts_into_chronological_order(monkeypatch):
    """OKX returns candles newest-first, and every indicator would compute
    cleanly and return confidently wrong numbers on a reversed series."""
    from datetime import UTC, datetime, timedelta
    from decimal import Decimal

    from app.market_data.schemas import Candle
    from app.market_data.timeframes import Timeframe

    base = datetime.now(UTC).replace(microsecond=0)
    candles = [
        Candle(
            symbol="BTCUSDT",
            timeframe=Timeframe.H1,
            open_time=base - timedelta(hours=h),
            open=Decimal(10 + h),
            high=Decimal(20 + h),
            low=Decimal(5 + h),
            close=Decimal(15 + h),
            volume=Decimal("1"),
        )
        for h in range(5)  # newest first
    ]

    series = to_series(candles)

    assert series.times == sorted(series.times)
    assert series.close[0] == 19.0  # the oldest bar (h=4)
