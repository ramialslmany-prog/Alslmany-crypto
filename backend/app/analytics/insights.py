"""Observations drawn from the ledger — read by a human, applied by nobody.

This module is deliberately inert. It computes statements about what the ledger
shows and returns them as text. It imports nothing from the scoring, risk or
execution path and exposes no function that writes anything, because the one
thing a system like this must never do is quietly tune itself on its own
results.

The reason is not caution for its own sake. A strategy that adjusts its weights
to fit the trades it has already taken is fitting noise: the sample it is
learning from is the sample it selected, so the feedback loop rewards whatever
it happened to do, and the improvement it reports is guaranteed and fake. Every
observation here therefore carries `applied: False` and names what would have
to happen first — out-of-sample validation and a human decision.

`strength` is the honest part of each observation:

    insufficient — fewer than MIN_SAMPLE trades; stated, not concluded
    suggestive   — enough trades to notice, not enough to act on alone
    supported    — a large enough sample AND an effect bigger than its own
                   confidence interval
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from app.analytics.breakdown import MIN_SAMPLE, breakdown
from app.paper.models import PaperTrade
from app.paper.portfolio import performance

# Nothing in this module may ever set this to True. It exists so the flag is a
# named constant with a reason attached rather than a literal in a dict.
APPLIED = False
REQUIRES = (
    "Human review, then validation on data the observation was not drawn from. "
    "Nothing here changes the engine on its own."
)

SUPPORTED_SAMPLE = 40


@dataclass(frozen=True, slots=True)
class Observation:
    topic: str
    finding: str
    evidence: str
    sample: int
    strength: str
    consider: str

    def to_dict(self) -> dict[str, object]:
        return {
            "topic": self.topic,
            "finding": self.finding,
            "evidence": self.evidence,
            "sample": self.sample,
            "strength": self.strength,
            "consider": self.consider,
            # Repeated on every single observation rather than once at the top
            # of the payload: a caveat printed once above a list is read once
            # and then forgotten for every row beneath it.
            "applied": APPLIED,
            "requires": REQUIRES,
        }


def _strength(sample: int, decisive: bool = True) -> str:
    if sample < MIN_SAMPLE:
        return "insufficient"
    if sample >= SUPPORTED_SAMPLE and decisive:
        return "supported"
    return "suggestive"


def observe(trades: list[PaperTrade], starting_balance: Decimal) -> list[Observation]:
    closed = [t for t in trades if t.status == "closed"]
    out: list[Observation] = []

    if len(closed) < MIN_SAMPLE:
        return [
            Observation(
                topic="sample",
                finding=(
                    "There are not yet enough closed trades to say anything about this strategy."
                ),
                evidence=f"{len(closed)} closed trades; {MIN_SAMPLE} is the floor.",
                sample=len(closed),
                strength="insufficient",
                consider=(
                    "Let the bot run. Reading performance from a handful of trades "
                    "is how a losing strategy gets confirmed."
                ),
            )
        ]

    overall = performance(closed, starting_balance)

    # --- is the confidence score ordering outcomes at all? ------------------
    bands = {g.key: g for g in breakdown(closed, "confidence", starting_balance)}
    reliable_bands = {k: g for k, g in bands.items() if g.reliable}
    if len(reliable_bands) >= 2:
        ordered = sorted(reliable_bands.items(), key=lambda kv: kv[0])
        lowest, highest = ordered[0][1], ordered[-1][1]
        gap = highest.performance.expectancy_r - lowest.performance.expectancy_r
        if gap > Decimal("0.2"):
            out.append(
                Observation(
                    topic="confidence",
                    finding=(
                        "Higher-confidence trades are outperforming lower-confidence "
                        "ones, which is what the score is supposed to do."
                    ),
                    evidence=(
                        f"{highest.key}: {highest.performance.expectancy_r}R over "
                        f"{highest.performance.total_trades} trades vs {lowest.key}: "
                        f"{lowest.performance.expectancy_r}R over "
                        f"{lowest.performance.total_trades}."
                    ),
                    sample=highest.performance.total_trades + lowest.performance.total_trades,
                    strength=_strength(
                        highest.performance.total_trades + lowest.performance.total_trades
                    ),
                    consider="Nothing. This is the score behaving as designed.",
                )
            )
        elif gap < Decimal("-0.2"):
            out.append(
                Observation(
                    topic="confidence",
                    finding=(
                        "The confidence score is inverted against outcomes: the "
                        "trades it rated highest are doing worse than the ones it "
                        "rated lowest."
                    ),
                    evidence=(
                        f"{highest.key}: {highest.performance.expectancy_r}R over "
                        f"{highest.performance.total_trades} trades vs {lowest.key}: "
                        f"{lowest.performance.expectancy_r}R over "
                        f"{lowest.performance.total_trades}."
                    ),
                    sample=highest.performance.total_trades + lowest.performance.total_trades,
                    strength=_strength(
                        highest.performance.total_trades + lowest.performance.total_trades
                    ),
                    consider=(
                        "This is the most serious thing this page can report — it "
                        "says the gate is selecting the wrong trades. Investigate "
                        "the factor weights before trusting any other number here."
                    ),
                )
            )

    # --- which symbols carry the result, and which drag on it --------------
    symbols = [g for g in breakdown(closed, "symbol", starting_balance) if g.reliable]
    losers = [g for g in symbols if g.performance.expectancy_r < 0]
    for group in losers:
        out.append(
            Observation(
                topic="symbol",
                finding=f"{group.key} has negative expectancy over a usable sample.",
                evidence=(
                    f"{group.performance.expectancy_r}R per trade over "
                    f"{group.performance.total_trades} trades; win rate "
                    f"{group.performance.win_rate}% "
                    f"(95% CI {group.win_rate_low}-{group.win_rate_high}%)."
                ),
                sample=group.performance.total_trades,
                strength=_strength(
                    group.performance.total_trades,
                    decisive=group.win_rate_high < Decimal(50),
                ),
                consider=(
                    f"A human might review whether {group.key} suits this strategy. "
                    "Removing a symbol because it lost money over one sample is the "
                    "definition of curve-fitting, so validate first."
                ),
            )
        )

    # --- are stops doing the work, or is the exit logic? --------------------
    exits = {g.key: g for g in breakdown(closed, "exit_reason", starting_balance)}
    be = exits.get("breakeven")
    if be is not None and be.share_pct > Decimal(35):
        out.append(
            Observation(
                topic="exits",
                finding=(
                    "More than a third of trades end at breakeven, which usually "
                    "means the breakeven stop is being moved up too early."
                ),
                evidence=(
                    f"{be.performance.total_trades} of {len(closed)} trades "
                    f"({be.share_pct}%) exited at breakeven."
                ),
                sample=be.performance.total_trades,
                strength=_strength(be.performance.total_trades),
                consider=(
                    "A breakeven rule protects capital and costs winners. Which "
                    "trade-off is wanted is a judgement call, not a calculation."
                ),
            )
        )

    # --- long versus short --------------------------------------------------
    sides = {g.key: g for g in breakdown(closed, "direction", starting_balance)}
    long_g, short_g = sides.get("LONG"), sides.get("SHORT")
    if long_g and short_g and long_g.reliable and short_g.reliable:
        gap = long_g.performance.expectancy_r - short_g.performance.expectancy_r
        if abs(gap) > Decimal("0.3"):
            better, worse = (long_g, short_g) if gap > 0 else (short_g, long_g)
            out.append(
                Observation(
                    topic="direction",
                    finding=(
                        f"{better.key} trades are outperforming {worse.key} trades "
                        "by a wide margin."
                    ),
                    evidence=(
                        f"{better.key} {better.performance.expectancy_r}R over "
                        f"{better.performance.total_trades}; {worse.key} "
                        f"{worse.performance.expectancy_r}R over "
                        f"{worse.performance.total_trades}."
                    ),
                    sample=better.performance.total_trades + worse.performance.total_trades,
                    strength=_strength(
                        better.performance.total_trades + worse.performance.total_trades
                    ),
                    consider=(
                        "Over a single market regime this is expected — a trending "
                        "market flatters one side. It only means something if it "
                        "survives a regime change."
                    ),
                )
            )

    # --- are the targets the engine plans actually being reached? ----------
    winners = [t for t in closed if t.r_multiple is not None and t.r_multiple > 0]
    if len(winners) >= MIN_SAMPLE:
        planned = sum(t.reward_risk for t in winners) / len(winners)
        realised = sum(t.r_multiple for t in winners) / len(winners)
        shortfall = planned - realised
        if shortfall > Decimal("0.4"):
            out.append(
                Observation(
                    topic="targets",
                    finding=(
                        "Winning trades are closing well short of the reward the "
                        "plan projected for them."
                    ),
                    evidence=(
                        f"Planned {planned.quantize(Decimal('0.01'))}R on average "
                        f"across {len(winners)} winners; realised "
                        f"{realised.quantize(Decimal('0.01'))}R."
                    ),
                    sample=len(winners),
                    strength=_strength(len(winners)),
                    consider=(
                        "Either the targets are set beyond where price actually "
                        "goes, or something is closing trades before they reach "
                        "them. The exit-reason breakdown separates the two."
                    ),
                )
            )

    # --- what do the costs take? -------------------------------------------
    gross_win = sum((t.pnl or Decimal(0)) for t in closed if (t.pnl or Decimal(0)) > 0)
    if gross_win > 0:
        drag = (overall.total_fees / gross_win * 100).quantize(Decimal("0.01"))
        if drag > Decimal(10):
            out.append(
                Observation(
                    topic="costs",
                    finding=("Fees are taking a material share of everything the winners make."),
                    evidence=(
                        f"{overall.total_fees} paid in fees against "
                        f"{gross_win} of gross profit — {drag}%."
                    ),
                    sample=overall.total_trades,
                    strength=_strength(overall.total_trades),
                    consider=(
                        "Cost drag scales with how often the bot trades, not with "
                        "how well it trades. A higher bar for entry cuts it "
                        "directly; so does a longer timeframe."
                    ),
                )
            )

    # --- how close did it come to its own limits? --------------------------
    if overall.longest_losing_streak >= 5:
        out.append(
            Observation(
                topic="risk",
                finding=(
                    f"The longest losing streak so far is {overall.longest_losing_streak} trades."
                ),
                evidence=(
                    f"At 1% risk per trade that is roughly "
                    f"{overall.longest_losing_streak}% of the account, against a "
                    "10% drawdown limit. Observed max drawdown: "
                    f"{overall.max_drawdown_pct}%."
                ),
                sample=overall.total_trades,
                strength=_strength(overall.total_trades),
                consider=(
                    "A streak this long is normal at these win rates and is not a "
                    "reason to change anything. It is a reason to be sure the risk "
                    "per trade is survivable."
                ),
            )
        )

    if not out:
        out.append(
            Observation(
                topic="sample",
                finding="Nothing in the ledger stands out above its own noise.",
                evidence=(
                    f"{overall.total_trades} closed trades, expectancy "
                    f"{overall.expectancy_r}R, win rate {overall.win_rate}%."
                ),
                sample=overall.total_trades,
                strength="suggestive",
                consider="No change is indicated. That is a result, not an absence of one.",
            )
        )
    return out
