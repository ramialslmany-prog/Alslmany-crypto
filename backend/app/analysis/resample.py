"""Building higher-timeframe candles out of lower-timeframe ones.

The bot reads one timeframe at a time, which leaves it blind to the thing every
discretionary trader checks first: what the bigger picture is doing. A long on
the hourly against a falling daily is a materially worse trade than the same
long with the daily behind it, and nothing in the seven scored dimensions can
see the difference.

The higher timeframe is derived from the candles already in hand rather than
fetched separately, and that choice buys three things at once:

**No extra upstream requests.** Five symbols times six timeframes would double
the venue load for a reading that is already implied by the data.

**The same behaviour live and in replay.** The backtester cannot fetch a
different timeframe without reopening the look-ahead question it was built to
close; resampling the visible window cannot see past the cursor by
construction.

**One definition.** A resampled 4h candle and a fetched 4h candle should agree,
and when they do not it is because of the two rules below — which are exactly
the rules that keep this honest.

**Buckets are aligned to the clock, not to the start of the array.** Grouping
every four bars from wherever the data happens to begin produces a "4h candle"
spanning 01:00-05:00, whose close is a price no chart shows. Bucketing by
`open_time // interval` puts the boundaries where the venue puts them.

**An incomplete final bucket is dropped.** The 4h candle containing the current
hour has not closed yet, and its high, low and close can all still move. Using
it is the same look-ahead mistake as trading on a forming bar, one level up.
"""

from __future__ import annotations

from app.analysis.series import Series

# Which timeframe each one is read against. The jump is deliberately large
# enough to say something different: a 1h signal checked against 2h is checking
# itself twice, while 4h is a different set of participants.
HIGHER_TIMEFRAME: dict[str, str] = {
    "1m": "15m",
    "5m": "1h",
    "15m": "4h",
    "1h": "4h",
    "4h": "1d",
    "1d": "",  # nothing above it here; the daily is read on its own terms
}

SECONDS: dict[str, int] = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
}


def resample(series: Series, target: str) -> Series:
    """Aggregate `series` into `target` candles, oldest first.

    Returns an empty series when the target is not a coarser interval than the
    source — upsampling would have to invent the bars in between, and inventing
    market data is the one thing this platform never does.
    """
    step = SECONDS.get(target)
    if step is None or len(series) == 0:
        return _empty()

    buckets: dict[int, list[int]] = {}
    for i, at in enumerate(series.times):
        # Aligned to the clock, so a resampled bar covers the same window the
        # venue's own bar would.
        key = int(at.timestamp()) // step
        buckets.setdefault(key, []).append(i)

    if len(buckets) < 2:
        return _empty()

    keys = sorted(buckets)
    source_step = _infer_step(series)
    if source_step is None or source_step >= step:
        return _empty()

    expected = step // source_step

    out_open, out_high, out_low, out_close = [], [], [], []
    out_volume, out_times, out_closed = [], [], []

    for key in keys:
        rows = buckets[key]
        # An incomplete bucket has not finished forming. Dropping it applies the
        # forming-bar rule one timeframe up; keeping it would let the current,
        # still-moving 4h candle decide an hourly trade.
        if len(rows) < expected:
            continue
        if not all(series.closed[i] for i in rows):
            continue

        first, last = rows[0], rows[-1]
        out_open.append(series.open[first])
        out_high.append(max(series.high[i] for i in rows))
        out_low.append(min(series.low[i] for i in rows))
        out_close.append(series.close[last])
        out_volume.append(sum(series.volume[i] for i in rows))
        out_times.append(series.times[first])
        out_closed.append(True)

    return Series(
        open=out_open,
        high=out_high,
        low=out_low,
        close=out_close,
        volume=out_volume,
        times=out_times,
        closed=out_closed,
    )


def _infer_step(series: Series) -> int | None:
    """The source interval, read from the data rather than taken on trust.

    The most common gap is used rather than the first: a single missing bar
    would otherwise double the inferred interval and halve every bucket.
    """
    if len(series) < 3:
        return None
    gaps: dict[int, int] = {}
    for earlier, later in zip(series.times, series.times[1:], strict=False):
        gap = int((later - earlier).total_seconds())
        if gap > 0:
            gaps[gap] = gaps.get(gap, 0) + 1
    if not gaps:
        return None
    return max(gaps, key=lambda g: gaps[g])


def _empty() -> Series:
    return Series(open=[], high=[], low=[], close=[], volume=[], times=[], closed=[])
