"""Replaying the whole book, not one symbol at a time.

The single-symbol replay answers "would this have worked on BTC". That is a
different and much easier question than "what would this have done to my
account", and the gap between them is where every portfolio-level limit lives.
Replaying symbols one at a time cannot see any of it:

**Capital is shared.** Five symbols replayed separately each get the full
balance. Replayed together they compete for it, and the position that opens
first is the one that gets taken.

**The limits bind.** `max_open_trades`, the daily-loss limit, the drawdown halt
and — the one this makes testable for the first time — the correlation heat
limit only mean anything when several positions can exist at once.

**One clock.** Every symbol advances on the same bar, so a day that goes badly
goes badly everywhere at once, which is exactly the day the limits exist for.

The no-look-ahead guarantee is unchanged and still structural: each symbol gets
its own `Window` at the same cursor, and the fill still lands on the next bar's
open.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal

from app.analysis import correlation
from app.analysis.series import Series
from app.backtest.window import Window
from app.market_data.schemas import Candle
from app.paper.broker import PaperBroker
from app.paper.engine import ExitReason, OpenRequest, PaperEngine
from app.paper.models import PaperTrade
from app.paper.portfolio import Performance, equity_curve, performance
from app.risk.manager import PortfolioState, RiskLimits, RiskManager
from app.signals.analyzer import MIN_BARS, analyse, build_signal

# The same window the live bot correlates over.
CORRELATION_BARS = 240


@dataclass(frozen=True, slots=True)
class PortfolioBacktestConfig:
    symbols: tuple[str, ...]
    timeframe: str
    starting_balance: Decimal = Decimal("10000")
    risk_pct: Decimal = Decimal("1")
    limits: RiskLimits = field(default_factory=RiskLimits)
    strategy: str = "multi-factor-v1"


@dataclass
class PortfolioBacktestResult:
    config: PortfolioBacktestConfig
    trades: list[PaperTrade]
    performance: Performance
    equity: list[tuple[datetime, Decimal]]
    bars_replayed: int
    signals_generated: int
    # Why the replay declined, counted by rule. The most useful number in the
    # whole result: it separates "no setup qualified" from "the account would
    # not allow it", and only the second is a portfolio effect.
    refusals: dict[str, int]
    peak_open_positions: int
    buy_and_hold_pct: Decimal
    caveats: tuple[str, ...] = ()

    @property
    def total_return_pct(self) -> Decimal:
        start = self.config.starting_balance
        if start <= 0:
            return Decimal(0)
        return (self.performance.total_pnl / start * 100).quantize(Decimal("0.01"))

    def to_dict(self) -> dict[str, object]:
        return {
            "kind": "PORTFOLIO_BACKTEST",
            "symbols": list(self.config.symbols),
            "timeframe": self.config.timeframe,
            "starting_balance": str(self.config.starting_balance),
            "risk_pct": str(self.config.risk_pct),
            "bars_replayed": self.bars_replayed,
            "signals_generated": self.signals_generated,
            "refusals": self.refusals,
            "peak_open_positions": self.peak_open_positions,
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
                }
                for t in self.trades
            ],
            "caveats": list(self.caveats),
        }


class PortfolioBacktester:
    def __init__(self, config: PortfolioBacktestConfig) -> None:
        self.config = config
        self.broker = PaperBroker()
        self.engine = PaperEngine(self.broker)
        self.risk = RiskManager(config.limits)

    async def run(self, candles: dict[str, list[Candle]]) -> PortfolioBacktestResult:
        series = {symbol: self._settled(rows) for symbol, rows in candles.items() if rows}
        series = {s: rows for s, rows in series.items() if rows}
        if not series:
            return self._empty(("No candles were supplied for any symbol.",))

        # One clock for every symbol. Bars are matched by timestamp rather than
        # by index: two symbols with the same bar count are not necessarily the
        # same window, and pairing them by position would replay Tuesday's
        # BTC against Wednesday's ETH.
        timeline = sorted(
            set.intersection(*({c.open_time for c in rows} for rows in series.values()))
        )
        if len(timeline) < MIN_BARS + 2:
            return self._empty(
                (
                    f"Only {len(timeline)} bars are shared by all "
                    f"{len(series)} symbols; {MIN_BARS + 2} are needed. "
                    "Nothing is inferred from a window this short.",
                )
            )

        by_time = {symbol: {c.open_time: c for c in rows} for symbol, rows in series.items()}
        aligned = {symbol: tuple(by_time[symbol][at] for at in timeline) for symbol in series}

        closed: list[PaperTrade] = []
        book: list[PaperTrade] = []
        refusals: dict[str, int] = {}
        signals = 0
        replayed = 0
        peak_open = 0

        for cursor in range(len(timeline)):
            windows = {s: Window(rows, cursor) for s, rows in aligned.items()}
            next_bars = {s: w.next_bar for s, w in windows.items()}
            if any(bar is None for bar in next_bars.values()):
                break

            at = timeline[cursor]
            replayed += 1

            # 1. Manage what is open, before considering anything new — capital
            # freed by a close is available to an entry on the same bar.
            book = await self._monitor(book, next_bars, closed)

            if cursor < MIN_BARS:
                continue

            # 2. Correlations across the visible window only.
            visible = {s: w.to_series() for s, w in windows.items()}
            correlations = correlation.matrix(
                {s: correlation.series_window(v, CORRELATION_BARS) for s, v in visible.items()}
            )

            # 3. Consider each symbol, in a fixed order so the replay is
            # reproducible. The order matters — capital is finite — and sorting
            # makes that bias explicit rather than dependent on dict ordering.
            for symbol in sorted(aligned):
                opened, reason = await self._consider(
                    symbol=symbol,
                    series=visible[symbol],
                    fill_bar=next_bars[symbol],
                    at=at,
                    book=book,
                    closed=closed,
                    correlations=correlations,
                )
                if reason:
                    refusals[reason] = refusals.get(reason, 0) + 1
                if opened is not None:
                    signals += 1
                    book.append(opened)

            peak_open = max(peak_open, len(book))

        caveats: list[str] = []
        if book:
            last = timeline[-1]
            for trade in book:
                bar = aligned[trade.symbol][-1]
                result = await self.engine.close(trade, price=bar.close, reason="end_of_data")
                result.trade.closed_at = last
                closed.append(result.trade)
            caveats.append(
                f"{len(book)} position(s) were still open when the data ended; "
                "they are closed at the final close and marked `end_of_data`."
            )

        return PortfolioBacktestResult(
            config=self.config,
            trades=closed,
            performance=performance(closed, self.config.starting_balance),
            equity=equity_curve(closed, self.config.starting_balance),
            bars_replayed=replayed,
            signals_generated=signals,
            refusals=refusals,
            peak_open_positions=peak_open,
            buy_and_hold_pct=self._buy_and_hold(aligned),
            caveats=tuple(caveats),
        )

    # --- the pieces ------------------------------------------------------

    async def _monitor(
        self,
        book: list[PaperTrade],
        next_bars: dict[str, Candle | None],
        closed: list[PaperTrade],
    ) -> list[PaperTrade]:
        still_open: list[PaperTrade] = []
        for trade in book:
            bar = next_bars.get(trade.symbol)
            if bar is None:
                still_open.append(trade)
                continue

            reason = self.engine.check_exit(trade, high=bar.high, low=bar.low)
            if reason is None:
                self.engine.breakeven_stop(trade, bar.close)
                still_open.append(trade)
                continue

            exit_price = trade.stop_loss if reason == ExitReason.STOP_LOSS else trade.take_profit
            result = await self.engine.close(trade, price=exit_price, reason=reason)
            result.trade.closed_at = bar.open_time
            closed.append(result.trade)
        return still_open

    async def _consider(
        self,
        *,
        symbol: str,
        series: Series,
        fill_bar: Candle,
        at: datetime,
        book: list[PaperTrade],
        closed: list[PaperTrade],
        correlations: dict[tuple[str, str], float],
    ) -> tuple[PaperTrade | None, str | None]:
        analysis = analyse(series, symbol, self.config.timeframe)
        if analysis is None:
            return None, "insufficient_history"

        balance = self._balance(closed)
        signal = build_signal(
            analysis,
            balance=balance,
            risk_pct=self.config.risk_pct,
            min_confidence=self.config.limits.min_confidence,
            min_reward_risk=self.config.limits.min_reward_risk,
        )
        if signal.decision != "TRADE" or signal.plan is None:
            return None, "no_qualifying_setup"

        state = self._state(book, closed, balance, at)
        heat = correlation.portfolio_heat(
            [correlation.Exposure(t.symbol, t.direction, t.risk_amount) for t in book]
            + [correlation.Exposure(symbol, signal.signal, signal.plan.size.risk_amount)],
            correlations,
            state.equity,
        )

        decision = self.risk.evaluate(
            symbol=symbol,
            portfolio=state,
            confidence=Decimal(str(signal.confidence)),
            reward_risk=signal.risk_reward,
            notional=signal.plan.size.notional,
            # Historical data is complete by definition; the live veto on
            # unreliable data has no meaning during a replay.
            data_is_live=True,
            volatility_tradeable=analysis.volatility.is_tradeable,
            now=datetime.combine(at.date(), datetime.min.time(), tzinfo=UTC),
            projected_heat_pct=heat.effective_pct,
        )
        if not decision.approved:
            return None, decision.reasons[0].value if decision.reasons else "refused"

        plan = signal.plan
        trade = await self.engine.open(
            OpenRequest(
                symbol=symbol,
                direction=signal.signal,
                timeframe=self.config.timeframe,
                # Filled on the NEXT bar's open, never the close it decided from.
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
        trade.opened_at = fill_bar.open_time
        return trade, None

    # --- helpers ---------------------------------------------------------

    def _settled(self, rows: list[Candle]) -> list[Candle]:
        ordered = sorted(rows, key=lambda c: c.open_time)
        if ordered and not ordered[-1].closed:
            ordered = ordered[:-1]
        return ordered

    def _balance(self, closed: list[PaperTrade]) -> Decimal:
        return self.config.starting_balance + sum((t.pnl or Decimal(0)) for t in closed)

    def _state(
        self,
        book: list[PaperTrade],
        closed: list[PaperTrade],
        balance: Decimal,
        at: datetime,
    ) -> PortfolioState:
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
            open_symbols=frozenset(t.symbol for t in book),
            realised_today=Decimal(realised_today),
            day=at.date(),
        )

    def _buy_and_hold(self, aligned: dict[str, tuple[Candle, ...]]) -> Decimal:
        """An equal-weight basket of everything replayed.

        Comparing a five-symbol strategy against one symbol's return would flatter
        or damn it depending on which symbol was picked.
        """
        returns: list[Decimal] = []
        for rows in aligned.values():
            if len(rows) < 2 or rows[0].open <= 0:
                continue
            returns.append((rows[-1].close - rows[0].open) / rows[0].open * 100)
        if not returns:
            return Decimal(0)
        return (sum(returns) / len(returns)).quantize(Decimal("0.01"))

    def _empty(self, caveats: tuple[str, ...]) -> PortfolioBacktestResult:
        return PortfolioBacktestResult(
            config=self.config,
            trades=[],
            performance=performance([], self.config.starting_balance),
            equity=[],
            bars_replayed=0,
            signals_generated=0,
            refusals={},
            peak_open_positions=0,
            buy_and_hold_pct=Decimal(0),
            caveats=caveats,
        )
