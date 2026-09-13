"""The plan as the screen receives it.

Everything asserted here already existed in `TradePlan`; none of it reached the
browser. The signal payload carried four prices and a reward-to-risk ratio, and
a trader looking at it had to work out the size, the cost of being wrong, and
the fact that the exit is staged at all.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.risk.sizing import build_plan

BALANCE = Decimal("10000")


def plan(entry="108500", stop="107800", direction="LONG", **kw):
    return build_plan(
        direction=direction,
        entry=Decimal(entry),
        stop=Decimal(stop),
        balance=BALANCE,
        risk_pct=Decimal("1"),
        **kw,
    )


# --- the ladder, priced -----------------------------------------------------


def test_each_rung_prices_its_own_slice_and_not_the_whole_position():
    """The commonest way a staged plan is misread: treating every target as
    though the full size exits there, which triples a 50/30/20 ladder."""
    p = plan()
    rungs = p.ladder()

    for rung, allocation in zip(rungs, (50, 30, 20), strict=True):
        expected = (
            p.size.quantity * Decimal(allocation) / 100 * abs(Decimal(rung["price"]) - p.entry)
        ).quantize(Decimal("0.01"))
        assert Decimal(rung["profit"]) == expected


def test_banked_accumulates_rather_than_repeating_the_slice():
    p = plan()
    rungs = p.ladder()

    running = Decimal(0)
    for rung in rungs:
        running += Decimal(rung["profit"])
        assert Decimal(rung["banked"]) == running

    assert Decimal(p.to_dict()["max_profit"]) == running


def test_the_whole_position_is_allocated_and_no_more():
    p = plan()
    allocated = sum(Decimal(r["quantity"]) for r in p.ladder())
    # Each slice is formatted for display, so the sum carries rounding; it must
    # not exceed the position, which would be selling what is not held.
    assert allocated <= p.size.quantity
    assert allocated >= p.size.quantity * Decimal("0.999")


# --- the two reward-to-risk numbers -----------------------------------------


def test_the_blended_ratio_is_what_the_ladder_pays_not_the_final_target():
    """1.7R, not 3.0R. Only a fifth of the position ever reaches the last
    target, so quoting the final-target ratio alone describes a trade this plan
    does not take."""
    p = plan()
    assert p.reward_risk == Decimal("3.00")
    assert p.blended_reward_risk == Decimal("1.70")


def test_a_clamped_target_drags_the_blended_ratio_down():
    """The case the blended number exists for. A target clipped to real
    resistance pays less, and the headline ratio is the first thing to hide it.
    """
    free = plan()
    capped = plan(resistance=Decimal("109500"))

    assert capped.blended_reward_risk < free.blended_reward_risk


def test_both_ratios_are_published_so_neither_can_stand_alone():
    payload = plan().to_dict()
    assert payload["reward_risk"] == "3.00"
    assert payload["blended_reward_risk"] == "1.70"


# --- what being wrong costs -------------------------------------------------


def test_the_realistic_loss_exceeds_the_planned_one():
    """Fees and adverse fills on both legs. A plan that reports only the
    planned loss understates every trade by a consistent margin."""
    payload = plan().to_dict()
    assert Decimal(payload["realistic_loss"]) > Decimal(payload["planned_loss"])


def test_the_asymmetry_between_loss_and_profit_costs_is_stated():
    """The loss carries costs and the target profits do not. That is a real
    asymmetry, and the payload names it rather than letting the reader assume
    the two are comparable."""
    payload = plan().to_dict()
    assert "not known yet" in payload["cost_note"]


# --- the size ---------------------------------------------------------------


def test_a_capped_position_says_so_rather_than_quietly_shrinking():
    """A trader who asks to risk 1% and silently gets 0.65% is being told
    something untrue about the system's own risk model."""
    payload = plan().to_dict()["size"]
    assert payload["capped"] is True
    assert payload["cap_note"] is not None
    assert Decimal(payload["risk_pct_of_balance"]) < Decimal("1")


def test_an_uncapped_position_carries_no_note_to_explain_away():
    # A wide stop needs little exposure, so the ceiling never binds.
    payload = plan(stop="97650").to_dict()["size"]
    assert payload["capped"] is False
    assert payload["cap_note"] is None


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (Decimal("4"), "4"),
        (Decimal("0.14285714"), "0.14285714"),
        (Decimal("1.50000000"), "1.5"),
    ],
)
def test_a_quantity_carries_only_the_precision_it_has(value, expected):
    from app.risk.sizing import format_quantity

    assert format_quantity(value) == expected


# --- a short is not a long with the signs swapped by hand -------------------


def test_a_short_ladder_runs_downward_and_still_pays():
    p = plan(entry="108500", stop="109200", direction="SHORT")
    rungs = p.ladder()

    prices = [Decimal(r["price"]) for r in rungs]
    assert prices == sorted(prices, reverse=True), "a short's targets must fall"
    assert all(Decimal(r["profit"]) > 0 for r in rungs)
    assert p.blended_reward_risk == Decimal("1.70")


# --- the payload the screen actually receives -------------------------------


def signal_for(closes, **kw):
    """A real signal through the real analyser, not a hand-built plan.

    The bug this section guards against was not in `TradePlan` — every number
    here was already correct — it was that `Signal.to_dict` never asked for it.
    A test against `build_plan` alone would have passed throughout.
    """
    from app.signals.analyzer import analyse, build_signal
    from tests.test_analyzer import make_series

    analysis = analyse(make_series(closes), "BTCUSDT", "1h")
    assert analysis is not None
    return build_signal(analysis, balance=BALANCE, risk_pct=Decimal("1"), **kw)


# The clean synthetic uptrend scores 72, just under the 75 floor, so it refuses
# on confidence alone. These tests are about the SHAPE of a tradeable payload,
# not about where the floor sits, so they lower the floor rather than bend the
# price path until it scores higher — which would make them tests of the
# fixture instead of tests of the payload.
TRADEABLE = {"min_confidence": Decimal("70")}


def test_a_tradeable_signal_carries_its_plan_to_the_screen():
    from tests.test_analyzer import uptrend

    payload = signal_for(uptrend(), **TRADEABLE).to_dict()
    assert payload["decision"] == "TRADE"

    plan = payload["plan"]
    assert plan is not None, "the plan was computed and then dropped"
    assert Decimal(plan["size"]["quantity"]) > 0
    assert Decimal(plan["realistic_loss"]) > 0
    assert len(plan["targets"]) == 3


def test_a_refusal_publishes_no_plan_to_take_anyway():
    """The card refuses to print levels beside a NO_TRADE. That rule is only
    worth anything if the payload does not carry them either."""
    from tests.test_analyzer import chop

    payload = signal_for(chop()).to_dict()
    assert payload["decision"] == "NO_TRADE"
    assert payload["plan"] is None


def test_the_plan_agrees_with_the_flat_fields_beside_it():
    """Two descriptions of one trade sit on the same card. They must be the
    same trade — a plan whose entry differs from the entry printed above it is
    the screen contradicting itself."""
    from tests.test_analyzer import uptrend

    payload = signal_for(uptrend(), **TRADEABLE).to_dict()
    plan = payload["plan"]

    assert Decimal(plan["entry"]) == Decimal(payload["entry"])
    assert Decimal(plan["stop"]) == Decimal(payload["stop_loss"])
    assert Decimal(plan["targets"][-1]["price"]) == Decimal(payload["take_profit"])
    assert plan["reward_risk"] == payload["risk_reward"]


def test_the_gate_checks_the_final_target_ratio_and_the_payload_says_both():
    """Recorded rather than changed. The entry gate compares the 1.5 floor
    against `reward_risk` — the final-target figure — while the ladder pays the
    blended one. Which ratio the floor should test is a strategy decision, and
    this platform does not let the code make those quietly. What it can do is
    refuse to show only the flattering number.
    """
    from tests.test_analyzer import uptrend

    plan = signal_for(uptrend(), **TRADEABLE).to_dict()["plan"]
    assert Decimal(plan["blended_reward_risk"]) < Decimal(plan["reward_risk"])
