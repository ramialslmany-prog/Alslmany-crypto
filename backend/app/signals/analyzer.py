"""The analyser: candles in, an auditable signal out.

This is where the layers meet. Nothing here computes anything itself — it
assembles the readings from `app.analysis`, scores them through
`app.signals.scoring`, builds a plan with `app.risk`, and returns a result that
carries every input that produced it.

The structured output matches the shape the specification asked for, with one
addition that the specification's example lacked: `evidence`. A signal that
states a conclusion without the observations behind it cannot be checked, and
checking is the only thing that separates this from a horoscope.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from app.analysis.levels import find_levels
from app.analysis.momentum import macd, rsi, stochastic
from app.analysis.series import Series
from app.analysis.structure import analyse_structure
from app.analysis.trend import classify_trend
from app.analysis.volatility import bollinger, classify_volatility
from app.analysis.volume import analyse_volume
from app.risk.sizing import TradePlan, build_plan
from app.signals.confluence import Confluence, assess
from app.signals.confluence import apply as apply_confluence
from app.signals.factors import (
    score_liquidity,
    score_momentum,
    score_news_risk,
    score_risk_reward,
    score_structure,
    score_trend,
    score_volume,
)
from app.signals.scoring import Direction, Factor, Score, combine

# Below this there is not enough history for the 200 EMA or a meaningful
# volatility percentile, and a confident verdict would be unsupported.
MIN_BARS = 60


@dataclass(frozen=True, slots=True)
class Analysis:
    """Everything observed, before any verdict is drawn from it."""

    symbol: str
    timeframe: str
    price: float
    trend: Any
    structure: Any
    volatility: Any
    volume: Any
    levels: Any
    rsi: float | None
    macd: Any
    stochastic: Any
    bollinger: Any
    bars: int
    # Kept so the signal can read the timeframe above without fetching it. The
    # closed series is what every reading above was computed from, so a higher
    # timeframe derived from it cannot see anything they could not.
    series: Series | None = None


@dataclass(frozen=True, slots=True)
class Signal:
    symbol: str
    timeframe: str
    signal: str  # LONG | SHORT | NO_TRADE
    confidence: float
    score: float
    entry: Decimal | None
    stop_loss: Decimal | None
    take_profit: Decimal | None
    risk_reward: Decimal | None
    risk_level: str
    reason: str
    invalidation: str
    decision: str  # TRADE | NO_TRADE
    evidence: dict[str, Any]
    plan: TradePlan | None = None
    warnings: tuple[str, ...] = field(default=())

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "signal": self.signal,
            "confidence": round(self.confidence, 2),
            "score": round(self.score, 2),
            "entry": str(self.entry) if self.entry is not None else None,
            "stop_loss": str(self.stop_loss) if self.stop_loss is not None else None,
            "take_profit": str(self.take_profit) if self.take_profit is not None else None,
            "risk_reward": str(self.risk_reward) if self.risk_reward is not None else None,
            "risk_level": self.risk_level,
            "reason": self.reason,
            "invalidation": self.invalidation,
            "decision": self.decision,
            "evidence": self.evidence,
            "warnings": list(self.warnings),
            # The plan was computed and then dropped on the floor. Entry, stop
            # and one target are four prices; what a trader has to know before
            # acting is the SIZE, what being wrong costs in money, and that the
            # exit is staged in three parts rather than taken all at once. All
            # of it already existed here — it simply never reached the screen.
            "plan": self.plan.to_dict() if self.plan is not None else None,
        }


def analyse(series: Series, symbol: str, timeframe: str) -> Analysis | None:
    """Compute every reading from a candle series.

    The forming bar is dropped first. A signal fired on an incomplete candle is
    fired on a price that can still move against it before the bar even ends.
    """
    closed = series.closed_only()
    if len(closed) < MIN_BARS:
        return None

    return Analysis(
        symbol=symbol,
        timeframe=timeframe,
        price=closed.close[-1],
        trend=classify_trend(closed.close),
        structure=analyse_structure(closed.open, closed.high, closed.low, closed.close),
        volatility=classify_volatility(closed.high, closed.low, closed.close),
        volume=analyse_volume(closed.high, closed.low, closed.close, closed.volume),
        levels=find_levels(closed.high, closed.low, closed.close),
        rsi=rsi(closed.close),
        macd=macd(closed.close),
        stochastic=stochastic(closed.high, closed.low, closed.close),
        bollinger=bollinger(closed.close),
        bars=len(closed),
        series=closed,
    )


def build_signal(
    analysis: Analysis,
    *,
    balance: Decimal,
    risk_pct: Decimal,
    min_confidence: Decimal = Decimal("75"),
    min_reward_risk: Decimal = Decimal("1.5"),
) -> Signal:
    """Score the analysis and, if it qualifies, plan the trade.

    Scoring happens in two passes. The first establishes a directional lean from
    price-based evidence; the second scores volume and liquidity *against* that
    lean, because both are confirmations rather than directions of their own.
    Strong volume against a bullish setup is not bullish.
    """
    trend_factor = score_trend(analysis.trend)
    structure_factor = score_structure(analysis.structure)
    momentum_factor = score_momentum(analysis.rsi, analysis.macd, analysis.stochastic)

    lean = trend_factor.contribution + structure_factor.contribution + momentum_factor.contribution

    volume_factor = score_volume(analysis.volume, lean)
    liquidity_factor = score_liquidity(analysis.structure, lean)
    news_factor = score_news_risk(analysis.volatility, direction_hint=lean)

    price = Decimal(str(analysis.price))
    direction = "LONG" if lean >= 0 else "SHORT"

    # The stop comes from volatility and structure, never from a round
    # percentage. A stop that ignores how far this asset normally travels is a
    # stop that gets taken by ordinary noise.
    stop = _derive_stop(analysis, direction, price)
    plan = None
    if stop is not None and stop != price:
        plan = build_plan(
            direction=direction,
            entry=price,
            stop=stop,
            balance=balance,
            risk_pct=risk_pct,
            atr=Decimal(str(analysis.volatility.atr)) if analysis.volatility.atr else None,
            resistance=(
                Decimal(str(analysis.levels.nearest_resistance.price))
                if analysis.levels.nearest_resistance
                else None
            ),
            support=(
                Decimal(str(analysis.levels.nearest_support.price))
                if analysis.levels.nearest_support
                else None
            ),
        )

    rr_factor = score_risk_reward(float(plan.reward_risk) if plan else None, direction_hint=lean)

    factors: list[Factor] = [
        trend_factor,
        structure_factor,
        momentum_factor,
        volume_factor,
        liquidity_factor,
        rr_factor,
        news_factor,
    ]
    score = combine(factors)

    # The timeframe above, read AFTER the seven dimensions rather than among
    # them: the specification fixes those weights at 100, and quietly adding an
    # eighth would make the published breakdown a fiction. It can only subtract.
    confluence = assess(
        analysis.series if analysis.series is not None else _no_series(),
        analysis.timeframe,
        direction,
    )
    confidence = apply_confluence(score.confidence, confluence)

    warnings = _warnings(analysis, plan)
    if confluence.agreement in ("against", "strongly-against"):
        warnings = (*warnings, f"against-{confluence.higher_timeframe}-trend")

    qualifies = (
        score.direction is not Direction.NO_TRADE
        and Decimal(str(confidence)) >= min_confidence
        and plan is not None
        and plan.reward_risk >= min_reward_risk
        and analysis.volatility.is_tradeable
    )

    return Signal(
        symbol=analysis.symbol,
        timeframe=analysis.timeframe,
        signal=score.direction.value if qualifies else Direction.NO_TRADE.value,
        confidence=confidence,
        score=abs(score.bias),
        entry=plan.entry if plan and qualifies else None,
        stop_loss=plan.stop if plan and qualifies else None,
        take_profit=plan.take_profit if plan and qualifies else None,
        risk_reward=plan.reward_risk if plan else None,
        risk_level=_risk_level(analysis, score),
        reason=_reason(score, analysis, qualifies, confluence),
        invalidation=plan.invalidation if plan else "No plan: no invalidation level.",
        decision="TRADE" if qualifies else "NO_TRADE",
        evidence={
            "factors": score.breakdown(),
            "bullish": list(score.bullish_reasons),
            "bearish": list(score.bearish_reasons),
            "detected": list(analysis.structure.detected),
            "bars_analysed": analysis.bars,
            "available_weight": score.available_weight,
            # Reported whether or not it changed anything, so "no penalty" and
            # "not checked" can be told apart.
            "confluence": confluence.to_dict(),
            "confidence_before_confluence": round(score.confidence, 2),
        },
        plan=plan if qualifies else None,
        warnings=warnings,
    )


def _derive_stop(analysis: Analysis, direction: str, price: Decimal) -> Decimal | None:
    """Place the stop beyond the level that would prove the idea wrong."""
    atr = analysis.volatility.atr
    if atr is None:
        return None

    buffer = Decimal(str(atr)) * Decimal("1.5")

    if direction == "LONG":
        support = analysis.levels.nearest_support
        if support is not None:
            # Just under the level, not exactly on it: a stop sitting on an
            # obvious level is a stop other participants can see.
            candidate = Decimal(str(support.price)) - Decimal(str(atr)) * Decimal("0.3")
            return min(candidate, price - buffer)
        return price - buffer

    resistance = analysis.levels.nearest_resistance
    if resistance is not None:
        candidate = Decimal(str(resistance.price)) + Decimal(str(atr)) * Decimal("0.3")
        return max(candidate, price + buffer)
    return price + buffer


def _risk_level(analysis: Analysis, score: Score) -> str:
    if not analysis.volatility.is_tradeable:
        return "EXTREME"
    if analysis.volatility.regime.value in ("high",):
        return "HIGH"
    if score.confidence >= 80 and analysis.volatility.regime.value in ("low", "normal"):
        return "LOW"
    return "MEDIUM"


def _reason(score: Score, analysis: Analysis, qualifies: bool, confluence: Confluence) -> str:
    """A sentence built from what was measured.

    Deliberately assembled from the factor reasons rather than written freely,
    so the prose cannot drift from the numbers it claims to describe.

    `confidence` here is the FINAL number — after the higher-timeframe
    multiplier — because that is the number the gate compared against the floor.
    Quoting the pre-multiplier score would print "confidence 82 is below the 75
    floor", which is the exact species of self-contradiction a card on this
    dashboard was once caught committing.
    """
    confidence = apply_confluence(score.confidence, confluence)

    if not qualifies:
        parts = []
        if confidence < 75:
            reason = f"confidence {confidence:.0f} is below the 75 floor"
            if confluence.multiplier < 1.0:
                reason += (
                    f" (cut from {score.confidence:.0f} by the {confluence.higher_timeframe} trend)"
                )
            parts.append(reason)
        if not analysis.volatility.is_tradeable:
            parts.append("volatility is extreme")
        supporting = score.bullish_reasons if score.bias > 0 else score.bearish_reasons
        if supporting:
            parts.append(f"evidence so far: {', '.join(supporting[:3])}")
        return "No trade: " + ("; ".join(parts) if parts else "no qualifying setup.")

    side = "Bullish" if score.direction is Direction.LONG else "Bearish"
    supporting = score.bullish_reasons if score.bias > 0 else score.bearish_reasons
    against = score.bearish_reasons if score.bias > 0 else score.bullish_reasons

    sentence = f"{side}: {', '.join(supporting[:4])}."
    if confluence.agreement == "aligned":
        sentence += f" The {confluence.higher_timeframe} trend runs with it."
    elif confluence.multiplier < 1.0:
        sentence += f" Taken against the {confluence.higher_timeframe} trend."
    if against:
        # The counter-evidence is published beside the supporting evidence, even
        # when the verdict is positive. Showing only the agreeing side is
        # confirmation bias with a user interface.
        sentence += f" Against: {', '.join(against[:3])}."
    return sentence


def _warnings(analysis: Analysis, plan: TradePlan | None) -> tuple[str, ...]:
    out: list[str] = []
    if not analysis.volatility.is_tradeable:
        out.append("volatility-extreme")
    if analysis.volume.state.value in ("dried_up", "below_average"):
        out.append("thin-participation")
    if plan is not None and plan.size.capped:
        out.append("position-capped-by-exposure-limit")
    if analysis.structure.premium_discount is not None:
        zone = analysis.structure.premium_discount.zone
        if zone == "premium":
            out.append("price-in-premium")
    if analysis.bars < 200:
        out.append("limited-history")
    return tuple(out)


def _no_series() -> Series:
    """An empty series, for an `Analysis` built before this field existed.

    `assess` reports "unavailable" for it and applies no penalty, which is the
    correct reading: nothing was checked, so nothing is docked.
    """
    return Series(open=[], high=[], low=[], close=[], volume=[], times=[], closed=[])
