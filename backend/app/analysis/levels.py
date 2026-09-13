"""Support and resistance derived from actual swing points.

Levels are found from price the market already turned at, never from round
numbers or fixed percentages. A level nobody traded is not a level.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class SwingKind(StrEnum):
    HIGH = "high"
    LOW = "low"


@dataclass(frozen=True, slots=True)
class Swing:
    index: int
    price: float
    kind: SwingKind


def find_swings(high: list[float], low: list[float], lookback: int = 2) -> list[Swing]:
    """Pivot points with `lookback` bars either side.

    The comparison is asymmetric — strictly greater on the left, greater-or-equal
    on the right — so that a flat top still registers. A symmetric strict test
    silently discards double tops, which are exactly the formations that matter
    most for resistance.
    """
    swings: list[Swing] = []
    for i in range(lookback, len(high) - lookback):
        left = range(i - lookback, i)
        right = range(i + 1, i + lookback + 1)

        if all(high[i] > high[j] for j in left) and all(high[i] >= high[j] for j in right):
            swings.append(Swing(index=i, price=high[i], kind=SwingKind.HIGH))
        elif all(low[i] < low[j] for j in left) and all(low[i] <= low[j] for j in right):
            swings.append(Swing(index=i, price=low[i], kind=SwingKind.LOW))
    return swings


@dataclass(frozen=True, slots=True)
class Level:
    price: float
    touches: int
    kind: SwingKind

    @property
    def strength(self) -> str:
        """More touches means more participants remember the price."""
        if self.touches >= 4:
            return "major"
        if self.touches >= 2:
            return "confirmed"
        return "minor"


@dataclass(frozen=True, slots=True)
class Levels:
    support: tuple[Level, ...]
    resistance: tuple[Level, ...]

    @property
    def nearest_support(self) -> Level | None:
        return self.support[0] if self.support else None

    @property
    def nearest_resistance(self) -> Level | None:
        return self.resistance[0] if self.resistance else None


def find_levels(
    high: list[float],
    low: list[float],
    close: list[float],
    *,
    lookback: int = 2,
    tolerance_pct: float = 0.4,
    limit: int = 5,
) -> Levels:
    """Cluster swing points into levels, split around the current price."""
    if not close:
        return Levels(support=(), resistance=())

    price = close[-1]
    swings = find_swings(high, low, lookback)

    clusters: list[list[Swing]] = []
    for swing in sorted(swings, key=lambda s: s.price):
        # Tolerance is proportional, not absolute: 0.4% is meaningful at both
        # $2 and $100,000, where a fixed dollar band is meaningless at one end.
        if (
            clusters
            and abs(swing.price - clusters[-1][-1].price) / swing.price * 100 <= tolerance_pct
        ):
            clusters[-1].append(swing)
        else:
            clusters.append([swing])

    support: list[Level] = []
    resistance: list[Level] = []
    for cluster in clusters:
        level_price = sum(s.price for s in cluster) / len(cluster)
        kind = SwingKind.LOW if level_price < price else SwingKind.HIGH
        level = Level(price=level_price, touches=len(cluster), kind=kind)
        (support if level_price < price else resistance).append(level)

    # Nearest first — the level price has to cross to get anywhere.
    support.sort(key=lambda level: price - level.price)
    resistance.sort(key=lambda level: level.price - price)

    return Levels(support=tuple(support[:limit]), resistance=tuple(resistance[:limit]))
