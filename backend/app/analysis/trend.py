"""Moving averages and the trend reading built from them."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


def sma(values: list[float], period: int) -> float | None:
    """Simple moving average of the last `period` values."""
    if period <= 0 or len(values) < period:
        return None
    return sum(values[-period:]) / period


def sma_series(values: list[float], period: int) -> list[float | None]:
    if period <= 0:
        return [None] * len(values)
    out: list[float | None] = [None] * len(values)
    if len(values) < period:
        return out
    window = sum(values[:period])
    out[period - 1] = window / period
    for i in range(period, len(values)):
        # Rolling update rather than re-summing: O(n) instead of O(n*period),
        # which matters once this runs across five symbols and six timeframes.
        window += values[i] - values[i - period]
        out[i] = window / period
    return out


def ema_series(values: list[float], period: int) -> list[float | None]:
    """Exponential moving average.

    Seeded with the SMA of the first `period` values, which is the convention
    every charting platform uses. Seeding with the first price instead makes the
    early values wrong in a way that slowly decays, so a backtest over a short
    window disagrees with the chart the user is looking at.
    """
    out: list[float | None] = [None] * len(values)
    if period <= 0 or len(values) < period:
        return out

    multiplier = 2.0 / (period + 1)
    current = sum(values[:period]) / period
    out[period - 1] = current
    for i in range(period, len(values)):
        current = (values[i] - current) * multiplier + current
        out[i] = current
    return out


def ema(values: list[float], period: int) -> float | None:
    series = ema_series(values, period)
    return series[-1] if series else None


class Trend(StrEnum):
    STRONG_UP = "strong_up"
    UP = "up"
    NEUTRAL = "neutral"
    DOWN = "down"
    STRONG_DOWN = "strong_down"


@dataclass(frozen=True, slots=True)
class TrendReading:
    trend: Trend
    ema20: float | None
    ema50: float | None
    ema200: float | None
    price_vs_ema200_pct: float | None
    # Which specific conditions held, so a verdict can be audited rather than
    # taken on faith.
    evidence: tuple[str, ...]

    @property
    def is_bullish(self) -> bool:
        return self.trend in (Trend.UP, Trend.STRONG_UP)

    @property
    def is_bearish(self) -> bool:
        return self.trend in (Trend.DOWN, Trend.STRONG_DOWN)


def classify_trend(close: list[float]) -> TrendReading:
    """Read trend from the 20/50/200 EMA stack.

    Stacked averages are used rather than a single slope because the stack says
    something a slope cannot: whether short, medium and long-term participants
    agree. When they disagree the honest answer is `NEUTRAL`, and returning that
    is the point — a system that always has an opinion has no information in it.
    """
    e20, e50, e200 = ema(close, 20), ema(close, 50), ema(close, 200)
    price = close[-1] if close else None

    evidence: list[str] = []
    score = 0

    if price is not None and e20 is not None:
        if price > e20:
            score += 1
            evidence.append("price-above-ema20")
        else:
            score -= 1
            evidence.append("price-below-ema20")

    if e20 is not None and e50 is not None:
        if e20 > e50:
            score += 1
            evidence.append("ema20-above-ema50")
        else:
            score -= 1
            evidence.append("ema20-below-ema50")

    if e50 is not None and e200 is not None:
        if e50 > e200:
            score += 1
            evidence.append("ema50-above-ema200")
        else:
            score -= 1
            evidence.append("ema50-below-ema200")

    if price is not None and e200 is not None:
        if price > e200:
            score += 1
            evidence.append("price-above-ema200")
        else:
            score -= 1
            evidence.append("price-below-ema200")

    # With fewer than 200 bars the long-term legs are unavailable, so the score
    # cannot reach the extremes. That is correct: a "strong" verdict should not
    # be reachable without the evidence that would justify it.
    if score >= 3:
        trend = Trend.STRONG_UP
    elif score >= 1:
        trend = Trend.UP
    elif score <= -3:
        trend = Trend.STRONG_DOWN
    elif score <= -1:
        trend = Trend.DOWN
    else:
        trend = Trend.NEUTRAL

    distance = None
    if price is not None and e200 is not None and e200 != 0:
        distance = (price - e200) / e200 * 100

    return TrendReading(
        trend=trend,
        ema20=e20,
        ema50=e50,
        ema200=e200,
        price_vs_ema200_pct=distance,
        evidence=tuple(evidence),
    )
