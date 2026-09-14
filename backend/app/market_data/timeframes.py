"""Timeframes, and the per-provider spellings of them.

Each provider names intervals differently (Binance says ``1d``, OKX says
``1D`` and further disagrees on anything above an hour). Centralising the
mapping means an adapter cannot silently request a different interval than the
one the caller asked for — a bug that produces plausible-looking candles and is
very hard to see on a chart.
"""

from __future__ import annotations

from enum import StrEnum


class Timeframe(StrEnum):
    M1 = "1m"
    M5 = "5m"
    M15 = "15m"
    H1 = "1h"
    H4 = "4h"
    D1 = "1d"

    @property
    def seconds(self) -> int:
        return _SECONDS[self]

    @property
    def milliseconds(self) -> int:
        return _SECONDS[self] * 1000


_SECONDS: dict[Timeframe, int] = {
    Timeframe.M1: 60,
    Timeframe.M5: 300,
    Timeframe.M15: 900,
    Timeframe.H1: 3_600,
    Timeframe.H4: 14_400,
    Timeframe.D1: 86_400,
}

# Binance uses lowercase suffixes throughout.
BINANCE_INTERVALS: dict[Timeframe, str] = {
    Timeframe.M1: "1m",
    Timeframe.M5: "5m",
    Timeframe.M15: "15m",
    Timeframe.H1: "1h",
    Timeframe.H4: "4h",
    Timeframe.D1: "1d",
}

# OKX uses an uppercase unit for 1h and above ("1H", "4H", "1D") and, for the
# candles endpoint, expects UTC-aligned variants for the daily bar.
OKX_INTERVALS: dict[Timeframe, str] = {
    Timeframe.M1: "1m",
    Timeframe.M5: "5m",
    Timeframe.M15: "15m",
    Timeframe.H1: "1H",
    Timeframe.H4: "4H",
    Timeframe.D1: "1Dutc",
}


def parse_timeframe(value: str) -> Timeframe:
    """Accept what a user would plausibly type, reject the rest loudly."""
    from app.core.errors import UnsupportedTimeframeError

    candidate = value.strip()
    for tf in Timeframe:
        if candidate.lower() == tf.value:
            return tf
    raise UnsupportedTimeframeError(
        f"Unsupported timeframe {value!r}.",
        supported=[tf.value for tf in Timeframe],
    )
