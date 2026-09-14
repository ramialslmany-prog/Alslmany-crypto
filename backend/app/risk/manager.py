"""The risk manager: the last gate before a position opens.

Every rule here is a veto, not a score. A setup that scores 95 and breaches the
daily loss limit does not open, and no amount of confidence overrides that —
which is the entire reason the check lives downstream of the scoring rather
than inside it.

The limits are the ones specified: 1% per trade, 5 open positions, 3% daily
loss, 10% maximum drawdown.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from enum import StrEnum


class RejectReason(StrEnum):
    MAX_OPEN_TRADES = "max_open_trades"
    DAILY_LOSS_LIMIT = "daily_loss_limit"
    DRAWDOWN_LIMIT = "drawdown_limit"
    DUPLICATE_POSITION = "duplicate_position"
    INSUFFICIENT_BALANCE = "insufficient_balance"
    POSITION_TOO_SMALL = "position_too_small"
    NO_RELIABLE_DATA = "no_reliable_market_data"
    CONFIDENCE_TOO_LOW = "confidence_too_low"
    RISK_REWARD_TOO_LOW = "risk_reward_too_low"
    VOLATILITY_EXTREME = "volatility_extreme"
    PORTFOLIO_HEAT = "portfolio_heat"


@dataclass(frozen=True, slots=True)
class RiskLimits:
    risk_per_trade_pct: Decimal = Decimal("1")
    max_open_trades: int = 5
    max_daily_loss_pct: Decimal = Decimal("3")
    max_drawdown_pct: Decimal = Decimal("10")
    min_confidence: Decimal = Decimal("75")
    min_reward_risk: Decimal = Decimal("1.5")
    # Below this the fees dominate the outcome and the trade is noise.
    min_notional: Decimal = Decimal("10")
    # The cap that `max_open_trades` only appears to provide. Five positions at
    # 1% each look like a 5% worst case; if they are correlated they are one
    # 5% position. This limits the COMBINED risk of a joint adverse move —
    # 2.5% allows genuine diversification (five independent 1% bets combine to
    # about 2.2%) while refusing five copies of the same trade.
    max_portfolio_heat_pct: Decimal = Decimal("2.5")


@dataclass(frozen=True, slots=True)
class PortfolioState:
    balance: Decimal
    equity: Decimal
    peak_equity: Decimal
    open_symbols: frozenset[str]
    realised_today: Decimal
    day: date

    @property
    def drawdown_pct(self) -> Decimal:
        if self.peak_equity <= 0:
            return Decimal(0)
        return (self.peak_equity - self.equity) / self.peak_equity * 100

    @property
    def daily_loss_pct(self) -> Decimal:
        """Losses only. A profitable day returns zero, not a negative."""
        if self.realised_today >= 0 or self.balance <= 0:
            return Decimal(0)
        return abs(self.realised_today) / self.balance * 100


@dataclass(frozen=True, slots=True)
class RiskDecision:
    approved: bool
    reasons: tuple[RejectReason, ...] = ()
    notes: tuple[str, ...] = ()
    # Whether the correlation-aware heat limit actually ran. It is carried here
    # rather than appended to `notes`, because every note in that tuple
    # corresponds to a breached rule — a note without a reason would break the
    # one-to-one relationship a test already enforces, and "this check did not
    # run" is not a rejection.
    heat_checked: bool = True

    @property
    def primary_reason(self) -> RejectReason | None:
        return self.reasons[0] if self.reasons else None


class RiskManager:
    def __init__(self, limits: RiskLimits | None = None) -> None:
        self.limits = limits or RiskLimits()

    def evaluate(
        self,
        *,
        symbol: str,
        portfolio: PortfolioState,
        confidence: Decimal,
        reward_risk: Decimal | None,
        notional: Decimal,
        data_is_live: bool,
        volatility_tradeable: bool = True,
        now: datetime | None = None,
        projected_heat_pct: Decimal | None = None,
    ) -> RiskDecision:
        """Collect EVERY breached rule, not just the first.

        Reporting one reason at a time turns fixing a rejection into a guessing
        game, and hides the case where a setup is failing for several
        independent reasons — which is far more informative than any one of them.
        """
        now = now or datetime.now(UTC)
        reasons: list[RejectReason] = []
        notes: list[str] = []

        # The hardest rule in the system, checked first. Stage 1 established
        # that the platform never invents a market value; this is where that
        # guarantee becomes a refusal to act.
        if not data_is_live:
            reasons.append(RejectReason.NO_RELIABLE_DATA)
            notes.append("Market data is not live; no position may be opened.")

        if symbol in portfolio.open_symbols:
            reasons.append(RejectReason.DUPLICATE_POSITION)
            notes.append(f"A position in {symbol} is already open.")

        if len(portfolio.open_symbols) >= self.limits.max_open_trades:
            reasons.append(RejectReason.MAX_OPEN_TRADES)
            notes.append(
                f"{len(portfolio.open_symbols)} positions open; the limit is "
                f"{self.limits.max_open_trades}."
            )

        if portfolio.day == now.date():
            daily_loss = portfolio.daily_loss_pct
            if daily_loss >= self.limits.max_daily_loss_pct:
                reasons.append(RejectReason.DAILY_LOSS_LIMIT)
                notes.append(
                    f"Down {daily_loss:.2f}% today; the limit is "
                    f"{self.limits.max_daily_loss_pct}%. Trading is paused until tomorrow."
                )

        drawdown = portfolio.drawdown_pct
        if drawdown >= self.limits.max_drawdown_pct:
            reasons.append(RejectReason.DRAWDOWN_LIMIT)
            notes.append(
                f"Drawdown is {drawdown:.2f}% from peak equity; the limit is "
                f"{self.limits.max_drawdown_pct}%."
            )

        if confidence < self.limits.min_confidence:
            reasons.append(RejectReason.CONFIDENCE_TOO_LOW)
            notes.append(
                f"Confidence {confidence} is below the {self.limits.min_confidence} floor."
            )

        if reward_risk is None or reward_risk < self.limits.min_reward_risk:
            reasons.append(RejectReason.RISK_REWARD_TOO_LOW)
            notes.append(
                f"Reward-to-risk {reward_risk or 0} is below the "
                f"{self.limits.min_reward_risk} floor."
            )

        if not volatility_tradeable:
            reasons.append(RejectReason.VOLATILITY_EXTREME)
            notes.append("Volatility is extreme; stops would be run by noise.")

        # `projected_heat_pct` is what the book would risk in a joint adverse
        # move WITH this position added, not what it risks now. Checking the
        # current heat would approve the trade that breaches the limit and then
        # refuse the one after it.
        if projected_heat_pct is not None:
            if projected_heat_pct > self.limits.max_portfolio_heat_pct:
                reasons.append(RejectReason.PORTFOLIO_HEAT)
                notes.append(
                    f"Opening this would put {projected_heat_pct:.2f}% of the account "
                    f"at risk in a correlated move; the limit is "
                    f"{self.limits.max_portfolio_heat_pct}%. Position count is not "
                    "the constraint here — concentration is."
                )

        if notional <= 0:
            reasons.append(RejectReason.POSITION_TOO_SMALL)
            notes.append("Computed position size is zero.")
        elif notional < self.limits.min_notional:
            reasons.append(RejectReason.POSITION_TOO_SMALL)
            notes.append(f"Position of {notional} is below the minimum worth trading.")
        elif notional > portfolio.balance:
            reasons.append(RejectReason.INSUFFICIENT_BALANCE)
            notes.append(f"Position of {notional} exceeds the balance of {portfolio.balance}.")

        return RiskDecision(
            approved=not reasons,
            reasons=tuple(reasons),
            notes=tuple(notes),
            heat_checked=projected_heat_pct is not None,
        )

    def halt_state(
        self, portfolio: PortfolioState, now: datetime | None = None
    ) -> dict[str, object]:
        """Is the bot stopped by an account-level limit, regardless of setup?

        `evaluate` answers "may this trade be opened", which mixes the
        properties of one setup with the state of the whole account. An
        operator needs the second question answered on its own: a bot that has
        gone quiet because no setup qualifies and a bot that has gone quiet
        because it hit its drawdown limit look identical from the outside, and
        only one of them needs a human.
        """
        now = now or datetime.now(UTC)
        drawdown = portfolio.drawdown_pct
        daily_loss = portfolio.daily_loss_pct if portfolio.day == now.date() else Decimal(0)

        blocks: list[dict[str, object]] = []
        if drawdown >= self.limits.max_drawdown_pct:
            blocks.append(
                {
                    "limit": "max_drawdown",
                    "value": str(drawdown.quantize(Decimal("0.01"))),
                    "threshold": str(self.limits.max_drawdown_pct),
                    "clears": "manual",
                    "explanation": (
                        "Drawdown from the account's high-water mark has passed the "
                        "limit. This does not clear on its own: equity rises only by "
                        "trading, and trading is what the limit has stopped. It "
                        "needs a deliberate acknowledgement, which is recorded."
                    ),
                }
            )
        if daily_loss >= self.limits.max_daily_loss_pct:
            blocks.append(
                {
                    "limit": "max_daily_loss",
                    "value": str(daily_loss.quantize(Decimal("0.01"))),
                    "threshold": str(self.limits.max_daily_loss_pct),
                    "clears": "at the next UTC day",
                    "explanation": (
                        "Today's realised losses passed the daily limit. Trading "
                        "resumes tomorrow with no action needed."
                    ),
                }
            )

        return {
            "halted": bool(blocks),
            "blocks": blocks,
            "drawdown_pct": str(drawdown.quantize(Decimal("0.01"))),
            "peak_equity": str(portfolio.peak_equity),
        }
