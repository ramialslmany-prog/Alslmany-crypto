"""Turning stored candles into the arrays indicators work on.

One deliberate boundary is crossed here: prices are `Decimal` everywhere that
they represent money, and `float` from here on where they feed a statistic.

That is not a compromise, it is the correct split. A moving average is a
descriptive number — nobody is paid or charged it — and computing an EMA in
Decimal costs precision to repeated division without buying any accuracy that
matters at the third decimal of an RSI. What must never become float is
anything that sizes a position or settles a trade, and none of that happens in
this package.

The one hard rule: an indicator that cannot be computed returns `None`. It never
returns 0.0, and it never quietly shortens its own lookback to fit the data it
was given. A zero RSI reads as "extremely oversold" to every downstream check,
which is the most dangerous possible way to say "I don't know".
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from app.market_data.schemas import Candle


@dataclass(frozen=True, slots=True)
class Series:
    """OHLCV as parallel float arrays, oldest first."""

    open: list[float]
    high: list[float]
    low: list[float]
    close: list[float]
    volume: list[float]
    times: list[datetime]
    closed: list[bool]

    def __len__(self) -> int:
        return len(self.close)

    @property
    def last_close(self) -> float | None:
        return self.close[-1] if self.close else None

    def closed_only(self) -> Series:
        """Drop a still-forming final bar.

        A signal fired on an incomplete candle is a signal fired on a price that
        can still move against it before the bar even ends — the single most
        common way a backtest looks better than the strategy it describes.
        """
        if not self.closed or self.closed[-1]:
            return self
        return Series(
            open=self.open[:-1],
            high=self.high[:-1],
            low=self.low[:-1],
            close=self.close[:-1],
            volume=self.volume[:-1],
            times=self.times[:-1],
            closed=self.closed[:-1],
        )


def to_series(candles: list[Candle]) -> Series:
    """Build a Series, enforcing chronological order.

    Sorting rather than trusting the caller is deliberate: OKX returns candles
    newest-first, and every indicator below would compute cleanly and return
    confidently wrong numbers on a reversed series.
    """
    ordered = sorted(candles, key=lambda c: c.open_time)
    return Series(
        open=[float(c.open) for c in ordered],
        high=[float(c.high) for c in ordered],
        low=[float(c.low) for c in ordered],
        close=[float(c.close) for c in ordered],
        volume=[float(c.volume) for c in ordered],
        times=[c.open_time for c in ordered],
        closed=[c.closed for c in ordered],
    )
