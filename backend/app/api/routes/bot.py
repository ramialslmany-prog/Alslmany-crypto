"""Bot and portfolio endpoints."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.analysis import correlation
from app.analysis.series import to_series
from app.api.deps import get_market_service, require_operator, settings_dep
from app.config import Settings
from app.core.errors import MarketDataError
from app.core.logging import get_logger
from app.database.session import get_session
from app.market_data.timeframes import Timeframe, parse_timeframe
from app.paper.broker import PaperBroker
from app.paper.engine import ExitReason, PaperEngine
from app.paper.models import PaperTrade
from app.paper.portfolio import equity_curve, performance, portfolio_state
from app.paper.runner import BotRunner
from app.paper.store import RiskOverrideRepository, TradeRepository
from app.risk.manager import RiskLimits, RiskManager
from app.services.market_service import MarketService

logger = get_logger(__name__)

# Matches the bot's own correlation window: roughly two months of hourly
# bars, long enough to measure and short enough that last quarter's regime
# does not outvote this week's.
HEAT_BARS = 240
router = APIRouter(prefix="/bot", tags=["bot"])


def _limits(settings: Settings) -> RiskLimits:
    return RiskLimits(
        risk_per_trade_pct=settings.risk_per_trade_pct,
        max_open_trades=settings.max_open_trades,
        max_daily_loss_pct=settings.max_daily_loss_pct,
        max_drawdown_pct=settings.max_drawdown_pct,
        max_portfolio_heat_pct=settings.max_portfolio_heat_pct,
    )


def _trade_dict(trade: PaperTrade, mark: Decimal | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": trade.id,
        "symbol": trade.symbol,
        "direction": trade.direction,
        "status": trade.status,
        "timeframe": trade.timeframe,
        "entry": str(trade.entry),
        "stop_loss": str(trade.stop_loss),
        "take_profit": str(trade.take_profit),
        "quantity": str(trade.quantity),
        "notional": str(trade.notional),
        "risk_amount": str(trade.risk_amount),
        "reward_risk": str(trade.reward_risk),
        "confidence": str(trade.confidence),
        "strategy": trade.strategy,
        "reason": trade.reason,
        "evidence": trade.evidence,
        "opened_at": trade.opened_at.isoformat() if trade.opened_at else None,
        "closed_at": trade.closed_at.isoformat() if trade.closed_at else None,
        "exit_price": str(trade.exit_price) if trade.exit_price is not None else None,
        "pnl": str(trade.pnl) if trade.pnl is not None else None,
        "pnl_pct": str(trade.pnl_pct) if trade.pnl_pct is not None else None,
        "r_multiple": str(trade.r_multiple) if trade.r_multiple is not None else None,
        "result": trade.result,
        "exit_reason": trade.exit_reason,
        "fees": str(trade.fees),
        # Stated on every trade, in every response: the guarantee should not
        # require reading the documentation to discover. Read from the row
        # rather than hardcoded — a literal True would keep printing the
        # guarantee even on a row that did not satisfy it, which is the one
        # circumstance where this field would actually matter.
        "is_paper": bool(trade.is_paper),
    }
    if mark is not None and trade.status == "open":
        move = mark - trade.entry if trade.direction == "LONG" else trade.entry - mark
        pnl = move * trade.quantity
        payload["current_price"] = str(mark)
        payload["unrealised_pnl"] = str(pnl.quantize(Decimal("0.01")))
        payload["unrealised_r"] = str(
            (pnl / trade.risk_amount).quantize(Decimal("0.01"))
            if trade.risk_amount > 0
            else Decimal(0)
        )
    return payload


async def _marks(market: MarketService, symbols: set[str]) -> dict[str, Decimal]:
    marks: dict[str, Decimal] = {}
    for symbol in symbols:
        try:
            marks[symbol] = (await market.get_ticker(symbol)).data.price
        except MarketDataError:
            continue
    return marks


@router.get("/portfolio")
async def portfolio(
    settings: Annotated[Settings, Depends(settings_dep)],
    market: Annotated[MarketService, Depends(get_market_service)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, Any]:
    repo = TradeRepository(session)
    trades = await repo.all()
    open_trades = [t for t in trades if t.status == "open"]
    closed = [t for t in trades if t.status == "closed"]

    marks = await _marks(market, {t.symbol for t in open_trades})
    override = await RiskOverrideRepository(session).latest_drawdown_reset()
    state = portfolio_state(
        trades=trades,
        starting_balance=settings.initial_balance_usdt,
        marks=marks,
        peak_reset=(None if override is None else (override.at, override.baseline_equity)),
    )
    stats = performance(closed, settings.initial_balance_usdt)

    # A bot that has stopped because nothing qualifies and a bot that has
    # stopped because it hit its drawdown limit look identical from outside.
    # Only one of them needs a human, so the difference is stated.
    halt = RiskManager(_limits(settings)).halt_state(state)

    # What the open book would lose together. `max_open_trades` bounds the
    # number of positions; this is the only number that bounds the bet.
    heat = await _heat_of(market, open_trades, state.equity)

    return {
        "paper_trading_only": True,
        "halt": halt,
        "heat": heat.to_dict(),
        "heat_limit_pct": str(settings.max_portfolio_heat_pct),
        "last_drawdown_reset": (
            None
            if override is None
            else {
                "at": override.at.isoformat(),
                "baseline_equity": str(override.baseline_equity),
                "drawdown_pct_at_reset": str(override.drawdown_pct_at_reset),
                "note": override.note,
            }
        ),
        "starting_balance": str(settings.initial_balance_usdt),
        "balance": str(state.balance),
        "equity": str(state.equity),
        "peak_equity": str(state.peak_equity),
        "open_positions": len(open_trades),
        "drawdown_pct": str(state.drawdown_pct.quantize(Decimal("0.01"))),
        "realised_today": str(state.realised_today),
        "daily_loss_pct": str(state.daily_loss_pct.quantize(Decimal("0.01"))),
        "performance": stats.to_dict(),
        "limits": {
            "risk_per_trade_pct": str(settings.risk_per_trade_pct),
            "max_open_trades": settings.max_open_trades,
            "max_daily_loss_pct": str(settings.max_daily_loss_pct),
            "max_drawdown_pct": str(settings.max_drawdown_pct),
            "max_portfolio_heat_pct": str(settings.max_portfolio_heat_pct),
        },
    }


@router.get("/trades/open")
async def open_positions(
    market: Annotated[MarketService, Depends(get_market_service)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, Any]:
    trades = await TradeRepository(session).open_trades()
    marks = await _marks(market, {t.symbol for t in trades})
    return {"data": [_trade_dict(t, marks.get(t.symbol)) for t in trades]}


@router.get("/trades/history")
async def history(
    session: Annotated[AsyncSession, Depends(get_session)],
    symbol: Annotated[str | None, Query()] = None,
    direction: Annotated[str | None, Query()] = None,
    result: Annotated[str | None, Query()] = None,
    strategy: Annotated[str | None, Query()] = None,
    min_confidence: Annotated[float | None, Query(ge=0, le=100)] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> dict[str, Any]:
    """Closed trades, filterable. Wins and losses are given equal weight."""
    trades = await TradeRepository(session).closed_trades(limit=500)

    if symbol:
        trades = [t for t in trades if t.symbol == symbol.upper()]
    if direction:
        trades = [t for t in trades if t.direction == direction.upper()]
    if result:
        trades = [t for t in trades if t.result == result.upper()]
    if strategy:
        trades = [t for t in trades if t.strategy == strategy]
    if min_confidence is not None:
        trades = [t for t in trades if float(t.confidence) >= min_confidence]

    return {
        "data": [_trade_dict(t) for t in trades[:limit]],
        "total": len(trades),
    }


@router.get("/equity-curve")
async def curve(
    settings: Annotated[Settings, Depends(settings_dep)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, Any]:
    closed = await TradeRepository(session).closed_trades(limit=500)
    points = equity_curve(closed, settings.initial_balance_usdt)
    return {
        "starting_balance": str(settings.initial_balance_usdt),
        "data": [{"at": at.isoformat(), "balance": str(balance)} for at, balance in points],
    }


@router.post("/tick", dependencies=[Depends(require_operator)])
async def tick(
    settings: Annotated[Settings, Depends(settings_dep)],
    market: Annotated[MarketService, Depends(get_market_service)],
    session: Annotated[AsyncSession, Depends(get_session)],
    timeframe: Annotated[str, Query()] = "1h",
) -> dict[str, Any]:
    """Run one pass of the bot.

    A POST because it changes state, and behind `require_operator` because an
    endpoint that opens positions must not be callable by anyone who finds the
    URL.
    """
    repo = TradeRepository(session)
    trades = await repo.all()
    override = await RiskOverrideRepository(session).latest_drawdown_reset()

    runner = BotRunner(
        market=market,
        engine=PaperEngine(PaperBroker()),
        limits=_limits(settings),
        starting_balance=settings.initial_balance_usdt,
        timeframe=parse_timeframe(timeframe),
    )
    report = await runner.tick(
        settings.symbol_list,
        trades,
        peak_reset=(None if override is None else (override.at, override.baseline_equity)),
    )
    repo.add_all(report.new_trades)

    return {"paper_trading_only": True, **report.to_dict()}


@router.post("/trades/{trade_id}/close", dependencies=[Depends(require_operator)])
async def close_manually(
    trade_id: int,
    market: Annotated[MarketService, Depends(get_market_service)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, Any]:
    trades = await TradeRepository(session).open_trades()
    trade = next((t for t in trades if t.id == trade_id), None)
    if trade is None:
        raise HTTPException(status_code=404, detail="No open trade with that id.")

    sourced = await market.get_ticker(trade.symbol)
    engine = PaperEngine(PaperBroker())
    result = await engine.close(trade, price=sourced.data.price, reason=ExitReason.MANUAL)
    return {"data": _trade_dict(result.trade), "pnl": str(result.pnl)}


@router.post("/risk/acknowledge-drawdown", dependencies=[Depends(require_operator)])
async def acknowledge_drawdown(
    settings: Annotated[Settings, Depends(settings_dep)],
    market: Annotated[MarketService, Depends(get_market_service)],
    session: Annotated[AsyncSession, Depends(get_session)],
    note: Annotated[str | None, Query(max_length=500)] = None,
) -> dict[str, Any]:
    """Clear a drawdown halt by resetting the high-water mark to today's equity.

    This is the one place in the system where a human overrides a risk limit,
    so three things are true of it and none are negotiable.

    It is a **POST behind the same operator guard as the tick**: resuming a bot
    that stopped after a 10% loss must not be reachable by anyone who finds the
    URL.

    It is **recorded, not applied**: an append-only row carries the equity, the
    drawdown at the moment of the decision, and whatever the operator wrote. A
    limit that can be lifted without trace is not a limit.

    It **refuses when there is nothing to clear**, rather than quietly writing a
    row. Resetting a high-water mark that is not breached would silently discard
    a real peak and lower the bar for the next halt.
    """
    repo = TradeRepository(session)
    overrides = RiskOverrideRepository(session)
    trades = await repo.all()
    open_trades = [t for t in trades if t.status == "open"]

    marks = await _marks(market, {t.symbol for t in open_trades})
    previous = await overrides.latest_drawdown_reset()
    state = portfolio_state(
        trades=trades,
        starting_balance=settings.initial_balance_usdt,
        marks=marks,
        peak_reset=(None if previous is None else (previous.at, previous.baseline_equity)),
    )

    limits = _limits(settings)
    drawdown = state.drawdown_pct
    if drawdown < limits.max_drawdown_pct:
        return {
            "acknowledged": False,
            "reason": (
                f"Drawdown is {drawdown.quantize(Decimal('0.01'))}%, inside the "
                f"{limits.max_drawdown_pct}% limit. There is nothing to clear, and "
                "resetting the high-water mark anyway would discard a real peak."
            ),
            "halt": RiskManager(limits).halt_state(state),
        }

    now = datetime.now(UTC)
    override = overrides.record_drawdown_reset(
        baseline_equity=state.equity,
        drawdown_pct=drawdown.quantize(Decimal("0.01")),
        note=note,
        at=now,
    )
    await session.flush()

    logger.warning(
        "drawdown limit acknowledged by operator",
        extra={
            "baseline_equity": str(override.baseline_equity),
            "drawdown_pct": str(override.drawdown_pct_at_reset),
            "note": note,
        },
    )

    return {
        "acknowledged": True,
        "baseline_equity": str(override.baseline_equity),
        "drawdown_pct_at_reset": str(override.drawdown_pct_at_reset),
        "at": now.isoformat(),
        "note": note,
        "effect": (
            "Drawdown is now measured from this equity forward. The previous peak "
            "is not restored, and this decision stays on the record."
        ),
    }


@router.get("/risk/overrides")
async def risk_overrides(
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, Any]:
    """Every time a human overrode a risk limit. Read-only, oldest kept."""
    rows = await RiskOverrideRepository(session).history()
    return {
        "data": [
            {
                "kind": r.kind,
                "at": r.at.isoformat(),
                "baseline_equity": str(r.baseline_equity),
                "drawdown_pct_at_reset": str(r.drawdown_pct_at_reset),
                "note": r.note,
            }
            for r in rows
        ]
    }


async def _heat_of(
    market: MarketService, open_trades: list[PaperTrade], equity: Decimal
) -> correlation.Heat:
    """Correlation-aware risk across the open book.

    Correlations are measured from the same daily history the benchmark uses.
    A symbol whose history cannot be fetched simply does not contribute a
    measured pair, and `portfolio_heat` then assumes the pair is correlated —
    the conservative reading, and the right one when the alternative is
    reporting a concentrated book as diversified.
    """
    exposures = [
        correlation.Exposure(symbol=t.symbol, direction=t.direction, risk_amount=t.risk_amount)
        for t in open_trades
    ]
    if len(exposures) < 2:
        return correlation.portfolio_heat(exposures, {}, equity)

    symbols = sorted({e.symbol for e in exposures})
    fetched = await asyncio.gather(
        *(market.get_candles(s, Timeframe.H1, limit=HEAT_BARS, persist=False) for s in symbols),
        return_exceptions=True,
    )
    series = {
        symbol: to_series(result.data)
        for symbol, result in zip(symbols, fetched, strict=True)
        if not isinstance(result, BaseException)
    }
    return correlation.portfolio_heat(exposures, correlation.matrix(series), equity)
