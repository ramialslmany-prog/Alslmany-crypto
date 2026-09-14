"""Market structure tests, built on hand-constructed price paths.

Each fixture is a small series whose correct answer can be read off by eye, so
a failure points at the detector rather than at an argument about what the
chart "really" shows.
"""

from __future__ import annotations

from app.analysis.levels import Swing, SwingKind, find_swings
from app.analysis.structure import (
    BreakKind,
    StructureState,
    analyse_structure,
    classify_structure,
    find_fair_value_gaps,
    find_liquidity_sweeps,
    find_order_blocks,
    find_structure_breaks,
    premium_discount,
)


def swing(index: int, price: float, kind: SwingKind) -> Swing:
    return Swing(index=index, price=price, kind=kind)


# --- HH/HL/LH/LL -----------------------------------------------------------


def test_higher_highs_and_higher_lows_are_bullish():
    highs = [swing(0, 10, SwingKind.HIGH), swing(4, 12, SwingKind.HIGH)]
    lows = [swing(2, 8, SwingKind.LOW), swing(6, 9, SwingKind.LOW)]
    assert classify_structure(highs, lows) is StructureState.BULLISH


def test_lower_highs_and_lower_lows_are_bearish():
    highs = [swing(0, 12, SwingKind.HIGH), swing(4, 10, SwingKind.HIGH)]
    lows = [swing(2, 9, SwingKind.LOW), swing(6, 7, SwingKind.LOW)]
    assert classify_structure(highs, lows) is StructureState.BEARISH


def test_a_higher_high_with_a_lower_low_is_ranging_not_bullish():
    """One leg alone is not a trend — an expanding range is not an uptrend."""
    highs = [swing(0, 10, SwingKind.HIGH), swing(4, 12, SwingKind.HIGH)]
    lows = [swing(2, 8, SwingKind.LOW), swing(6, 7, SwingKind.LOW)]
    assert classify_structure(highs, lows) is StructureState.RANGING


def test_too_few_swings_is_unknown_rather_than_a_guess():
    assert classify_structure([], []) is StructureState.UNKNOWN
    assert (
        classify_structure([swing(0, 10, SwingKind.HIGH)], [swing(1, 8, SwingKind.LOW)])
        is StructureState.UNKNOWN
    )


# --- BOS vs CHoCH ----------------------------------------------------------


def test_breaking_a_high_after_a_downtrend_is_a_change_of_character():
    """The distinction is the whole value of the concept: continuation and
    reversal look identical if both are just called "a break"."""
    # Down, down, then a decisive push back through the last lower high.
    high = [20, 18, 19, 16, 17, 14, 15, 13, 14, 12, 13, 16, 18, 20, 22]
    low = [18, 16, 17, 14, 15, 12, 13, 11, 12, 10, 11, 13, 15, 17, 19]
    close = [19, 17, 18, 15, 16, 13, 14, 12, 13, 11, 12, 15, 17, 19, 21]

    f = [float(v) for v in high], [float(v) for v in low], [float(v) for v in close]
    swings = find_swings(f[0], f[1], lookback=1)
    breaks = find_structure_breaks(f[0], f[1], f[2], swings)

    assert breaks, "a decisive reversal must register a break"
    ups = [b for b in breaks if b.direction == "up"]
    assert ups, "the push through the lower high must be detected"
    assert any(b.kind is BreakKind.CHOCH for b in breaks)


def test_breaking_a_high_while_already_bullish_is_continuation():
    high = [float(v) for v in [10, 12, 11, 14, 13, 16, 15, 18, 17, 20]]
    low = [float(v) for v in [8, 10, 9, 12, 11, 14, 13, 16, 15, 18]]
    close = [float(v) for v in [9, 11, 10, 13, 12, 15, 14, 17, 16, 19]]

    swings = find_swings(high, low, lookback=1)
    breaks = find_structure_breaks(high, low, close, swings)

    assert breaks
    assert all(b.kind is BreakKind.BOS for b in breaks if b.direction == "up")


def test_a_break_requires_a_close_beyond_the_level_not_a_wick():
    # The final bar wicks well above the prior high but closes back below it.
    high = [float(v) for v in [10, 14, 11, 10, 11, 20]]
    low = [float(v) for v in [8, 12, 9, 8, 9, 10]]
    close = [float(v) for v in [9, 13, 10, 9, 10, 11]]

    swings = find_swings(high, low, lookback=1)
    breaks = find_structure_breaks(high, low, close, swings)

    assert not any(b.index == 5 for b in breaks), "a wick is not a break"


# --- fair value gaps -------------------------------------------------------


def test_a_three_bar_imbalance_is_detected():
    # Bar 2's low (20) sits above bar 0's high (12): price skipped 12-20.
    high = [12.0, 18.0, 25.0]
    low = [10.0, 14.0, 20.0]

    gaps = find_fair_value_gaps(high, low)

    assert len(gaps) == 1
    assert gaps[0].direction == "bullish"
    assert gaps[0].bottom == 12.0
    assert gaps[0].top == 20.0
    assert gaps[0].midpoint == 16.0


def test_a_gap_price_has_traded_back_through_is_not_reported():
    """A filled gap is history, not a level."""
    high = [12.0, 18.0, 25.0, 24.0, 22.0]
    low = [10.0, 14.0, 20.0, 15.0, 11.0]  # price comes back down through it

    assert find_fair_value_gaps(high, low) == []


def test_a_gap_narrower_than_the_noise_floor_is_ignored():
    high = [100.0, 100.02, 100.05]
    low = [99.99, 100.01, 100.03]
    assert find_fair_value_gaps(high, low, min_size_pct=0.5) == []


# --- order blocks ----------------------------------------------------------


def test_an_order_block_is_the_last_opposing_candle_before_the_break():
    open_ = [float(v) for v in [10, 12, 11, 10, 12, 15, 18]]
    close = [float(v) for v in [11, 13, 10, 12, 14, 17, 20]]  # index 2 is the down candle
    high = [float(v) for v in [12, 14, 12, 13, 15, 18, 21]]
    low = [float(v) for v in [9, 11, 9, 9, 11, 14, 17]]

    swings = find_swings(high, low, lookback=1)
    breaks = find_structure_breaks(high, low, close, swings)
    blocks = find_order_blocks(open_, high, low, close, breaks)

    assert blocks, "an upward break should leave a bullish order block behind it"
    assert all(b.direction == "bullish" for b in blocks)


def test_no_break_means_no_order_block():
    """Without the break filter, "order block" means "any red candle", which is
    most candles."""
    open_ = [10.0] * 8
    close = [10.0] * 8
    high = [10.0] * 8
    low = [10.0] * 8
    assert find_order_blocks(open_, high, low, close, []) == []


# --- liquidity sweeps ------------------------------------------------------


def test_taking_a_high_and_closing_back_below_it_is_a_sweep():
    """Wicking through and closing beyond is a break; closing back inside is
    stop-hunting, and the two imply opposite next moves."""
    high = [float(v) for v in [10, 14, 11, 10, 16]]
    low = [float(v) for v in [8, 12, 9, 8, 9]]
    close = [float(v) for v in [9, 13, 10, 9, 11]]  # closes back under the 14 high

    swings = find_swings(high, low, lookback=1)
    sweeps = find_liquidity_sweeps(high, low, close, swings)

    assert any(s.direction == "high" and s.index == 4 for s in sweeps)


def test_closing_beyond_the_level_is_a_break_not_a_sweep():
    high = [float(v) for v in [10, 14, 11, 10, 16]]
    low = [float(v) for v in [8, 12, 9, 8, 13]]
    close = [float(v) for v in [9, 13, 10, 9, 15]]  # closes above the 14 high

    swings = find_swings(high, low, lookback=1)
    sweeps = find_liquidity_sweeps(high, low, close, swings)

    assert not any(s.index == 4 and s.direction == "high" for s in sweeps)


# --- premium / discount ----------------------------------------------------


def test_the_top_of_the_range_is_premium_and_the_bottom_is_discount():
    high = [120.0] * 20
    low = [80.0] * 20

    at_top = premium_discount(high, low, [100.0] * 19 + [118.0])
    at_bottom = premium_discount(high, low, [100.0] * 19 + [82.0])

    assert at_top.zone == "premium"
    assert at_bottom.zone == "discount"
    assert at_top.position_pct > at_bottom.position_pct


def test_the_middle_of_the_range_is_equilibrium():
    high = [120.0] * 10
    low = [80.0] * 10
    assert premium_discount(high, low, [100.0] * 10).zone == "equilibrium"


def test_a_range_with_no_width_yields_nothing():
    assert premium_discount([10.0] * 10, [10.0] * 10, [10.0] * 10) is None


def test_a_short_series_yields_nothing_rather_than_a_meaningless_range():
    assert premium_discount([10.0] * 3, [8.0] * 3, [9.0] * 3) is None


# --- the manifest ----------------------------------------------------------


def test_the_result_lists_what_was_actually_detected():
    """The governing rule of this module: a setup with three confirmations and a
    setup with none must not look alike."""
    flat = [10.0] * 40
    result = analyse_structure(flat, flat, flat, flat)

    assert "fair-value-gap" not in result.detected
    assert "order-block" not in result.detected
    assert result.state is StructureState.UNKNOWN


def test_a_rich_chart_reports_more_than_a_flat_one():
    import math

    n = 120
    open_, high, low, close = [], [], [], []
    price = 100.0
    for i in range(n):
        price += math.sin(i / 7) * 2 + (0.15 if i > 60 else -0.1)
        open_.append(price)
        close.append(price + math.cos(i / 5))
        high.append(max(open_[-1], close[-1]) + 1.2)
        low.append(min(open_[-1], close[-1]) - 1.2)

    rich = analyse_structure(open_, high, low, close)
    flat = analyse_structure([10.0] * n, [10.0] * n, [10.0] * n, [10.0] * n)

    assert len(rich.detected) > len(flat.detected)
    assert "swings" in rich.detected
    assert rich.premium_discount is not None


def test_every_finding_can_be_traced_back_to_its_candle():
    import math

    n = 100
    close = [100 + math.sin(i / 6) * 5 for i in range(n)]
    open_ = [c - 0.5 for c in close]
    high = [c + 1.5 for c in close]
    low = [c - 1.5 for c in close]

    result = analyse_structure(open_, high, low, close)

    for item in (
        list(result.swings)
        + list(result.breaks)
        + list(result.fair_value_gaps)
        + list(result.order_blocks)
        + list(result.sweeps)
    ):
        assert 0 <= item.index < n, "every claim must point at a real bar"
