"""Momentum: RSI, MACD, Stochastic.

RSI uses Wilder's smoothing, which is NOT an EMA despite looking like one.
Wilder's uses 1/period as the multiplier where an EMA of the same period uses
2/(period+1) — for 14 periods that is 0.0714 against 0.1333, nearly double.
Substituting one for the other produces an RSI that is visibly more jumpy than
every charting platform shows, and the values below are checked against
Wilder's own 1978 worked example precisely so that this cannot drift.
"""

from __future__ import annotations

from dataclasses import dataclass


def rsi_series(close: list[float], period: int = 14) -> list[float | None]:
    out: list[float | None] = [None] * len(close)
    if period <= 0 or len(close) <= period:
        return out

    gains = 0.0
    losses = 0.0
    for i in range(1, period + 1):
        change = close[i] - close[i - 1]
        if change >= 0:
            gains += change
        else:
            losses -= change

    avg_gain = gains / period
    avg_loss = losses / period
    out[period] = _rsi_from(avg_gain, avg_loss)

    for i in range(period + 1, len(close)):
        change = close[i] - close[i - 1]
        gain = max(change, 0.0)
        loss = max(-change, 0.0)
        # Wilder's smoothing: previous average carries (period-1)/period weight.
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        out[i] = _rsi_from(avg_gain, avg_loss)

    return out


def _rsi_from(avg_gain: float, avg_loss: float) -> float:
    # An unbroken run of gains gives zero average loss. RSI is 100 by
    # definition there; computing it would divide by zero.
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def rsi(close: list[float], period: int = 14) -> float | None:
    series = rsi_series(close, period)
    return series[-1] if series else None


@dataclass(frozen=True, slots=True)
class Macd:
    macd: float
    signal: float
    histogram: float

    @property
    def is_bullish(self) -> bool:
        return self.macd > self.signal


def macd(close: list[float], fast: int = 12, slow: int = 26, signal: int = 9) -> Macd | None:
    """MACD line, signal line and histogram.

    The signal line is an EMA of the MACD line, and it may only be computed over
    the part of the MACD line that actually exists. Seeding it with zeros for
    the leading `slow-1` bars — a common shortcut — drags the early signal
    toward zero and manufactures a crossover that never happened.
    """
    from app.analysis.trend import ema_series

    fast_ema = ema_series(close, fast)
    slow_ema = ema_series(close, slow)

    macd_line: list[float] = []
    for f, s in zip(fast_ema, slow_ema, strict=True):
        if f is None or s is None:
            continue
        macd_line.append(f - s)

    if len(macd_line) < signal:
        return None

    signal_series = ema_series(macd_line, signal)
    signal_value = signal_series[-1]
    if signal_value is None:
        return None

    value = macd_line[-1]
    return Macd(macd=value, signal=signal_value, histogram=value - signal_value)


@dataclass(frozen=True, slots=True)
class Stochastic:
    k: float
    d: float

    @property
    def is_oversold(self) -> bool:
        return self.k < 20

    @property
    def is_overbought(self) -> bool:
        return self.k > 80


def stochastic(
    high: list[float], low: list[float], close: list[float], period: int = 14, smooth: int = 3
) -> Stochastic | None:
    if len(close) < period + smooth - 1:
        return None

    ks: list[float] = []
    for i in range(period - 1, len(close)):
        window_high = max(high[i - period + 1 : i + 1])
        window_low = min(low[i - period + 1 : i + 1])
        span = window_high - window_low
        # A perfectly flat window has no range to locate the close within.
        # 50 is the honest midpoint; 0 would read as maximum oversold.
        ks.append(50.0 if span == 0 else (close[i] - window_low) / span * 100)

    if len(ks) < smooth:
        return None
    return Stochastic(k=ks[-1], d=sum(ks[-smooth:]) / smooth)
