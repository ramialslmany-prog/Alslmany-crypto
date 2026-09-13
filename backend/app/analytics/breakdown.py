"""Performance cut by dimension — with the sample size attached to every cut.

The whole risk of this module is one failure mode: slicing a ledger finely
enough that noise looks like an edge. Five trades on SOLUSDT at 100% is not a
finding about SOLUSDT, and a table that prints "SOLUSDT 100%" beside "BTCUSDT
54% (180 trades)" invites exactly the wrong conclusion.

Two things guard against it, and neither is optional.

**Every group carries its sample size and a Wilson score interval** on the win
rate. Wilson is used rather than the textbook normal approximation because the
normal interval is actively wrong at the sizes that matter here: at n=5 with
5 wins it produces [1.0, 1.0] — a claim of certainty from five coin flips.
Wilson gives roughly [0.57, 1.0], which is the honest answer.

**Groups below `MIN_SAMPLE` are flagged and never ranked.** They are still
shown — hiding them would be its own distortion, since a symbol the bot barely
trades is worth seeing — but they are marked `reliable=False` and excluded from
any "best" or "worst" ordering.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from decimal import Decimal

from app.paper.models import PaperTrade
from app.paper.portfolio import Performance, performance

# Below this, a win rate is not measuring the strategy, it is measuring luck.
# Twenty is not a magic number — it is roughly where a 60%-vs-40% gap starts to
# be distinguishable from noise at all — and it is stated here rather than
# buried so it can be argued with.
MIN_SAMPLE = 20

# Dimensions where the win rate is decided by the grouping key rather than
# measured. Every `take_profit` exit is a win by definition, so "take_profit:
# 100% win rate (CI 96-100%)" states the definition back and dresses it as
# evidence. The cut is still worth seeing — the SHARE of trades ending each way
# is the real information — but the win rate is suppressed rather than printed
# as a finding.
TAUTOLOGICAL_WIN_RATE = frozenset({"exit_reason"})

# The confidence bands the engine can actually produce: it never trades below
# the 75 floor, so the bottom band starts there.
CONFIDENCE_BANDS: tuple[tuple[str, Decimal, Decimal], ...] = (
    ("75-79", Decimal(75), Decimal(80)),
    ("80-84", Decimal(80), Decimal(85)),
    ("85-89", Decimal(85), Decimal(90)),
    ("90+", Decimal(90), Decimal(1000)),
)


def wilson_interval(wins: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """95% confidence interval for a proportion, Wilson score method.

    Returns (low, high) as fractions. At n=0 the interval is the whole range,
    which is the correct statement: nothing is known.
    """
    if n <= 0:
        return (0.0, 1.0)
    p = wins / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - margin), min(1.0, centre + margin))


@dataclass(frozen=True, slots=True)
class Group:
    key: str
    performance: Performance
    share_pct: Decimal
    win_rate_low: Decimal | None
    win_rate_high: Decimal | None
    reliable: bool
    tautological: bool = False

    @property
    def note(self) -> str:
        if self.tautological:
            return (
                "Win rate is fixed by the exit type itself, so it is not reported "
                "here. What this row measures is the share."
            )
        if self.reliable:
            return ""
        return (
            f"{self.performance.total_trades} trades — below the {MIN_SAMPLE} "
            "needed to tell a result from noise. Shown, not ranked."
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "key": self.key,
            "share_pct": str(self.share_pct),
            "reliable": self.reliable,
            "note": self.note,
            "win_rate_ci": (
                None
                if self.win_rate_low is None or self.win_rate_high is None
                else [str(self.win_rate_low), str(self.win_rate_high)]
            ),
            "performance": self.performance.to_dict(),
        }


def _band(confidence: Decimal) -> str:
    for label, low, high in CONFIDENCE_BANDS:
        if low <= confidence < high:
            return label
    return "below-75"


KEYS: dict[str, Callable[[PaperTrade], str]] = {
    "symbol": lambda t: t.symbol,
    "timeframe": lambda t: t.timeframe,
    "strategy": lambda t: t.strategy,
    "direction": lambda t: t.direction,
    "confidence": lambda t: _band(t.confidence),
    "exit_reason": lambda t: t.exit_reason or "unknown",
}


def breakdown(trades: Iterable[PaperTrade], by: str, starting_balance: Decimal) -> list[Group]:
    """Group closed trades and measure each group.

    `starting_balance` is passed to each group's `Performance` so drawdown is
    expressed on the same base as the portfolio's own. A group's drawdown is
    therefore "what this slice did to the account", not "what it did to a
    hypothetical account that only ever traded this slice" — the second is a
    different and much easier question.
    """
    key_of = KEYS.get(by)
    if key_of is None:
        raise ValueError(f"unknown breakdown dimension: {by}")

    closed = [t for t in trades if t.status == "closed"]
    total = len(closed)

    buckets: dict[str, list[PaperTrade]] = {}
    for trade in closed:
        buckets.setdefault(key_of(trade), []).append(trade)

    tautological = by in TAUTOLOGICAL_WIN_RATE

    groups: list[Group] = []
    for key, rows in buckets.items():
        perf = performance(rows, starting_balance)
        low, high = wilson_interval(perf.wins, perf.total_trades)
        share = (
            (Decimal(len(rows)) / Decimal(total) * 100).quantize(Decimal("0.01"))
            if total
            else Decimal(0)
        )
        groups.append(
            Group(
                key=key,
                performance=perf,
                share_pct=share,
                win_rate_low=None if tautological else Decimal(str(round(low * 100, 2))),
                win_rate_high=None if tautological else Decimal(str(round(high * 100, 2))),
                reliable=perf.total_trades >= MIN_SAMPLE,
                tautological=tautological,
            )
        )

    if tautological:
        # Ranking these by expectancy would be ranking them by their own
        # definition. Share is what actually varies.
        groups.sort(key=lambda g: -g.performance.total_trades)
        return groups

    # Reliable groups first, best expectancy first within them; everything
    # underpowered sorted after, by sample size, so the eye reads the ranked
    # part as ranked and the rest as context.
    groups.sort(
        key=lambda g: (
            not g.reliable,
            -float(g.performance.expectancy_r) if g.reliable else 0.0,
            -g.performance.total_trades,
        )
    )
    return groups
