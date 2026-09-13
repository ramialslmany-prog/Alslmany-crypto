"""Bot and portfolio endpoints."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_market_service, settings_dep
from app.config import Settings
from app.core.errors import MarketDataError
from app.core.logging import get_logger
from app.database.session import get_session
from app.market_data.timeframes import parse_timeframe
from app.paper.broker import PaperBroker
from app.paper.engine import ExitReason, PaperEngine
from app.paper.models import PaperTrade
from app.paper.portfolio import equity_curve, performance, portfolio_state
from app.paper.runner import BotRunner
from app.paper.store import TradeRepository
from app.risk.manager import RiskLimits
from app.services.market_service import MarketService

logger = get_logger(__name__)
router = APIRouter(prefix="/bot", tags=["bot"])


def _limits(settings: Settings) -> RiskLimits:
    return RiskLimits(
        risk_per_trade_pct=settings.risk_per_trade_pct,
        max_open_trades=settings.max_open_trades,
        max_daily_loss_pct=settings.max_daily_loss_pct,
        max_drawdown_pct=settings.max_drawdown_pct,
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
        # Stated on every trade, in every response. The guarantee should not
        # require reading the documentation to discover.
        "is_paper": True,
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
    state = portfolio_state(
        trades=trades, starting_balance=settings.initial_balance_usdt, marks=marks
    )
    stats = performance(closed, settings.initial_balance_usdt)

    return {
        "paper_trading_only": True,
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


@router.post("/tick")
async def tick(
    settings: Annotated[Settings, Depends(settings_dep)],
    market: Annotated[MarketService, Depends(get_market_service)],
    session: Annotated[AsyncSession, Depends(get_session)],
    timeframe: Annotated[str, Query()] = "1h",
    x_cron_secret: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    """Run one pass of the bot.

    Closed by default. When `CRON_SECRET` is configured the header must match;
    an endpoint that opens positions must not be callable by anyone who finds
    the URL. It is a POST because it changes state.
    """
    expected = getattr(settings, "cron_secret", None)
    if expected and x_cron_secret != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    repo = TradeRepository(session)
    trades = await repo.all()

    runner = BotRunner(
        market=market,
        engine=PaperEngine(PaperBroker()),
        limits=_limits(settings),
        starting_balance=settings.initial_balance_usdt,
        timeframe=parse_timeframe(timeframe),
    )
    report = await runner.tick(settings.symbol_list, trades)
    repo.add_all(report.new_trades)

    return {"paper_trading_only": True, **report.to_dict()}


@router.post("/trades/{trade_id}/close")
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
