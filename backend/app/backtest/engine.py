"""Historical replay.

This runs the SAME analyser, the same risk manager and the same trade plan the
live bot uses. A backtester that reimplements the strategy measures a different
strategy, and the difference only shows up as a live performance that does not
match the report.

Three properties keep the result honest, and each is a place where a backtest
usually flatters itself:

**Decide on bar i, fill on bar i+1.** A signal computed from a bar's close
cannot be filled at that close — the close is only known once the bar is over.
Filling there is the single most common way a backtest invents returns that
were never available.

**When one bar contains both the stop and the target, the stop is taken.** OHLC
cannot say which came first.

**Costs are charged every time.** Fees and adverse slippage on entry and exit,
through the same PaperBroker the live bot uses.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal

from app.backtest.window import Window
from app.market_data.schemas import Candle
from app.paper.broker import PaperBroker
from app.paper.engine import ExitReason, OpenRequest, PaperEngine
from app.paper.models import PaperTrade
from app.paper.portfolio import Performance, equity_curve, performance
from app.risk.manager import PortfolioState, RiskLimits, RiskManager
from app.signals.analyzer import MIN_BARS, analyse, build_signal


@dataclass(frozen=True, slots=True)
class BacktestConfig:
    symbol: str
    timeframe: str
    starting_balance: Decimal = Decimal("10000")
    risk_pct: Decimal = Decimal("1")
    limits: RiskLimits = field(default_factory=RiskLimits)
    strategy: str = "multi-factor-v1"


@dataclass
class BacktestResult:
    config: BacktestConfig
    trades: list[PaperTrade]
    performance: Performance
    equity: list[tuple[datetime, Decimal]]
    bars_analysed: int
    bars_skipped: int
    signals_generated: int
    buy_and_hold_pct: Decimal
    # Findings the operator should know about before reading any of the above.
    caveats: tuple[str, ...] = ()

    @property
    def total_return_pct(self) -> Decimal:
        start = self.config.starting_balance
        if start <= 0:
            return Decimal(0)
        return (self.performance.total_pnl / start * 100).quantize(Decimal("0.01"))

    def to_dict(self) -> dict[str, object]:
        return {
            # Named on every response. A backtest result and a paper-trading
            # result must never be mistaken for each other.
            "kind": "BACKTEST",
            "symbol": self.config.symbol,
            "timeframe": self.config.timeframe,
            "starting_balance": str(self.config.starting_balance),
            "risk_pct": str(self.config.risk_pct),
            "bars_analysed": self.bars_analysed,
            "bars_skipped": self.bars_skipped,
            "signals_generated": self.signals_generated,
            "total_return_pct": str(self.total_return_pct),
            "buy_and_hold_pct": str(self.buy_and_hold_pct),
            "performance": self.performance.to_dict(),
            "equity": [
                {"at": at.isoformat(), "balance": str(balance)} for at, balance in self.equity
            ],
            "trades": [
                {
                    "symbol": t.symbol,
                    "direction": t.direction,
                    "entry": str(t.entry),
                    "exit": str(t.exit_price) if t.exit_price is not None else None,
                    "pnl": str(t.pnl) if t.pnl is not None else None,
                    "r_multiple": str(t.r_multiple) if t.r_multiple is not None else None,
                    "result": t.result,
                    "exit_reason": t.exit_reason,
                    "confidence": str(t.confidence),
                    "opened_at": t.opened_at.isoformat() if t.opened_at else None,
                    "closed_at": t.closed_at.isoformat() if t.closed_at else None,
                    "reason": t.reason,
                }
                for t in self.trades
            ],
            "caveats": list(self.caveats),
        }


class Backtester:
    def __init__(self, config: BacktestConfig) -> None:
        self.config = config
        self.broker = PaperBroker()
        self.engine = PaperEngine(self.broker)
        self.risk = RiskManager(config.limits)

    async def run(self, candles: list[Candle]) -> BacktestResult:
        ordered = sorted(candles, key=lambda c: c.open_time)
        # A forming final bar has no settled close and must not be traded on.
        if ordered and not ordered[-1].closed:
            ordered = ordered[:-1]

        closed: list[PaperTrade] = []
        open_trade: PaperTrade | None = None
        analysed = 0
        skipped = 0
        signals = 0

        for cursor in range(len(ordered)):
            window = Window(tuple(ordered), cursor)
            fill_bar = window.next_bar
            if fill_bar is None:
                break  # nothing left to fill in; the replay is over

            # 1. Manage an open position against the NEXT bar's range.
            if open_trade is not None:
                reason = self.engine.check_exit(open_trade, high=fill_bar.high, low=fill_bar.low)
                if reason is not None:
                    exit_price = (
                        open_trade.stop_loss
                        if reason == ExitReason.STOP_LOSS
                        else open_trade.take_profit
                    )
                    result = await self.engine.close(open_trade, price=exit_price, reason=reason)
                    result.trade.closed_at = fill_bar.open_time
                    closed.append(result.trade)
                    open_trade = None
                else:
                    self.engine.breakeven_stop(open_trade, fill_bar.close)

            if open_trade is not None:
                continue  # one position at a time in a single-symbol replay

            # 2. Decide, using only what the window can see.
            if len(window.visible) < MIN_BARS:
                skipped += 1
                continue

            analysis = analyse(window.to_series(), self.config.symbol, self.config.timeframe)
            if analysis is None:
                skipped += 1
                continue

            analysed += 1
            balance = self._balance(closed)
            signal = build_signal(
                analysis,
                balance=balance,
                risk_pct=self.config.risk_pct,
                min_confidence=self.config.limits.min_confidence,
                min_reward_risk=self.config.limits.min_reward_risk,
            )
            if signal.decision != "TRADE" or signal.plan is None:
                continue
            signals += 1

            decision = self.risk.evaluate(
                symbol=self.config.symbol,
                portfolio=self._state(closed, balance, window.current.open_time),
                confidence=Decimal(str(signal.confidence)),
                reward_risk=signal.risk_reward,
                notional=signal.plan.size.notional,
                # Historical data is complete by definition; the live veto on
                # unreliable data has no meaning during a replay.
                data_is_live=True,
                volatility_tradeable=analysis.volatility.is_tradeable,
                now=datetime.combine(
                    window.current.open_time.date(),
                    datetime.min.time(),
                    tzinfo=UTC,
                ),
            )
            if not decision.approved:
                continue

            # 3. Fill on the NEXT bar's open, not on the close we decided from.
            plan = signal.plan
            open_trade = await self.engine.open(
                OpenRequest(
                    symbol=self.config.symbol,
                    direction=signal.signal,
                    timeframe=self.config.timeframe,
                    entry=fill_bar.open,
                    stop=plan.stop,
                    take_profit=plan.take_profit,
                    quantity=plan.size.quantity,
                    risk_amount=plan.size.risk_amount,
                    reward_risk=plan.reward_risk,
                    confidence=Decimal(str(signal.confidence)),
                    strategy=self.config.strategy,
                    reason=signal.reason,
                    evidence=signal.evidence,
                ),
                data_is_live=True,
            )
            open_trade.opened_at = fill_bar.open_time

        # A position still open at the end is marked, not silently dropped and
        # not counted as a win. Dropping it hides the strategy's worst habit:
        # holding losers.
        caveats: list[str] = []
        if open_trade is not None:
            last = ordered[-1]
            result = await self.engine.close(open_trade, price=last.close, reason="end_of_data")
            result.trade.closed_at = last.open_time
            closed.append(result.trade)
            caveats.append(
                "One position was still open when the data ended; it is closed at "
                "the final close and marked `end_of_data`."
            )

        if analysed == 0:
            caveats.append(
                f"No bar had the {MIN_BARS} bars of history the analyser needs. "
                "Supply a longer window before reading anything into this result."
            )

        return BacktestResult(
            config=self.config,
            trades=closed,
            performance=performance(closed, self.config.starting_balance),
            equity=equity_curve(closed, self.config.starting_balance),
            bars_analysed=analysed,
            bars_skipped=skipped,
            signals_generated=signals,
            buy_and_hold_pct=self._buy_and_hold(ordered),
            caveats=tuple(caveats),
        )

    # --- helpers ---------------------------------------------------------

    def _balance(self, closed: list[PaperTrade]) -> Decimal:
        return self.config.starting_balance + sum((t.pnl or Decimal(0)) for t in closed)

    def _state(self, closed: list[PaperTrade], balance: Decimal, at: datetime) -> PortfolioState:
        curve = equity_curve(closed, self.config.starting_balance)
        peak = max([self.config.starting_balance, *[b for _, b in curve]])
        realised_today = sum(
            (t.pnl or Decimal(0))
            for t in closed
            if t.closed_at is not None and t.closed_at.date() == at.date()
        )
        return PortfolioState(
            balance=balance,
            equity=balance,
            peak_equity=peak,
            open_symbols=frozenset(),
            realised_today=Decimal(realised_today),
            day=at.date(),
        )

    def _buy_and_hold(self, candles: list[Candle]) -> Decimal:
        """The benchmark that matters.

        A strategy returning 40% in a market that returned 120% did not make
        money, it cost 80%. Reporting the return without it is the most common
        way a backtest misleads.
        """
        if len(candles) < 2 or candles[0].open <= 0:
            return Decimal(0)
        first, last = candles[0].open, candles[-1].close
        return ((last - first) / first * 100).quantize(Decimal("0.01"))
