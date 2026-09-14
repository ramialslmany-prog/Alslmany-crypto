"""How much two symbols move together — and what that does to portfolio risk.

This exists to close the largest hole in the risk model. The bot sizes every
trade to risk 1% of the account and caps itself at five open positions, which
reads like a 5% worst case. It is not. BTC, ETH and SOL fall together in every
drawdown that matters, so five correlated longs are one position at five times
the size, wearing the costume of diversification.

Three details decide whether this measurement is worth anything.

**Correlate returns, not prices.** Two assets that both drift upward over a
year show a price correlation near 1 whether or not their daily moves have
anything to do with each other — the shared trend dominates. Returns are the
stationary series, and correlating them is the only version of this number that
answers the question being asked.

**Align on timestamps, not on position.** Two candle lists of equal length are
not necessarily the same window: a venue that dropped a bar, or a symbol listed
later, shifts everything after it. Zipping by index there silently correlates
Tuesday against Wednesday.

**Say when you do not know.** Below `MIN_OVERLAP` aligned bars the coefficient
is noise, and noise here is worse than nothing: a spuriously low correlation
tells the risk manager that five identical bets are safely spread out. The
functions return `None`, and the caller is required to decide what to assume —
`portfolio_heat` assumes the worst.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from itertools import pairwise

from app.analysis.series import Series

# Thirty aligned returns is not a lot, and it is the point below which a
# correlation coefficient stops being a measurement at all.
MIN_OVERLAP = 30


def returns(closes: list[float]) -> list[float]:
    """Simple returns between consecutive closes.

    A zero or negative close would make the division meaningless rather than
    merely wrong, so the pair is dropped instead of being coerced into a number.
    """
    out: list[float] = []
    for previous, current in pairwise(closes):
        if previous <= 0:
            continue
        out.append((current - previous) / previous)
    return out


def aligned_returns(a: Series, b: Series) -> tuple[list[float], list[float]]:
    """Returns for the bars the two series actually share, by timestamp."""
    by_time_a = dict(zip(a.times, a.close, strict=True))
    by_time_b = dict(zip(b.times, b.close, strict=True))

    shared = sorted(set(by_time_a) & set(by_time_b))
    if len(shared) < 2:
        return [], []

    return (
        returns([by_time_a[t] for t in shared]),
        returns([by_time_b[t] for t in shared]),
    )


def pearson(a: list[float], b: list[float]) -> float | None:
    """Pearson correlation, or `None` when it cannot be measured.

    A flat series has zero variance and no correlation with anything — the
    formula divides by zero there, and the honest answer is "unknown", not the
    0.0 that a guarded division would produce.
    """
    n = min(len(a), len(b))
    if n < MIN_OVERLAP:
        return None

    a, b = a[:n], b[:n]
    mean_a = sum(a) / n
    mean_b = sum(b) / n

    cov = sum((x - mean_a) * (y - mean_b) for x, y in zip(a, b, strict=True))
    var_a = sum((x - mean_a) ** 2 for x in a)
    var_b = sum((y - mean_b) ** 2 for y in b)

    if var_a <= 0 or var_b <= 0:
        return None

    rho = cov / (var_a * var_b) ** 0.5
    # Floating-point error can push a perfect correlation a hair past 1.0.
    return max(-1.0, min(1.0, rho))


def correlate(a: Series, b: Series) -> float | None:
    ra, rb = aligned_returns(a, b)
    return pearson(ra, rb)


def matrix(series: dict[str, Series]) -> dict[tuple[str, str], float]:
    """Every measurable pairwise correlation, keyed by ordered symbol pair.

    Pairs that cannot be measured are ABSENT rather than present with a
    placeholder. A missing key is a question the caller must answer; a 0.0
    would be an answer it never gave.
    """
    out: dict[tuple[str, str], float] = {}
    symbols = sorted(series)
    for i, first in enumerate(symbols):
        for second in symbols[i + 1 :]:
            rho = correlate(series[first], series[second])
            if rho is not None:
                out[(first, second)] = round(rho, 4)
                out[(second, first)] = round(rho, 4)
    return out


@dataclass(frozen=True, slots=True)
class Exposure:
    """One open position reduced to what it can lose and which way it leans."""

    symbol: str
    direction: str  # LONG | SHORT
    risk_amount: Decimal


@dataclass(frozen=True, slots=True)
class Heat:
    """What a joint adverse move would actually cost."""

    naive_risk: Decimal
    effective_risk: Decimal
    effective_pct: Decimal
    assumed_pairs: tuple[str, ...]
    worst_pair: tuple[str, str, float] | None

    @property
    def concentration(self) -> Decimal:
        """1.0 when the positions are one bet; lower as they diversify."""
        if self.naive_risk <= 0:
            return Decimal(0)
        return (self.effective_risk / self.naive_risk).quantize(Decimal("0.001"))

    def to_dict(self) -> dict[str, object]:
        return {
            "naive_risk": str(self.naive_risk),
            "effective_risk": str(self.effective_risk),
            "effective_pct": str(self.effective_pct),
            "concentration": str(self.concentration),
            "assumed_pairs": list(self.assumed_pairs),
            "worst_pair": (
                None
                if self.worst_pair is None
                else {
                    "a": self.worst_pair[0],
                    "b": self.worst_pair[1],
                    "correlation": self.worst_pair[2],
                }
            ),
        }


# When a pair's correlation cannot be measured, this is assumed. Crypto majors
# sit around 0.7-0.9 against each other in calm markets and converge on 1.0 in
# the selloffs that actually threaten an account, so the unmeasured case is
# treated as near-identical rather than independent. Guessing low here would
# make the limit fire exactly when it is least needed.
ASSUMED_CORRELATION = 0.9


def portfolio_heat(
    exposures: list[Exposure],
    correlations: dict[tuple[str, str], float],
    equity: Decimal,
) -> Heat:
    """Combined risk across open positions, accounting for correlation.

    The naive number is the sum of what each position risks. The effective
    number is

        sqrt( SUM_i SUM_j  r_i * r_j * rho_ij )

    which is the standard deviation of the combined loss when each position's
    loss is treated as one unit of its own risk. Two properties make it the
    right formula rather than a clever one:

    - With every correlation at 1.0 it collapses to the plain sum. Five
      perfectly correlated 1% positions ARE a 5% position, and the formula says
      so.
    - With every correlation at 0 it gives sqrt(SUM r_i^2) — five independent
      1% positions risk about 2.2% together, not 5%. That is the diversification
      the account actually has.

    **Direction flips the sign.** Long BTC against short ETH at rho = +0.9 is a
    hedge, not a concentration: when one loses the other gains. Using the raw
    coefficient there would report a pair of offsetting positions as the most
    dangerous thing in the book.
    """
    if not exposures or equity <= 0:
        return Heat(Decimal(0), Decimal(0), Decimal(0), (), None)

    assumed: list[str] = []
    worst: tuple[str, str, float] | None = None

    total = 0.0
    for first in exposures:
        for second in exposures:
            r1 = float(first.risk_amount)
            r2 = float(second.risk_amount)

            if first is second:
                total += r1 * r2
                continue

            key = (first.symbol, second.symbol)
            rho = correlations.get(key)
            if rho is None:
                rho = ASSUMED_CORRELATION
                label = f"{first.symbol}/{second.symbol}"
                if label not in assumed and f"{second.symbol}/{first.symbol}" not in assumed:
                    assumed.append(label)

            # Opposite directions turn a positive correlation into a hedge.
            signed = rho if first.direction == second.direction else -rho
            total += r1 * r2 * signed

            # Each unordered pair is considered once, on the ordered visit, so
            # the comparison below cannot be skipped by the pair arriving in
            # the other order first.
            if first.symbol < second.symbol and (worst is None or signed > worst[2]):
                worst = (first.symbol, second.symbol, round(signed, 4))

    # A perfectly hedged book can drive the sum to zero or a hair below it
    # through floating-point error; risk is never negative.
    effective = Decimal(str(round(max(total, 0.0) ** 0.5, 2)))
    naive = sum((e.risk_amount for e in exposures), Decimal(0))

    return Heat(
        naive_risk=naive.quantize(Decimal("0.01")),
        effective_risk=effective,
        effective_pct=(effective / equity * 100).quantize(Decimal("0.01")),
        assumed_pairs=tuple(assumed),
        worst_pair=worst,
    )


def series_window(series: Series, bars: int) -> Series:
    """The most recent `bars` of a series, for a rolling correlation."""
    if bars <= 0 or len(series) <= bars:
        return series
    return Series(
        open=series.open[-bars:],
        high=series.high[-bars:],
        low=series.low[-bars:],
        close=series.close[-bars:],
        volume=series.volume[-bars:],
        times=series.times[-bars:],
        closed=series.closed[-bars:],
    )
