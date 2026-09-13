"""Risk tests. Position sizing and the veto gate.

These cover the arithmetic that decides how much money is at stake, so they are
checked against hand calculations rather than against the code's own output.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.risk.manager import (
    PortfolioState,
    RejectReason,
    RiskLimits,
    RiskManager,
)
from app.risk.sizing import build_plan, position_size


def portfolio(**overrides) -> PortfolioState:
    base = {
        "balance": Decimal("10000"),
        "equity": Decimal("10000"),
        "peak_equity": Decimal("10000"),
        "open_symbols": frozenset(),
        "realised_today": Decimal("0"),
        "day": datetime.now(UTC).date(),
    }
    return PortfolioState(**{**base, **overrides})


def approve(manager: RiskManager, **overrides):
    base = {
        "symbol": "BTCUSDT",
        "portfolio": portfolio(),
        "confidence": Decimal("80"),
        "reward_risk": Decimal("2.0"),
        "notional": Decimal("2000"),
        "data_is_live": True,
    }
    return manager.evaluate(**{**base, **overrides})


# --- position sizing -------------------------------------------------------


def test_size_is_derived_from_stop_distance_not_fixed():
    """The rule the whole risk model rests on: quantity = risk / distance."""
    size = position_size(
        balance=Decimal("10000"),
        risk_pct=Decimal("1"),
        entry=Decimal("100"),
        stop=Decimal("95"),
    )
    # 1% of 10,000 = 100 risk; distance 5 -> 20 units.
    assert size.quantity == Decimal("20")
    assert size.risk_amount == Decimal("100.00")
    assert size.notional == Decimal("2000.00")
    assert size.capped is False


def test_a_wider_stop_produces_a_smaller_position_for_the_same_risk():
    """Two setups risking the same money must differ in size, never in risk."""
    tight = position_size(
        balance=Decimal("10000"),
        risk_pct=Decimal("1"),
        entry=Decimal("100"),
        stop=Decimal("95"),
    )
    wide = position_size(
        balance=Decimal("10000"),
        risk_pct=Decimal("1"),
        entry=Decimal("100"),
        stop=Decimal("80"),
    )

    assert wide.quantity < tight.quantity
    assert wide.risk_amount == tight.risk_amount == Decimal("100.00")


def test_sizing_is_exact_decimal_not_float():
    size = position_size(
        balance=Decimal("10000"),
        risk_pct=Decimal("1"),
        entry=Decimal("0.1"),
        stop=Decimal("0.09"),
    )
    # Distance is exactly 0.01; 100 / 0.01 = 10,000 units. In float, 0.1 - 0.09
    # is 0.009999999999999995 and this would be 10000.000000000005.
    assert size.quantity == Decimal("10000")


def test_a_stop_at_the_entry_is_refused_rather_than_dividing_by_zero():
    size = position_size(
        balance=Decimal("10000"),
        risk_pct=Decimal("1"),
        entry=Decimal("100"),
        stop=Decimal("100"),
    )
    assert size.quantity == 0
    assert size.is_valid is False


def test_a_tight_stop_is_capped_and_says_so(caplog):
    """A 0.65% stop with 1% risk implies 1.55x the account — leverage this
    platform does not model. The reduction must be visible, not silent."""
    size = position_size(
        balance=Decimal("10000"),
        risk_pct=Decimal("1"),
        entry=Decimal("108500"),
        stop=Decimal("107800"),
    )

    assert size.capped is True
    assert size.requested_risk_amount == Decimal("100.00")
    assert size.risk_amount < size.requested_risk_amount
    assert size.notional <= Decimal("10000")
    assert size.cap_note is not None and "reduced" in size.cap_note


def test_an_uncapped_position_reports_no_note():
    size = position_size(
        balance=Decimal("10000"),
        risk_pct=Decimal("1"),
        entry=Decimal("100"),
        stop=Decimal("95"),
    )
    assert size.cap_note is None


# --- the plan --------------------------------------------------------------


def test_targets_are_staged_and_allocations_total_one_hundred():
    plan = build_plan(
        direction="LONG",
        entry=Decimal("100"),
        stop=Decimal("95"),
        balance=Decimal("10000"),
        risk_pct=Decimal("1"),
    )

    assert len(plan.targets) == 3
    assert sum(t.allocation_pct for t in plan.targets) == 100
    assert [t.price for t in plan.targets] == [
        Decimal("105.00000000"),
        Decimal("110.00000000"),
        Decimal("115.00000000"),
    ]


def test_a_target_is_pulled_back_to_real_resistance():
    """A target beyond known resistance is a target that will not be hit."""
    plan = build_plan(
        direction="LONG",
        entry=Decimal("100"),
        stop=Decimal("95"),
        balance=Decimal("10000"),
        risk_pct=Decimal("1"),
        resistance=Decimal("108"),
    )
    assert all(t.price <= Decimal("108") for t in plan.targets)


def test_short_targets_run_downward():
    plan = build_plan(
        direction="SHORT",
        entry=Decimal("100"),
        stop=Decimal("105"),
        balance=Decimal("10000"),
        risk_pct=Decimal("1"),
    )
    assert plan.targets[-1].price < plan.entry
    assert plan.reward_risk == Decimal("3.00")


def test_realistic_loss_exceeds_the_planned_loss():
    """Fees and slippage are charged both ways. Reporting only the planned loss
    understates every trade by a consistent margin that compounds."""
    plan = build_plan(
        direction="LONG",
        entry=Decimal("100"),
        stop=Decimal("95"),
        balance=Decimal("10000"),
        risk_pct=Decimal("1"),
    )
    planned = plan.size.quantity * (plan.entry - plan.stop)

    assert plan.realistic_loss > planned
    # Not wildly more: fees + slippage on a 2,000 notional, both ways.
    assert plan.realistic_loss < planned * Decimal("1.1")


# --- the veto gate ---------------------------------------------------------


def test_a_clean_setup_is_approved():
    assert approve(RiskManager()).approved is True


def test_stale_data_is_an_absolute_veto():
    """Stage 1 established that the platform never invents a market value. This
    is where that guarantee becomes a refusal to act."""
    decision = approve(RiskManager(), data_is_live=False, confidence=Decimal("99"))

    assert decision.approved is False
    assert RejectReason.NO_RELIABLE_DATA in decision.reasons


def test_a_duplicate_position_is_refused():
    decision = approve(RiskManager(), portfolio=portfolio(open_symbols=frozenset({"BTCUSDT"})))
    assert RejectReason.DUPLICATE_POSITION in decision.reasons


def test_the_open_position_limit_is_enforced():
    full = frozenset({"A", "B", "C", "D", "E"})
    decision = approve(RiskManager(), portfolio=portfolio(open_symbols=full))
    assert RejectReason.MAX_OPEN_TRADES in decision.reasons


def test_the_daily_loss_limit_pauses_trading():
    decision = approve(RiskManager(), portfolio=portfolio(realised_today=Decimal("-350")))
    assert RejectReason.DAILY_LOSS_LIMIT in decision.reasons


def test_a_profitable_day_does_not_count_toward_the_loss_limit():
    decision = approve(RiskManager(), portfolio=portfolio(realised_today=Decimal("500")))
    assert RejectReason.DAILY_LOSS_LIMIT not in decision.reasons


def test_yesterdays_loss_does_not_block_today():
    yesterday = datetime.now(UTC).date() - timedelta(days=1)
    decision = approve(
        RiskManager(),
        portfolio=portfolio(realised_today=Decimal("-900"), day=yesterday),
    )
    assert RejectReason.DAILY_LOSS_LIMIT not in decision.reasons


def test_the_drawdown_limit_is_enforced():
    decision = approve(
        RiskManager(),
        portfolio=portfolio(equity=Decimal("8900"), peak_equity=Decimal("10000")),
    )
    assert RejectReason.DRAWDOWN_LIMIT in decision.reasons


def test_confidence_below_the_floor_is_refused():
    decision = approve(RiskManager(), confidence=Decimal("74.9"))
    assert RejectReason.CONFIDENCE_TOO_LOW in decision.reasons


def test_reward_to_risk_below_the_floor_is_refused():
    decision = approve(RiskManager(), reward_risk=Decimal("1.49"))
    assert RejectReason.RISK_REWARD_TOO_LOW in decision.reasons


def test_extreme_volatility_is_refused():
    decision = approve(RiskManager(), volatility_tradeable=False)
    assert RejectReason.VOLATILITY_EXTREME in decision.reasons


def test_a_position_larger_than_the_balance_is_refused():
    decision = approve(RiskManager(), notional=Decimal("50000"))
    assert RejectReason.INSUFFICIENT_BALANCE in decision.reasons


def test_a_dust_position_is_refused():
    decision = approve(RiskManager(), notional=Decimal("3"))
    assert RejectReason.POSITION_TOO_SMALL in decision.reasons


def test_every_breached_rule_is_reported_not_just_the_first():
    """One reason at a time turns fixing a rejection into a guessing game, and
    hides the case where a setup fails for several independent reasons."""
    decision = approve(
        RiskManager(),
        portfolio=portfolio(
            open_symbols=frozenset({"A", "B", "C", "D", "E"}),
            equity=Decimal("8500"),
            realised_today=Decimal("-400"),
        ),
        confidence=Decimal("50"),
        reward_risk=Decimal("1.0"),
        data_is_live=False,
    )

    assert decision.approved is False
    assert len(decision.reasons) >= 5
    assert len(decision.notes) == len(decision.reasons)


def test_a_high_score_cannot_override_a_limit():
    """A setup that scores 99 and breaches the daily loss limit does not open.
    That is why this gate lives downstream of the scoring."""
    decision = approve(
        RiskManager(),
        confidence=Decimal("99"),
        reward_risk=Decimal("10"),
        portfolio=portfolio(realised_today=Decimal("-400")),
    )
    assert decision.approved is False


def test_limits_are_configurable_without_touching_the_logic():
    manager = RiskManager(RiskLimits(max_open_trades=1, min_confidence=Decimal("90")))

    assert approve(manager, confidence=Decimal("85")).approved is False
    assert approve(manager, portfolio=portfolio(open_symbols=frozenset({"X"}))).approved is False


def test_the_invalidation_sentence_shows_a_readable_price():
    """Decimal keeps every digit of the arithmetic that produced a value, which
    is right for storage and wrong for a sentence."""
    plan = build_plan(
        direction="LONG",
        entry=Decimal("121829.51"),
        stop=Decimal("114177.74098213758276"),
        balance=Decimal("10000"),
        risk_pct=Decimal("1"),
        atr=Decimal("2067.31"),
    )

    assert "114177.74" in plan.invalidation
    assert "114177.74098213758276" not in plan.invalidation
    # And the stored stop matches what the sentence claims.
    assert plan.stop == Decimal("114177.74098214")


def test_format_price_scales_its_precision_to_the_magnitude():
    from app.risk.sizing import format_price

    assert format_price(Decimal("121829.5134")) == "121829.51"
    assert format_price(Decimal("2.41376655")) == "2.4138"
    assert format_price(Decimal("0.000012345678")) == "0.00001235"


# --- the limit `max_open_trades` only appeared to provide --------------------


def test_a_concentrated_book_is_refused_even_under_the_position_limit():
    """Three positions is well inside the five-position limit. If they are the
    same bet three times, the position count is not the constraint that
    matters."""
    manager = RiskManager()
    decision = approve(
        manager,
        portfolio=portfolio(open_symbols=frozenset({"ETHUSDT", "SOLUSDT"})),
        projected_heat_pct=Decimal("2.9"),
    )

    assert not decision.approved
    assert RejectReason.PORTFOLIO_HEAT in decision.reasons
    assert any("concentration" in n for n in decision.notes)


def test_a_diversified_book_at_the_same_position_count_is_allowed():
    manager = RiskManager()
    decision = approve(
        manager,
        portfolio=portfolio(open_symbols=frozenset({"ETHUSDT", "SOLUSDT"})),
        projected_heat_pct=Decimal("2.2"),
    )

    assert decision.approved
    assert decision.heat_checked is True


def test_heat_exactly_at_the_limit_is_allowed():
    """The limit is a ceiling, not a fence one short of it."""
    manager = RiskManager(RiskLimits(max_portfolio_heat_pct=Decimal("2.5")))
    assert approve(manager, projected_heat_pct=Decimal("2.5")).approved


def test_an_unmeasured_heat_is_flagged_rather_than_silently_skipped():
    """A caller with nothing to correlate — a single-symbol replay — passes
    None. That must be visible on the decision, not inferred from its absence.
    """
    manager = RiskManager()
    decision = approve(manager, projected_heat_pct=None)

    assert decision.approved
    assert decision.heat_checked is False
    # And it does not appear as a note: every note corresponds to a breached
    # rule, and "this check did not run" is not one.
    assert not any("heat" in n.lower() for n in decision.notes)
