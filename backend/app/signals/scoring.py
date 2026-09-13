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
    # How much of the evidence that actually spoke agrees with the direction,
    # 0-1. Reported separately because it answers a different question from
    # `bias`, and the two are routinely confused.
    consensus: float = 0.0
    coverage: float = 0.0

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

    Confidence answers "how much should this be trusted", which is NOT the same
    question as "how bullish is the evidence" — and an earlier version of this
    function conflated them by reporting |bias| as confidence.

    Two situations produce a bias of 55: every dimension leaning moderately the
    same way, and several dimensions disagreeing violently while happening to
    net out. The first deserves to be acted on and the second does not, and a
    formula built on magnitude alone cannot tell them apart. It also made the
    75 floor unreachable — the best case attainable across all seven dimensions
    was 83.8, so qualifying demanded near-perfection everywhere at once, and the
    bot structurally never traded.

    Confidence is therefore built from three separable things:

        conviction — how hard the weighted evidence leans
        consensus  — how much of the evidence that SPOKE agrees with that lean
        coverage   — how much of the total weight was available at all

    A dimension with raw 0 gets no vote in consensus: it did not speak, and
    counting silence as disagreement is as wrong as counting it as assent.
    """
    available = sum(f.weight for f in factors if f.available)
    if available <= 0:
        return Score(direction=Direction.NO_TRADE, confidence=0.0, bias=0.0, factors=tuple(factors))

    signed = sum(f.contribution for f in factors)

    # Divide by the weight that actually SPOKE, not by every available weight.
    # Silence is already excluded from `consensus` on the stated grounds that
    # counting it as disagreement is as wrong as counting it as assent — and
    # leaving it in this denominator did exactly that to the lean. It capped a
    # textbook setup (perfect trend, bullish structure with a break, bullish
    # MACD, 3R) at 73.0 confidence against a 75 floor, in seven of eight
    # scenarios, so the bot could never trade. `coverage` below is what accounts
    # for missing evidence; doing it twice is double-counting it.
    speaking = [f for f in factors if f.available and f.raw != 0]
    speaking_weight = sum(f.weight for f in speaking)
    if speaking_weight <= 0:
        return Score(
            direction=Direction.NO_TRADE,
            confidence=0.0,
            bias=0.0,
            factors=tuple(factors),
            coverage=round(available / sum(WEIGHTS.values()), 4),
        )

    bias = signed / speaking_weight * 100

    if bias > 0:
        direction = Direction.LONG
    elif bias < 0:
        direction = Direction.SHORT
    else:
        direction = Direction.NO_TRADE

    coverage = available / sum(WEIGHTS.values())

    if speaking and direction is not Direction.NO_TRADE:
        wanted = 1 if direction is Direction.LONG else -1
        agreeing = sum(
            f.weight * abs(f.raw) for f in speaking if (1 if f.raw > 0 else -1) == wanted
        )
        total_voice = sum(f.weight * abs(f.raw) for f in speaking)
        consensus = agreeing / total_voice if total_voice else 0.0
    else:
        consensus = 0.0

    conviction = min(abs(bias) / 100.0, 1.0)

    # Geometric mean: strong but contested, or unanimous but weak, are both
    # penalised. Only strength AND agreement together produce a high number,
    # which is exactly the property the confidence floor exists to select for.
    confidence = (conviction * consensus) ** 0.5 * coverage * 100

    return Score(
        direction=direction,
        confidence=round(min(confidence, 100.0), 2),
        bias=round(bias, 2),
        factors=tuple(factors),
        consensus=round(consensus, 4),
        coverage=round(coverage, 4),
    )
