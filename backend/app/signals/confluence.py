"""Checking a signal against the timeframe above it.

The seven scored dimensions all read one timeframe. That leaves the engine
unable to tell apart two setups that look identical on the hourly: one running
with the 4h trend and one running into it. A discretionary trader checks this
first, and it is the single most common reason a technically clean setup fails.

**The penalty is asymmetric, and that is deliberate.** Conflict cuts
confidence; alignment does not raise it. The reasoning is that the seven
dimensions have already measured how good the evidence on this timeframe is —
a higher timeframe agreeing does not make that evidence stronger, it just fails
to contradict it. Paying a bonus for agreement would inflate confidence past
what was actually measured, and would double-count trend, which the trend factor
already scores. What the higher timeframe genuinely adds is the ability to say
"this setup is fighting a bigger tide", so that is the only thing it is allowed
to say.

**It never converts a NO_TRADE into a TRADE**, for the same reason: it can only
subtract.

This is applied as a multiplier on confidence rather than as an eighth weighted
factor, because the specification fixes the seven weights at 100 and quietly
adding to them would make the published breakdown a fiction.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.analysis.resample import HIGHER_TIMEFRAME, resample
from app.analysis.series import Series
from app.analysis.trend import Trend, TrendReading, classify_trend

# Below this there is not enough resampled history for the moving-average stack
# to mean anything, and a penalty drawn from noise is worse than no penalty.
MIN_HIGHER_BARS = 50

# Graded, not binary. A setup against a mild higher-timeframe drift is worse
# than one running with it; a setup against a decisive one is usually just
# wrong. 0.70 is enough to take an 85-confidence signal below the 75 floor,
# which is the intended effect: strong opposition should veto.
STRONGLY_AGAINST = 0.70
AGAINST = 0.85
UNDECIDED = 0.95
ALIGNED = 1.0


@dataclass(frozen=True, slots=True)
class Confluence:
    timeframe: str
    higher_timeframe: str
    agreement: str  # aligned | against | strongly-against | undecided | unavailable
    multiplier: float
    higher_trend: str | None
    bars: int
    note: str

    @property
    def measured(self) -> bool:
        return self.agreement != "unavailable"

    def to_dict(self) -> dict[str, object]:
        return {
            "timeframe": self.timeframe,
            "higher_timeframe": self.higher_timeframe,
            "agreement": self.agreement,
            "multiplier": round(self.multiplier, 4),
            "higher_trend": self.higher_trend,
            "bars": self.bars,
            "note": self.note,
        }


def _unavailable(timeframe: str, higher: str, bars: int, why: str) -> Confluence:
    return Confluence(
        timeframe=timeframe,
        higher_timeframe=higher,
        agreement="unavailable",
        # Not penalised. An unmeasurable higher timeframe is an absence of
        # evidence, and docking confidence for it would punish the newest
        # listings hardest for a fact about the data rather than the setup.
        multiplier=ALIGNED,
        higher_trend=None,
        bars=bars,
        note=why,
    )


def assess(series: Series, timeframe: str, direction: str) -> Confluence:
    """Read the timeframe above and decide whether this trade fights it."""
    higher = HIGHER_TIMEFRAME.get(timeframe, "")
    if not higher:
        return _unavailable(
            timeframe,
            higher,
            0,
            "This is the highest timeframe the engine reads; there is nothing "
            "above it to check against.",
        )

    coarse = resample(series, higher)
    if len(coarse) < MIN_HIGHER_BARS:
        return _unavailable(
            timeframe,
            higher,
            len(coarse),
            f"Only {len(coarse)} {higher} candles could be built from this "
            f"window; {MIN_HIGHER_BARS} are needed before a trend there means "
            "anything. No penalty is applied for data the engine does not have.",
        )

    reading = classify_trend(coarse.close)
    return _judge(timeframe, higher, direction, reading, len(coarse))


def _judge(
    timeframe: str, higher: str, direction: str, reading: TrendReading, bars: int
) -> Confluence:
    trend = reading.trend

    if trend is Trend.NEUTRAL:
        return Confluence(
            timeframe=timeframe,
            higher_timeframe=higher,
            agreement="undecided",
            multiplier=UNDECIDED,
            higher_trend=trend.value,
            bars=bars,
            note=(
                f"The {higher} trend is undecided, so it neither supports this "
                "trade nor opposes it."
            ),
        )

    with_trade = (direction == "LONG" and reading.is_bullish) or (
        direction == "SHORT" and reading.is_bearish
    )

    if with_trade:
        return Confluence(
            timeframe=timeframe,
            higher_timeframe=higher,
            agreement="aligned",
            multiplier=ALIGNED,
            higher_trend=trend.value,
            bars=bars,
            note=(
                f"The {higher} trend is {trend.value.replace('_', ' ')}, which "
                f"runs with this {direction.lower()}."
            ),
        )

    strong = trend in (Trend.STRONG_UP, Trend.STRONG_DOWN)
    return Confluence(
        timeframe=timeframe,
        higher_timeframe=higher,
        agreement="strongly-against" if strong else "against",
        multiplier=STRONGLY_AGAINST if strong else AGAINST,
        higher_trend=trend.value,
        bars=bars,
        note=(
            f"The {higher} trend is {trend.value.replace('_', ' ')}, which this "
            f"{direction.lower()} is trading against. Confidence is cut "
            f"accordingly; the setup has to be better than usual to survive it."
        ),
    )


def apply(confidence: float, confluence: Confluence) -> float:
    """The multiplier, applied where it can be seen rather than folded away."""
    return round(min(confidence * confluence.multiplier, 100.0), 2)
