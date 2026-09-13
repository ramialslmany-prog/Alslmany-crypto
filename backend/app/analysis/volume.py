"""Volume: VWAP, relative volume, OBV, and confirmation.

Volume is the only input here that says something about *participation* rather
than price. A breakout on thin volume and the same breakout on triple volume
look identical on a price chart and are not the same event.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


def typical_price(high: list[float], low: list[float], close: list[float]) -> list[float]:
    return [(h + low[i] + close[i]) / 3 for i, h in enumerate(high)]


def vwap(
    high: list[float], low: list[float], close: list[float], volume: list[float]
) -> float | None:
    """Volume-weighted average price over the supplied window.

    Anchored to the window given rather than to a session, because crypto has no
    session — there is no daily open to reset at, and pretending otherwise puts
    the anchor at an arbitrary UTC midnight that means nothing to the market.
    """
    total_volume = sum(volume)
    if total_volume <= 0:
        return None
    tp = typical_price(high, low, close)
    return sum(t * v for t, v in zip(tp, volume, strict=True)) / total_volume


def obv(close: list[float], volume: list[float]) -> list[float]:
    """On-balance volume: cumulative volume signed by the day's direction."""
    out = [0.0]
    for i in range(1, len(close)):
        if close[i] > close[i - 1]:
            out.append(out[-1] + volume[i])
        elif close[i] < close[i - 1]:
            out.append(out[-1] - volume[i])
        else:
            out.append(out[-1])
    return out


class VolumeState(StrEnum):
    DRIED_UP = "dried_up"
    BELOW_AVERAGE = "below_average"
    AVERAGE = "average"
    ELEVATED = "elevated"
    SPIKE = "spike"


@dataclass(frozen=True, slots=True)
class VolumeReading:
    state: VolumeState
    current: float
    average: float | None
    relative: float | None
    vwap: float | None
    price_vs_vwap_pct: float | None
    obv_rising: bool | None

    @property
    def confirms_move(self) -> bool:
        """Whether participation backs the price move.

        Average volume does not confirm anything — it is what happens when
        nothing is happening. Only elevated participation counts.
        """
        return self.state in (VolumeState.ELEVATED, VolumeState.SPIKE)


def analyse_volume(
    high: list[float],
    low: list[float],
    close: list[float],
    volume: list[float],
    lookback: int = 20,
) -> VolumeReading:
    current = volume[-1] if volume else 0.0

    average = None
    relative = None
    if len(volume) > lookback:
        # The current bar is excluded from its own baseline; including it pulls
        # the average toward the value being judged and mutes real spikes.
        window = volume[-(lookback + 1) : -1]
        average = sum(window) / len(window)
        if average > 0:
            relative = current / average

    if relative is None:
        state = VolumeState.AVERAGE
    elif relative >= 2.5:
        state = VolumeState.SPIKE
    elif relative >= 1.5:
        state = VolumeState.ELEVATED
    elif relative <= 0.4:
        state = VolumeState.DRIED_UP
    elif relative <= 0.75:
        state = VolumeState.BELOW_AVERAGE
    else:
        state = VolumeState.AVERAGE

    window = min(len(close), lookback)
    anchor = vwap(high[-window:], low[-window:], close[-window:], volume[-window:])

    distance = None
    if anchor and close:
        distance = (close[-1] - anchor) / anchor * 100

    obv_rising = None
    if len(close) >= 10:
        line = obv(close, volume)
        obv_rising = line[-1] > line[-min(10, len(line))]

    return VolumeReading(
        state=state,
        current=current,
        average=average,
        relative=relative,
        vwap=anchor,
        price_vs_vwap_pct=distance,
        obv_rising=obv_rising,
    )
