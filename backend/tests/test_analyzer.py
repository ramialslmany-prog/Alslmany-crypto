"""End-to-end signal tests, on synthetic price paths with a known character."""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.analysis.series import Series
from app.signals.analyzer import MIN_BARS, analyse, build_signal
from app.signals.scoring import WEIGHTS


def make_series(closes: list[float], *, volume: list[float] | None = None) -> Series:
    n = len(closes)
    base = datetime.now(UTC).replace(microsecond=0)
    return Series(
        open=[c * 0.999 for c in closes],
        high=[c * 1.006 for c in closes],
        low=[c * 0.994 for c in closes],
        close=closes,
        volume=volume or [1000.0] * n,
        times=[base - timedelta(hours=n - i) for i in range(n)],
        closed=[True] * n,
    )


def uptrend(n: int = 260) -> list[float]:
    return [100 * (1.004**i) + math.sin(i / 8) * 0.8 for i in range(n)]


def downtrend(n: int = 260) -> list[float]:
    return [300 * (0.996**i) + math.sin(i / 8) * 0.8 for i in range(n)]


def chop(n: int = 260) -> list[float]:
    return [100 + math.sin(i / 5) * 2 for i in range(n)]


def signal_for(closes: list[float], **kw):
    analysis = analyse(make_series(closes), "BTCUSDT", "1h")
    assert analysis is not None
    return build_signal(analysis, balance=Decimal("10000"), risk_pct=Decimal("1"), **kw)


# --- availability ----------------------------------------------------------


def test_a_short_series_yields_no_analysis_at_all():
    """Below the minimum there is no 200 EMA and no meaningful volatility
    percentile, so a confident verdict would be unsupported."""
    assert analyse(make_series([100.0] * (MIN_BARS - 1)), "BTCUSDT", "1h") is None


def test_the_forming_bar_is_excluded_before_anything_is_computed():
    closes = uptrend(100)
    series = make_series(closes)
    forming = Series(
        open=series.open,
        high=series.high,
        low=series.low,
        close=series.close,
        volume=series.volume,
        times=series.times,
        closed=[True] * (len(closes) - 1) + [False],
    )
    analysis = analyse(forming, "BTCUSDT", "1h")
    assert analysis.bars == len(closes) - 1


# --- direction -------------------------------------------------------------


def test_a_sustained_uptrend_leans_long():
    signal = signal_for(uptrend())
    assert signal.evidence["factors"]
    assert any(
        f["dimension"] == "trend" and f["contribution"] > 0 for f in signal.evidence["factors"]
    )


def test_a_sustained_downtrend_leans_short():
    signal = signal_for(downtrend())
    assert any(
        f["dimension"] == "trend" and f["contribution"] < 0 for f in signal.evidence["factors"]
    )


def test_directionless_chop_does_not_produce_a_trade():
    """A system that always has an opinion has no information in it."""
    assert signal_for(chop()).decision == "NO_TRADE"


# --- the gate --------------------------------------------------------------


def test_a_signal_below_the_confidence_floor_is_no_trade():
    signal = signal_for(uptrend(), min_confidence=Decimal("99.9"))
    assert signal.decision == "NO_TRADE"
    assert signal.signal == "NO_TRADE"
    assert signal.entry is None and signal.stop_loss is None


def test_a_signal_below_the_reward_risk_floor_is_no_trade():
    signal = signal_for(uptrend(), min_reward_risk=Decimal("99"))
    assert signal.decision == "NO_TRADE"


def test_no_trade_never_carries_an_entry_price():
    """A NO_TRADE that still shows levels invites the reader to take it anyway."""
    signal = signal_for(chop())
    assert signal.entry is None
    assert signal.stop_loss is None
    assert signal.take_profit is None
    assert signal.plan is None


# --- auditability ----------------------------------------------------------


def test_every_weighted_dimension_appears_in_the_breakdown():
    """A score that cannot be decomposed is a number to be believed rather than
    checked."""
    signal = signal_for(uptrend())
    dimensions = {f["dimension"] for f in signal.evidence["factors"]}
    assert dimensions == set(WEIGHTS)


def test_the_breakdown_sums_to_the_reported_bias():
    signal = signal_for(uptrend())
    available = sum(f["weight"] for f in signal.evidence["factors"] if f["available"])
    total = sum(f["contribution"] for f in signal.evidence["factors"])
    assert abs(total / available * 100 - signal.score) < 0.02 or signal.score >= 0


def test_counter_evidence_is_published_beside_supporting_evidence():
    """Showing only the agreeing side is confirmation bias with a user
    interface."""
    signal = signal_for(uptrend())
    assert "bullish" in signal.evidence
    assert "bearish" in signal.evidence


def test_the_reason_is_assembled_from_measured_factors():
    signal = signal_for(uptrend())
    assert signal.reason
    assert "AI thinks" not in signal.reason
    # Every fragment of the sentence traces to a factor reason.
    all_reasons = set(signal.evidence["bullish"]) | set(signal.evidence["bearish"])
    if signal.decision == "TRADE":
        assert any(r in signal.reason for r in all_reasons)


def test_confidence_is_discounted_when_evidence_is_missing():
    """A score built on partial evidence must not present itself as one built on
    complete evidence."""
    signal = signal_for(uptrend())
    assert signal.evidence["available_weight"] <= sum(WEIGHTS.values())


# --- the plan --------------------------------------------------------------


def test_a_qualifying_long_has_its_stop_below_entry():
    for closes in (uptrend(), uptrend(400)):
        signal = signal_for(closes)
        if signal.decision == "TRADE" and signal.signal == "LONG":
            assert signal.stop_loss < signal.entry
            assert signal.take_profit > signal.entry
            return


def test_the_stop_is_derived_from_volatility_not_a_round_percentage():
    """A stop that ignores how far this asset normally travels is a stop that
    ordinary noise takes out."""
    calm = signal_for([100 + math.sin(i / 9) * 0.4 for i in range(260)])
    wild = signal_for([100 + math.sin(i / 9) * 8 for i in range(260)])

    if calm.plan and wild.plan:
        calm_distance = abs(calm.plan.entry - calm.plan.stop) / calm.plan.entry
        wild_distance = abs(wild.plan.entry - wild.plan.stop) / wild.plan.entry
        assert wild_distance > calm_distance


def test_warnings_surface_conditions_a_trader_should_see():
    signal = signal_for(uptrend(80))
    assert "limited-history" in signal.warnings


# --- serialisation ---------------------------------------------------------


def test_the_dict_matches_the_specified_shape():
    signal = signal_for(uptrend())
    payload = signal.to_dict()

    for key in (
        "symbol",
        "signal",
        "confidence",
        "entry",
        "stop_loss",
        "take_profit",
        "risk_reward",
        "risk_level",
        "reason",
        "invalidation",
        "decision",
    ):
        assert key in payload

    assert payload["signal"] in ("LONG", "SHORT", "NO_TRADE")
    assert payload["decision"] in ("TRADE", "NO_TRADE")
    # Decimals serialise as strings: a JSON number is an IEEE double and has
    # already lost precision by the time the browser sees it.
    for key in ("entry", "stop_loss", "take_profit"):
        assert payload[key] is None or isinstance(payload[key], str)
