"""Volatility: ATR, Bollinger bands, and the regime they imply.

ATR matters more than any other number in this codebase, because from Stage 5
onward it sets stop distance — and stop distance sets position size. An ATR that
is wrong by a third makes every position size wrong by a third.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import StrEnum


def true_range(high: list[float], low: list[float], close: list[float]) -> list[float]:
    """Wilder's true range.

    The two gap terms are the whole point: a market that opens far from
    yesterday's close has moved that distance even though no bar spans it, and a
    stop placed on the high-minus-low alone would sit inside noise it cannot
    survive.
    """
    out: list[float] = []
    for i in range(len(close)):
        if i == 0:
            out.append(high[i] - low[i])
            continue
        out.append(
            max(
                high[i] - low[i],
                abs(high[i] - close[i - 1]),
                abs(low[i] - close[i - 1]),
            )
        )
    return out


def atr_series(
    high: list[float], low: list[float], close: list[float], period: int = 14
) -> list[float | None]:
    out: list[float | None] = [None] * len(close)
    if period <= 0 or len(close) < period:
        return out

    tr = true_range(high, low, close)
    current = sum(tr[:period]) / period
    out[period - 1] = current
    for i in range(period, len(tr)):
        # Wilder's smoothing again — not an EMA.
        current = (current * (period - 1) + tr[i]) / period
        out[i] = current
    return out


def atr(high: list[float], low: list[float], close: list[float], period: int = 14) -> float | None:
    series = atr_series(high, low, close, period)
    return series[-1] if series else None


@dataclass(frozen=True, slots=True)
class Bollinger:
    upper: float
    middle: float
    lower: float
    width_pct: float
    percent_b: float

    @property
    def is_squeezed(self) -> bool:
        """A band width under 4% of price is historically compressed.

        A squeeze says a move is *coming*, never which way — it is used here to
        raise attention, never to pick a direction.
        """
        return self.width_pct < 4.0


def bollinger(close: list[float], period: int = 20, deviations: float = 2.0) -> Bollinger | None:
    if len(close) < period:
        return None

    window = close[-period:]
    middle = sum(window) / period
    variance = sum((value - middle) ** 2 for value in window) / period
    sd = math.sqrt(variance)

    upper = middle + deviations * sd
    lower = middle - deviations * sd
    span = upper - lower

    return Bollinger(
        upper=upper,
        middle=middle,
        lower=lower,
        width_pct=(span / middle * 100) if middle else 0.0,
        # Where price sits within the bands: 0 at the lower, 1 at the upper.
        percent_b=0.5 if span == 0 else (close[-1] - lower) / span,
    )


class Volatility(StrEnum):
    VERY_LOW = "very_low"
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    EXTREME = "extreme"


@dataclass(frozen=True, slots=True)
class VolatilityReading:
    regime: Volatility
    atr: float | None
    atr_pct: float | None
    percentile: float | None

    @property
    def is_tradeable(self) -> bool:
        """Extreme volatility is not an opportunity, it is a liquidation risk.

        Stops get run on noise, slippage stops resembling its estimate, and
        position sizing built on a stale ATR understates what is at stake.
        """
        return self.regime is not Volatility.EXTREME


def classify_volatility(
    high: list[float], low: list[float], close: list[float], period: int = 14
) -> VolatilityReading:
    series = atr_series(high, low, close, period)
    current = series[-1]
    price = close[-1] if close else None

    if current is None or not price:
        return VolatilityReading(regime=Volatility.NORMAL, atr=None, atr_pct=None, percentile=None)

    atr_pct = current / price * 100

    history = [v for v in series if v is not None]
    percentile = None
    if len(history) >= 30:
        below = sum(1 for v in history if v < current)
        percentile = below / len(history) * 100

    # Rank AND magnitude, both. Rank alone calls a dead-flat market "extreme"
    # the moment it ticks above its own floor; magnitude alone ignores what is
    # normal for this particular asset.
    if percentile is None:
        regime = (
            Volatility.EXTREME
            if atr_pct > 8
            else Volatility.HIGH
            if atr_pct > 4
            else Volatility.LOW
            if atr_pct < 1
            else Volatility.NORMAL
        )
    elif percentile > 90 and atr_pct > 3:
        regime = Volatility.EXTREME
    elif percentile > 75 and atr_pct > 1.5:
        regime = Volatility.HIGH
    elif percentile < 10 and atr_pct < 1.5:
        regime = Volatility.VERY_LOW
    elif percentile < 25:
        regime = Volatility.LOW
    else:
        regime = Volatility.NORMAL

    return VolatilityReading(regime=regime, atr=current, atr_pct=atr_pct, percentile=percentile)
