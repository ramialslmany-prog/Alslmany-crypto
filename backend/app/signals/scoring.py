"""The scoring system that turns analysis into a number.

Weights are exactly the ones specified:

    trend 20% · structure 20% · momentum 15% · volume 15%
    liquidity/SMC 15% · risk-reward 10% · news risk 5%

Two properties are enforced here rather than hoped for.

**Independence.** Each dimension is scored from a different kind of evidence.
Three momentum oscillators agreeing is one observation wearing three masks, and
counting it three times is how a system talks itself into a bad trade.

**Auditability.** Every contribution carries the reason it was awarded. A score
of 78 that cannot be broken down into what produced it is a number to be
believed rather than checked, and this platform's whole claim is the opposite.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class Direction(StrEnum):
    LONG = "LONG"
    SHORT = "SHORT"
    NO_TRADE = "NO_TRADE"


WEIGHTS: dict[str, float] = {
    "trend": 20.0,
    "structure": 20.0,
    "momentum": 15.0,
    "volume": 15.0,
    "liquidity": 15.0,
    "risk_reward": 10.0,
    "news_risk": 5.0,
}

assert abs(sum(WEIGHTS.values()) - 100.0) < 1e-9, "weights must total 100"


@dataclass(frozen=True, slots=True)
class Factor:
    """One dimension's verdict, with the evidence behind it.

    `raw` runs -1 (maximally bearish) to +1 (maximally bullish). 0 means the
    dimension had nothing to say — which is different from it saying "neutral
    after weighing the evidence", and both are different from it being absent.
    """

    dimension: str
    raw: float
    weight: float
    reasons: tuple[str, ...]
    available: bool = True

    @property
    def contribution(self) -> float:
        """Signed points this dimension contributes, at full weight."""
        return self.raw * self.weight if self.available else 0.0


@dataclass(frozen=True, slots=True)
class Score:
    direction: Direction
    confidence: float  # 0-100
    bias: float  # -100 (bearish) .. +100 (bullish)
    factors: tuple[Factor, ...]

    @property
    def available_weight(self) -> float:
        return sum(f.weight for f in self.factors if f.available)

    @property
    def bullish_reasons(self) -> tuple[str, ...]:
        return tuple(r for f in self.factors if f.raw > 0 for r in f.reasons)

    @property
    def bearish_reasons(self) -> tuple[str, ...]:
        return tuple(r for f in self.factors if f.raw < 0 for r in f.reasons)

    def breakdown(self) -> list[dict[str, object]]:
        return [
            {
                "dimension": f.dimension,
                "raw": round(f.raw, 4),
                "weight": f.weight,
                "contribution": round(f.contribution, 2),
                "available": f.available,
                "reasons": list(f.reasons),
            }
            for f in self.factors
        ]


def combine(factors: list[Factor]) -> Score:
    """Reduce the factors to a direction and a confidence.

    Confidence is scaled by how much of the weight was actually *available*, not
    by the full 100. If the news feed is down and liquidity could not be read,
    the remaining evidence cannot honestly produce the same confidence it would
    with everything present — a system that scores 80 on partial information and
    80 on complete information is hiding the difference that matters.
    """
    available = sum(f.weight for f in factors if f.available)
    if available <= 0:
        return Score(direction=Direction.NO_TRADE, confidence=0.0, bias=0.0, factors=tuple(factors))

    signed = sum(f.contribution for f in factors)
    bias = signed / available * 100

    # Confidence is the strength of the lean, discounted by missing evidence.
    coverage = available / sum(WEIGHTS.values())
    confidence = abs(bias) * coverage

    if bias > 0:
        direction = Direction.LONG
    elif bias < 0:
        direction = Direction.SHORT
    else:
        direction = Direction.NO_TRADE

    return Score(
        direction=direction,
        confidence=round(min(confidence, 100.0), 2),
        bias=round(bias, 2),
        factors=tuple(factors),
    )
