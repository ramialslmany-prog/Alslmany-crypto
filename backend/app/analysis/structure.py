"""Market structure and Smart Money Concepts.

The governing rule of this module: **report only what was actually detected.**

Most SMC tooling narrates every pattern onto every chart, because a reader who
is told there is an order block will find one. Each detector here returns
nothing when its conditions are not met, and the aggregate carries an explicit
list of what was found, so the absence of a pattern is visible rather than
papered over. A setup with three confirmations and a setup with none must not
look alike.

Every level carries the index of the bar that produced it, so any claim can be
traced back to the candle it came from.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from app.analysis.levels import Swing, SwingKind, find_swings


class StructureState(StrEnum):
    BULLISH = "bullish"  # higher highs and higher lows
    BEARISH = "bearish"  # lower highs and lower lows
    RANGING = "ranging"  # neither sequence holds
    UNKNOWN = "unknown"  # not enough swings to say


class BreakKind(StrEnum):
    BOS = "bos"  # break of structure: the trend continued
    CHOCH = "choch"  # change of character: the trend may be turning


@dataclass(frozen=True, slots=True)
class StructureBreak:
    kind: BreakKind
    direction: str  # "up" | "down"
    price: float
    index: int
    broken_swing_index: int


@dataclass(frozen=True, slots=True)
class FairValueGap:
    """A three-bar imbalance: bar 1's extreme never meets bar 3's.

    Price passed through this range without trading both sides of it, so it is
    frequently revisited. Unfilled gaps only — a filled gap is history.
    """

    direction: str  # "bullish" | "bearish"
    top: float
    bottom: float
    index: int

    @property
    def midpoint(self) -> float:
        return (self.top + self.bottom) / 2

    @property
    def size_pct(self) -> float:
        return (self.top - self.bottom) / self.bottom * 100 if self.bottom else 0.0


@dataclass(frozen=True, slots=True)
class OrderBlock:
    """The last opposing candle before an impulsive move that broke structure.

    Only counted when the move actually broke something. Without that filter
    "order block" degenerates into "any red candle before a green one", which is
    most candles.
    """

    direction: str  # "bullish" | "bearish"
    top: float
    bottom: float
    index: int

    @property
    def midpoint(self) -> float:
        return (self.top + self.bottom) / 2


@dataclass(frozen=True, slots=True)
class LiquiditySweep:
    """Price took out a prior extreme and closed back inside it.

    The close is what distinguishes a sweep from a breakout. Wicking through a
    level and closing beyond it is a break; wicking through and closing back is
    stop-hunting, and the two imply opposite next moves.
    """

    direction: str  # "high" (buy-side taken) | "low" (sell-side)
    level: float
    index: int


@dataclass(frozen=True, slots=True)
class PremiumDiscount:
    """Where price sits in the current dealing range.

    Buying in premium is buying what someone else is distributing. The band is
    the middle 10% — neither cheap nor expensive.
    """

    high: float
    low: float
    equilibrium: float
    position_pct: float  # 0 at the range low, 100 at the high

    @property
    def zone(self) -> str:
        if self.position_pct > 55:
            return "premium"
        if self.position_pct < 45:
            return "discount"
        return "equilibrium"


@dataclass(frozen=True, slots=True)
class Structure:
    state: StructureState
    swings: tuple[Swing, ...]
    breaks: tuple[StructureBreak, ...]
    fair_value_gaps: tuple[FairValueGap, ...]
    order_blocks: tuple[OrderBlock, ...]
    sweeps: tuple[LiquiditySweep, ...]
    premium_discount: PremiumDiscount | None
    detected: tuple[str, ...] = field(default=())

    @property
    def last_break(self) -> StructureBreak | None:
        return self.breaks[-1] if self.breaks else None

    @property
    def is_bullish(self) -> bool:
        return self.state is StructureState.BULLISH

    @property
    def is_bearish(self) -> bool:
        return self.state is StructureState.BEARISH


def classify_structure(highs: list[Swing], lows: list[Swing]) -> StructureState:
    """Bullish needs a higher high AND a higher low; one alone is not a trend."""
    if len(highs) < 2 or len(lows) < 2:
        return StructureState.UNKNOWN

    higher_high = highs[-1].price > highs[-2].price
    higher_low = lows[-1].price > lows[-2].price
    lower_high = highs[-1].price < highs[-2].price
    lower_low = lows[-1].price < lows[-2].price

    if higher_high and higher_low:
        return StructureState.BULLISH
    if lower_high and lower_low:
        return StructureState.BEARISH
    return StructureState.RANGING


def find_structure_breaks(
    high: list[float], low: list[float], close: list[float], swings: list[Swing]
) -> list[StructureBreak]:
    """Closes beyond a prior swing, labelled BOS or CHoCH by what came before.

    The distinction is the entire value of the concept. Breaking an old high
    while already in an uptrend is continuation; breaking it after a downtrend
    is the first evidence the downtrend is over. Labelling both "a break" throws
    that away.
    """
    breaks: list[StructureBreak] = []
    state = StructureState.UNKNOWN

    for i in range(len(close)):
        prior = [s for s in swings if s.index < i]
        highs = [s for s in prior if s.kind is SwingKind.HIGH]
        lows = [s for s in prior if s.kind is SwingKind.LOW]
        if not highs or not lows:
            continue

        last_high, last_low = highs[-1], lows[-1]
        current = classify_structure(highs, lows)

        # A close beyond the level, not a wick through it.
        if close[i] > last_high.price:
            kind = BreakKind.CHOCH if state is StructureState.BEARISH else BreakKind.BOS
            breaks.append(
                StructureBreak(
                    kind=kind,
                    direction="up",
                    price=last_high.price,
                    index=i,
                    broken_swing_index=last_high.index,
                )
            )
            state = StructureState.BULLISH
        elif close[i] < last_low.price:
            kind = BreakKind.CHOCH if state is StructureState.BULLISH else BreakKind.BOS
            breaks.append(
                StructureBreak(
                    kind=kind,
                    direction="down",
                    price=last_low.price,
                    index=i,
                    broken_swing_index=last_low.index,
                )
            )
            state = StructureState.BEARISH
        elif current is not StructureState.UNKNOWN:
            state = current

    return breaks


def find_fair_value_gaps(
    high: list[float], low: list[float], *, min_size_pct: float = 0.05
) -> list[FairValueGap]:
    """Unfilled three-bar imbalances, newest last.

    A minimum size filters out gaps that are narrower than the spread, which are
    noise rather than structure.
    """
    gaps: list[FairValueGap] = []
    for i in range(2, len(high)):
        # Bullish: this bar's low is above the low of two bars back.
        if low[i] > high[i - 2]:
            gap = FairValueGap(direction="bullish", top=low[i], bottom=high[i - 2], index=i)
            if gap.size_pct >= min_size_pct:
                gaps.append(gap)
        elif high[i] < low[i - 2]:
            gap = FairValueGap(direction="bearish", top=low[i - 2], bottom=high[i], index=i)
            if gap.size_pct >= min_size_pct:
                gaps.append(gap)

    # Drop anything price has since traded back through.
    unfilled: list[FairValueGap] = []
    for gap in gaps:
        after_low = min(low[gap.index + 1 :], default=None)
        after_high = max(high[gap.index + 1 :], default=None)
        if after_low is None or after_high is None:
            unfilled.append(gap)
            continue
        if gap.direction == "bullish" and after_low > gap.bottom:
            unfilled.append(gap)
        elif gap.direction == "bearish" and after_high < gap.top:
            unfilled.append(gap)
    return unfilled


def find_order_blocks(
    open_: list[float],
    high: list[float],
    low: list[float],
    close: list[float],
    breaks: list[StructureBreak],
    *,
    limit: int = 3,
) -> list[OrderBlock]:
    """The last opposing candle before each structure break."""
    blocks: list[OrderBlock] = []
    for brk in breaks[-limit:]:
        # Walk back from the break for the last candle against its direction.
        for i in range(brk.index - 1, max(-1, brk.index - 12), -1):
            is_down_candle = close[i] < open_[i]
            if brk.direction == "up" and is_down_candle:
                blocks.append(OrderBlock(direction="bullish", top=high[i], bottom=low[i], index=i))
                break
            if brk.direction == "down" and not is_down_candle:
                blocks.append(OrderBlock(direction="bearish", top=high[i], bottom=low[i], index=i))
                break
    return blocks


def find_liquidity_sweeps(
    high: list[float], low: list[float], close: list[float], swings: list[Swing]
) -> list[LiquiditySweep]:
    """Wicks through a prior extreme that closed back inside it."""
    sweeps: list[LiquiditySweep] = []
    for i in range(len(close)):
        prior = [s for s in swings if s.index < i]
        for swing in prior[-6:]:
            if swing.kind is SwingKind.HIGH and high[i] > swing.price >= close[i]:
                sweeps.append(LiquiditySweep(direction="high", level=swing.price, index=i))
                break
            if swing.kind is SwingKind.LOW and low[i] < swing.price <= close[i]:
                sweeps.append(LiquiditySweep(direction="low", level=swing.price, index=i))
                break
    return sweeps


def premium_discount(
    high: list[float], low: list[float], close: list[float], lookback: int = 50
) -> PremiumDiscount | None:
    # Guard on the shortest input rather than on `close` alone: the range comes
    # from high/low and the position from close, so a check against one of them
    # can pass while another is too short to measure.
    available = min(len(high), len(low), len(close))
    if available < 5:
        return None

    window = min(lookback, available)
    window_high = max(high[-window:])
    window_low = min(low[-window:])
    span = window_high - window_low
    if span <= 0:
        return None

    return PremiumDiscount(
        high=window_high,
        low=window_low,
        equilibrium=(window_high + window_low) / 2,
        position_pct=(close[-1] - window_low) / span * 100,
    )


def analyse_structure(
    open_: list[float],
    high: list[float],
    low: list[float],
    close: list[float],
    *,
    lookback: int = 2,
) -> Structure:
    """Run every detector and report exactly what each one found."""
    swings = find_swings(high, low, lookback)
    highs = [s for s in swings if s.kind is SwingKind.HIGH]
    lows = [s for s in swings if s.kind is SwingKind.LOW]

    breaks = find_structure_breaks(high, low, close, swings)
    gaps = find_fair_value_gaps(high, low)
    blocks = find_order_blocks(open_, high, low, close, breaks)
    sweeps = find_liquidity_sweeps(high, low, close, swings)
    zone = premium_discount(high, low, close)

    # The manifest. A caller can see which concepts actually applied instead of
    # assuming every one of them did.
    detected: list[str] = []
    if swings:
        detected.append("swings")
    if breaks:
        detected.append("structure-break")
        if any(b.kind is BreakKind.CHOCH for b in breaks):
            detected.append("change-of-character")
    if gaps:
        detected.append("fair-value-gap")
    if blocks:
        detected.append("order-block")
    if sweeps:
        detected.append("liquidity-sweep")
    if zone:
        detected.append("premium-discount")

    return Structure(
        state=classify_structure(highs, lows),
        swings=tuple(swings),
        breaks=tuple(breaks),
        fair_value_gaps=tuple(gaps[-5:]),
        order_blocks=tuple(blocks),
        sweeps=tuple(sweeps[-5:]),
        premium_discount=zone,
        detected=tuple(detected),
    )
