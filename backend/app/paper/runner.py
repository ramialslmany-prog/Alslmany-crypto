"""The bot's tick: scan, decide, open, monitor, close.

One pass over every tracked symbol. Monitoring runs BEFORE opening, always:
capital freed by a close in this tick should be available to the entry in the
same tick, and more importantly a position that should have been stopped out
must not still be counted against the open-position limit when the limit is
checked.

The tick is deliberately not a long-running loop. It is a function that can be
called by a scheduler, a cron endpoint or a test, which makes the bot's entire
behaviour reproducible from a fixed input.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime
from decimal import Decimal
from typing import Any

from app.analysis.series import to_series
from app.core.errors import MarketDataError
from app.core.logging import get_logger
from app.market_data.timeframes import Timeframe
from app.paper.engine import ExitReason, OpenRequest, PaperEngine
from app.paper.models import PaperTrade
from app.paper.portfolio import portfolio_state
from app.risk.manager import PortfolioState, RiskLimits, RiskManager
from app.services.market_service import MarketService
from app.signals.analyzer import analyse, build_signal

logger = get_logger(__name__)


@dataclass
class TickReport:
    """What the bot did, and what it declined to do and why."""

    scanned: list[str] = field(default_factory=list)
    # Trades opened this tick, for the caller to persist. The runner does not
    # own a database session: keeping it free of persistence is what lets the
    # whole decision path be exercised from a fixed input with no database.
    new_trades: list[PaperTrade] = field(default_factory=list)
    signals: list[dict[str, Any]] = field(default_factory=list)
    opened: list[str] = field(default_factory=list)
    closed: list[dict[str, Any]] = field(default_factory=list)
    # Rejections are reported, not swallowed. "Why is the bot not trading" has
    # to be answerable, and silence is the worst possible answer.
    rejected: list[dict[str, Any]] = field(default_factory=list)
    errors: list[dict[str, str]] = field(default_factory=list)
    # Account-level state at the moment of the tick. A tick that opened nothing
    # because the drawdown limit halted the bot is a different event from one
    # that opened nothing because no setup qualified.
    halt: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        # new_trades holds ORM objects and is deliberately excluded: this dict
        # is the wire format, and a half-serialised model on it would be a
        # source of confusion at best.
        return {
            "scanned": self.scanned,
            "signals": self.signals,
            "opened": self.opened,
            "closed": self.closed,
            "rejected": self.rejected,
            "errors": self.errors,
            "halt": self.halt,
        }


class BotRunner:
    def __init__(
        self,
        *,
        market: MarketService,
        engine: PaperEngine,
        risk: RiskManager | None = None,
        limits: RiskLimits | None = None,
        starting_balance: Decimal = Decimal("10000"),
        timeframe: Timeframe = Timeframe.H1,
        strategy: str = "multi-factor-v1",
    ) -> None:
        self.market = market
        self.engine = engine
        self.risk = risk or RiskManager(limits)
        self.starting_balance = starting_balance
        self.timeframe = timeframe
        self.strategy = strategy

    async def tick(
        self,
        symbols: list[str],
        trades: list[PaperTrade],
        peak_reset: tuple[datetime, Decimal] | None = None,
    ) -> TickReport:
        report = TickReport()

        # 1. Manage what is already open, before considering anything new.
        await self._monitor(trades, report)

        open_trades = [t for t in trades if t.status == "open"]
        marks = await self._marks(open_trades, report)
        state = portfolio_state(
            trades=trades,
            starting_balance=self.starting_balance,
            marks=marks,
            peak_reset=peak_reset,
        )
        # Stated on the report itself: a tick that opened nothing because the
        # account is halted is a different event from one that opened nothing
        # because no setup qualified, and the report is where an operator looks.
        report.halt = self.risk.halt_state(state)

        # 2. Look for new entries.
        for symbol in symbols:
            report.scanned.append(symbol)
            try:
                state = await self._consider(symbol, state, report)
            except MarketDataError as exc:
                report.errors.append({"symbol": symbol, "code": exc.code})
            except Exception as exc:
                logger.exception("symbol scan failed", extra={"symbol": symbol})
                report.errors.append({"symbol": symbol, "code": type(exc).__name__})

        return report

    # --- monitoring ------------------------------------------------------

    async def _monitor(self, trades: list[PaperTrade], report: TickReport) -> None:
        for trade in [t for t in trades if t.status == "open"]:
            try:
                sourced = await self.market.get_candles(trade.symbol, self.timeframe, limit=2)
            except MarketDataError as exc:
                # A position whose price cannot be read is NOT closed here.
                # Closing on missing data would book a fictional exit price;
                # the position is left open and the gap is reported.
                report.errors.append(
                    {"symbol": trade.symbol, "code": exc.code, "context": "monitor"}
                )
                continue

            if not sourced.data:
                continue

            bar = sourced.data[-1]
            reason = self.engine.check_exit(trade, high=bar.high, low=bar.low)

            if reason is None:
                # Only tighten, and only once the trade has earned it.
                self.engine.breakeven_stop(trade, bar.close)
                continue

            exit_price = trade.stop_loss if reason == ExitReason.STOP_LOSS else trade.take_profit
            result = await self.engine.close(trade, price=exit_price, reason=reason)
            report.closed.append(
                {
                    "symbol": trade.symbol,
                    "reason": reason,
                    "pnl": str(result.pnl),
                    "r": str(result.r_multiple),
                    "result": result.result,
                }
            )

    async def _marks(self, open_trades: list[PaperTrade], report: TickReport) -> dict[str, Decimal]:
        marks: dict[str, Decimal] = {}
        for trade in open_trades:
            try:
                sourced = await self.market.get_ticker(trade.symbol)
                marks[trade.symbol] = sourced.data.price
            except MarketDataError:
                # Left absent on purpose: portfolio_state carries the position at
                # entry rather than dropping it, which is the conservative read.
                continue
        return marks

    # --- entries ---------------------------------------------------------

    async def _consider(self, symbol: str, state, report: TickReport) -> PortfolioState:
        """Consider one symbol. Returns the (possibly updated) portfolio state.

        The state is threaded through rather than read once per tick: a position
        opened on the first symbol must count against the open-position limit
        when the second is considered, or a single tick could open six positions
        against a limit of five.
        """
        sourced = await self.market.get_candles(symbol, self.timeframe, limit=300)

        analysis = analyse(to_series(sourced.data), symbol, self.timeframe.value)
        if analysis is None:
            report.rejected.append({"symbol": symbol, "reasons": ["insufficient_history"]})
            return state

        signal = build_signal(
            analysis,
            balance=state.balance,
            risk_pct=self.risk.limits.risk_per_trade_pct,
            min_confidence=self.risk.limits.min_confidence,
            min_reward_risk=self.risk.limits.min_reward_risk,
        )
        report.signals.append(signal.to_dict())

        if signal.decision != "TRADE" or signal.plan is None:
            report.rejected.append({"symbol": symbol, "reasons": ["no_qualifying_setup"]})
            return state

        # The data must be live, and provenance is the only thing that can say so.
        data_is_live = not (sourced.provenance.stale or sourced.provenance.cached is None)

        decision = self.risk.evaluate(
            symbol=symbol,
            portfolio=state,
            confidence=Decimal(str(signal.confidence)),
            reward_risk=signal.risk_reward,
            notional=signal.plan.size.notional,
            data_is_live=data_is_live,
            volatility_tradeable=analysis.volatility.is_tradeable,
        )

        if not decision.approved:
            report.rejected.append(
                {
                    "symbol": symbol,
                    "reasons": [r.value for r in decision.reasons],
                    "notes": list(decision.notes),
                }
            )
            return state

        plan = signal.plan
        trade = await self.engine.open(
            OpenRequest(
                symbol=symbol,
                direction=signal.signal,
                timeframe=self.timeframe.value,
                entry=plan.entry,
                stop=plan.stop,
                take_profit=plan.take_profit,
                quantity=plan.size.quantity,
                risk_amount=plan.size.risk_amount,
                reward_risk=plan.reward_risk,
                confidence=Decimal(str(signal.confidence)),
                strategy=self.strategy,
                reason=signal.reason,
                evidence=signal.evidence,
            ),
            data_is_live=data_is_live,
        )
        report.opened.append(symbol)
        report.new_trades.append(trade)
        report.signals[-1]["opened"] = True

        # Fold the new position into the state so the next symbol in this same
        # tick sees it.
        return replace(state, open_symbols=state.open_symbols | {symbol})
