"""Regression tests for five defects that made the bot structurally unable to trade.

Every one of these passed the original suite. They were found by *measuring the
bot's behaviour across many scenarios* rather than by reading the code — a unit
test on each factor in isolation cannot see that their combination never clears
its own threshold.
"""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.analysis.series import Series
from app.analysis.volatility import Volatility, VolatilityReading
from app.signals.analyzer import analyse, build_signal
from app.signals.factors import score_news_risk, score_risk_reward
from app.signals.scoring import WEIGHTS, Factor, combine


def factor(dimension: str, raw: float, available: bool = True) -> Factor:
    return Factor(
        dimension=dimension,
        raw=raw,
        weight=WEIGHTS[dimension],
        reasons=(),
        available=available,
    )


def trending(seed: int, up: bool, n: int = 300) -> list[float]:
    """A trend whose legs dominate its pullbacks, so structure is unambiguous.

    An earlier version of this generator used a sine wave whose amplitude was
    nearly twice the drift, and whose phase at the final bar was identical for
    every seed. It made a correct structure detector look inverted, and very
    nearly had me "fix" working code.
    """
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


def make_series(closes: list[float]) -> Series:
    n = len(closes)
    random.seed(len(closes))
    volume = [1000.0 * (1 + random.uniform(-0.3, 0.3)) for _ in closes]
    for j in range(-5, 0):
        volume[j] *= 2.0
    base = datetime.now(UTC)
    return Series(
        open=[c * 0.999 for c in closes],
        high=[c * 1.005 for c in closes],
        low=[c * 0.995 for c in closes],
        close=closes,
        volume=volume,
        times=[base - timedelta(hours=n - i) for i in range(n)],
        closed=[True] * n,
    )


def signals_for(up: bool, count: int = 30):
    out = []
    for seed in range(count):
        analysis = analyse(make_series(trending(seed, up)), "BTCUSDT", "1h")
        if analysis is None:
            continue
        out.append(build_signal(analysis, balance=Decimal("10000"), risk_pct=Decimal("1")))
    return out


# --- 1. the bot must be able to trade at all -------------------------------


def test_the_bot_actually_opens_trades_in_a_clean_trend():
    """The defect this pins: across 120 scenarios the bot took ZERO trades.

    The best score attainable across all seven dimensions was 83.8, so the 75
    floor demanded near-perfection in every dimension simultaneously. Every unit
    test passed; the system as a whole simply never fired.
    """
    signals = signals_for(up=True)
    traded = [s for s in signals if s.decision == "TRADE"]
    assert traded, "a clean uptrend must produce at least one qualifying signal"


def test_the_bot_is_selective_rather_than_trigger_happy():
    """The opposite failure is just as bad — a gate that passes everything."""
    signals = signals_for(up=True)
    traded = [s for s in signals if s.decision == "TRADE"]
    assert len(traded) < len(signals), "not every setup should qualify"


# --- 2. long and short must be symmetric ------------------------------------


def test_downtrends_produce_shorts_the_way_uptrends_produce_longs():
    """Shorts were unreachable while longs were not — 0 of 40 against 17 of 40."""
    ups = [s for s in signals_for(up=True) if s.decision == "TRADE"]
    downs = [s for s in signals_for(up=False) if s.decision == "TRADE"]

    assert ups and downs, "both directions must be reachable"
    assert all(s.signal == "LONG" for s in ups)
    assert all(s.signal == "SHORT" for s in downs)


# --- 3. reward-to-risk has no direction -------------------------------------


def test_a_good_reward_ratio_supports_whichever_direction_is_indicated():
    """The sign bug: a well-planned SHORT received +10 BULLISH points from its
    own reward-to-risk, fighting the trade it was describing."""
    long_side = score_risk_reward(3.0, direction_hint=1.0)
    short_side = score_risk_reward(3.0, direction_hint=-1.0)

    assert long_side.raw > 0, "good RR should support a long"
    assert short_side.raw < 0, "good RR should support a short"


def test_a_poor_reward_ratio_weakens_whichever_direction_is_indicated():
    assert score_risk_reward(1.0, direction_hint=1.0).raw < 0
    assert score_risk_reward(1.0, direction_hint=-1.0).raw > 0


# --- 4. event risk has no direction -----------------------------------------


def test_elevated_risk_weakens_a_short_instead_of_encouraging_it():
    """A fixed negative raw read as bearish evidence, which quietly ENCOURAGED
    shorts in exactly the conditions where nothing should be traded."""
    reading = VolatilityReading(regime=Volatility.HIGH, atr=1.0, atr_pct=2.0, percentile=92.0)

    assert score_news_risk(reading, direction_hint=1.0).raw < 0
    assert score_news_risk(reading, direction_hint=-1.0).raw > 0


def test_no_news_feed_means_the_dimension_abstains_rather_than_scoring_zero():
    """raw=0 with available=True put a permanent 5-point drag on every score.
    A dimension with nothing to say is unavailable, not neutral."""
    calm = VolatilityReading(regime=Volatility.NORMAL, atr=1.0, atr_pct=1.0, percentile=50.0)
    assert score_news_risk(calm).available is False


# --- 5. confidence separates conviction from consensus ----------------------


def test_unanimous_moderate_evidence_beats_contested_strong_evidence():
    """Both produce a similar bias. The first deserves to be acted on and the
    second does not, and a formula built on magnitude alone cannot tell them
    apart."""
    unanimous = combine(
        [
            factor("trend", 0.7),
            factor("structure", 0.6),
            factor("momentum", 0.6),
            factor("volume", 0.5),
            factor("liquidity", 0.4),
            factor("risk_reward", 0.7),
            factor("news_risk", 0.0, available=False),
        ]
    )
    contested = combine(
        [
            factor("trend", 1.0),
            factor("structure", 1.0),
            factor("momentum", -0.9),
            factor("volume", 1.0),
            factor("liquidity", -0.8),
            factor("risk_reward", 1.0),
            factor("news_risk", 0.0, available=False),
        ]
    )

    assert unanimous.consensus > contested.consensus
    assert unanimous.confidence > contested.confidence


def test_a_unanimous_but_weak_signal_is_not_confident():
    weak = combine(
        [
            factor("trend", 0.2),
            factor("structure", 0.15),
            factor("momentum", 0.2),
            factor("volume", 0.1),
            factor("liquidity", 0.1),
            factor("risk_reward", 0.2),
            factor("news_risk", 0.0, available=False),
        ]
    )
    assert weak.consensus == 1.0
    assert weak.confidence < 50, "agreement alone is not conviction"


def test_a_silent_dimension_neither_agrees_nor_disagrees():
    with_silence = combine(
        [
            factor("trend", 0.8),
            factor("structure", 0.8),
            factor("momentum", 0.0),
            factor("volume", 0.8),
            factor("liquidity", 0.0),
            factor("risk_reward", 0.8),
            factor("news_risk", 0.0, available=False),
        ]
    )
    assert with_silence.consensus == 1.0, "silence must not count as disagreement"


# --- 6. range position is a ranging-market concept --------------------------


def test_trading_with_a_trend_is_not_penalised_for_being_at_the_range_extreme():
    """In any sustained trend price sits at the extreme of every lookback window
    by definition. Scoring that as "premium" penalised trend-following at -8.25
    points and made it unreachable."""
    signals = signals_for(up=True, count=15)
    liquidity = [f for s in signals for f in s.evidence["factors"] if f["dimension"] == "liquidity"]

    penalised = [f for f in liquidity if "long-into-premium" in f["reasons"]]
    assert not penalised, "range position must not be scored inside a trend"
    assert any("range-position-not-scored-in-trend" in f["reasons"] for f in liquidity)


# --- 7. a trivial level must not collapse the plan --------------------------


def test_a_level_inside_the_noise_does_not_cap_the_targets():
    """A "level" 0.3% away dragged all three targets onto it and collapsed
    reward-to-risk to 0.05, silently failing the 1.5 floor."""
    from app.risk.sizing import build_plan

    plan = build_plan(
        direction="LONG",
        entry=Decimal("100"),
        stop=Decimal("95"),
        balance=Decimal("10000"),
        risk_pct=Decimal("1"),
        resistance=Decimal("100.3"),  # 0.06 of the stop distance away
    )

    assert plan.reward_risk >= Decimal("1.5")
    assert plan.targets[-1].price > Decimal("100.3")


def test_a_meaningful_level_still_caps_the_targets():
    from app.risk.sizing import build_plan

    plan = build_plan(
        direction="LONG",
        entry=Decimal("100"),
        stop=Decimal("95"),
        balance=Decimal("10000"),
        risk_pct=Decimal("1"),
        resistance=Decimal("108"),  # well beyond half the stop distance
    )
    assert all(t.price <= Decimal("108") for t in plan.targets)
