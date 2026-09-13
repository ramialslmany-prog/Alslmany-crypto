"""Scoring each dimension from the analysis layer.

Every function returns a `Factor` — never a bare number — so the reason a
dimension leaned the way it did travels with the value it produced.
"""

from __future__ import annotations

from app.analysis.momentum import Macd, Stochastic
from app.analysis.structure import BreakKind, Structure, StructureState
from app.analysis.trend import Trend, TrendReading
from app.analysis.volatility import VolatilityReading
from app.analysis.volume import VolumeReading, VolumeState
from app.signals.scoring import WEIGHTS, Factor

TREND_SCORE: dict[Trend, float] = {
    Trend.STRONG_UP: 1.0,
    Trend.UP: 0.5,
    Trend.NEUTRAL: 0.0,
    Trend.DOWN: -0.5,
    Trend.STRONG_DOWN: -1.0,
}


def score_trend(reading: TrendReading) -> Factor:
    reasons = [f"trend-{reading.trend.value}"]
    reasons.extend(reading.evidence)
    return Factor(
        dimension="trend",
        raw=TREND_SCORE[reading.trend],
        weight=WEIGHTS["trend"],
        reasons=tuple(reasons),
        available=reading.ema20 is not None,
    )


def score_structure(structure: Structure) -> Factor:
    if structure.state is StructureState.UNKNOWN:
        return Factor(
            dimension="structure",
            raw=0.0,
            weight=WEIGHTS["structure"],
            reasons=("structure-unknown",),
            available=False,
        )

    raw = 0.0
    reasons: list[str] = [f"structure-{structure.state.value}"]

    if structure.state is StructureState.BULLISH:
        raw += 0.6
    elif structure.state is StructureState.BEARISH:
        raw -= 0.6

    last = structure.last_break
    if last is not None:
        # A change of character is weighted more heavily than a continuation
        # break: it is the first evidence the prevailing trend has ended, which
        # is worth more than confirmation of what was already visible.
        magnitude = 0.4 if last.kind is BreakKind.CHOCH else 0.25
        raw += magnitude if last.direction == "up" else -magnitude
        reasons.append(f"{last.kind.value}-{last.direction}")

    return Factor(
        dimension="structure",
        raw=max(-1.0, min(1.0, raw)),
        weight=WEIGHTS["structure"],
        reasons=tuple(reasons),
    )


def score_momentum(
    rsi_value: float | None, macd_value: Macd | None, stoch: Stochastic | None
) -> Factor:
    """RSI, MACD and Stochastic are correlated, so they share one dimension.

    Giving each its own weight would let one underlying observation — "price has
    been rising" — be counted three times, which is precisely the confirmation
    bias this design is meant to resist.
    """
    if rsi_value is None and macd_value is None:
        return Factor(
            dimension="momentum",
            raw=0.0,
            weight=WEIGHTS["momentum"],
            reasons=("momentum-unavailable",),
            available=False,
        )

    parts: list[float] = []
    reasons: list[str] = []

    if rsi_value is not None:
        if rsi_value >= 70:
            # Overbought is not bearish on its own — strong trends stay
            # overbought for a long time — but it does cap the upside here.
            parts.append(0.2)
            reasons.append("rsi-overbought")
        elif rsi_value <= 30:
            parts.append(-0.2)
            reasons.append("rsi-oversold")
        else:
            parts.append((rsi_value - 50) / 20)
            reasons.append(f"rsi-{round(rsi_value)}")

    if macd_value is not None:
        parts.append(0.6 if macd_value.is_bullish else -0.6)
        reasons.append("macd-bullish" if macd_value.is_bullish else "macd-bearish")

    if stoch is not None:
        if stoch.is_overbought:
            parts.append(-0.1)
            reasons.append("stoch-overbought")
        elif stoch.is_oversold:
            parts.append(0.1)
            reasons.append("stoch-oversold")

    raw = sum(parts) / len(parts) if parts else 0.0
    return Factor(
        dimension="momentum",
        raw=max(-1.0, min(1.0, raw)),
        weight=WEIGHTS["momentum"],
        reasons=tuple(reasons),
    )


def score_volume(reading: VolumeReading, direction_hint: float) -> Factor:
    """Volume confirms or contradicts a move; it has no direction of its own.

    `direction_hint` is the lean from price-based dimensions. Volume amplifies
    it when participation is real and drags it toward zero when the move is
    happening on nobody trading.
    """
    if reading.relative is None:
        return Factor(
            dimension="volume",
            raw=0.0,
            weight=WEIGHTS["volume"],
            reasons=("volume-baseline-unavailable",),
            available=False,
        )

    reasons = [f"volume-{reading.state.value}"]
    if reading.state is VolumeState.SPIKE:
        strength = 1.0
    elif reading.state is VolumeState.ELEVATED:
        strength = 0.6
    elif reading.state is VolumeState.DRIED_UP:
        strength = -0.5
        reasons.append("move-unsupported-by-participation")
    elif reading.state is VolumeState.BELOW_AVERAGE:
        strength = -0.2
    else:
        strength = 0.0

    if reading.price_vs_vwap_pct is not None:
        above = reading.price_vs_vwap_pct > 0
        reasons.append("price-above-vwap" if above else "price-below-vwap")

    if reading.obv_rising is not None:
        reasons.append("obv-rising" if reading.obv_rising else "obv-falling")

    # Signed by the prevailing lean: strong volume against a bullish setup is
    # not bullish.
    lean = 1.0 if direction_hint >= 0 else -1.0
    return Factor(
        dimension="volume",
        raw=max(-1.0, min(1.0, strength * lean)),
        weight=WEIGHTS["volume"],
        reasons=tuple(reasons),
    )


def score_liquidity(structure: Structure, direction_hint: float) -> Factor:
    """SMC context: sweeps, gaps, order blocks and where price sits in range."""
    if not structure.detected:
        return Factor(
            dimension="liquidity",
            raw=0.0,
            weight=WEIGHTS["liquidity"],
            reasons=("no-smc-context",),
            available=False,
        )

    raw = 0.0
    reasons: list[str] = []

    if structure.sweeps:
        latest = structure.sweeps[-1]
        # Taking sell-side liquidity and rejecting is a bullish tell, and the
        # mirror for buy-side. This is the one place a sweep is directional.
        raw += 0.4 if latest.direction == "low" else -0.4
        reasons.append(f"swept-{latest.direction}-liquidity")

    if structure.fair_value_gaps:
        latest = structure.fair_value_gaps[-1]
        raw += 0.25 if latest.direction == "bullish" else -0.25
        reasons.append(f"{latest.direction}-fair-value-gap")

    if structure.order_blocks:
        latest = structure.order_blocks[-1]
        raw += 0.2 if latest.direction == "bullish" else -0.2
        reasons.append(f"{latest.direction}-order-block")

    zone = structure.premium_discount
    if zone is not None:
        reasons.append(f"price-in-{zone.zone}")
        # Buying premium is buying what someone else is distributing.
        if zone.zone == "premium" and direction_hint > 0:
            raw -= 0.3
            reasons.append("long-into-premium")
        elif zone.zone == "discount" and direction_hint < 0:
            raw += 0.3
            reasons.append("short-into-discount")
        elif zone.zone == "discount" and direction_hint > 0:
            raw += 0.2

    return Factor(
        dimension="liquidity",
        raw=max(-1.0, min(1.0, raw)),
        weight=WEIGHTS["liquidity"],
        reasons=tuple(reasons),
    )


def score_risk_reward(rr: float | None) -> Factor:
    """Reward-to-risk, scored on the plan rather than on the chart."""
    if rr is None:
        return Factor(
            dimension="risk_reward",
            raw=0.0,
            weight=WEIGHTS["risk_reward"],
            reasons=("no-plan",),
            available=False,
        )

    if rr >= 3.0:
        raw, reason = 1.0, "rr-excellent"
    elif rr >= 2.0:
        raw, reason = 0.7, "rr-good"
    elif rr >= 1.5:
        raw, reason = 0.3, "rr-acceptable"
    else:
        # Below the floor this is not a weak positive, it is a reason not to
        # trade — a 1.2R setup needs a win rate most strategies do not have.
        raw, reason = -1.0, "rr-below-minimum"

    return Factor(
        dimension="risk_reward",
        raw=raw,
        weight=WEIGHTS["risk_reward"],
        reasons=(reason, f"rr-{rr:.2f}"),
    )


def score_news_risk(volatility: VolatilityReading, news_flag: str | None = None) -> Factor:
    """Event risk.

    No news API is wired in, so this scores what *is* observable — a volatility
    regime that usually accompanies an event — and says so. It never invents a
    headline. When a real feed is added it replaces this reading rather than
    supplementing it.
    """
    reasons: list[str] = []
    raw = 0.0

    if news_flag:
        return Factor(
            dimension="news_risk",
            raw=-1.0,
            weight=WEIGHTS["news_risk"],
            reasons=(f"news-{news_flag}",),
        )

    if not volatility.is_tradeable:
        raw = -1.0
        reasons.append("volatility-extreme")
    elif volatility.percentile is not None and volatility.percentile > 85:
        raw = -0.4
        reasons.append("volatility-elevated")
    else:
        reasons.append("no-news-feed-configured")

    return Factor(
        dimension="news_risk", raw=raw, weight=WEIGHTS["news_risk"], reasons=tuple(reasons)
    )
