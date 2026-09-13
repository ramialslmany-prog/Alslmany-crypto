"""Historical replay over the API.

Two properties make this route different from every other one here.

It is **CPU-bound**, not I/O-bound. A thousand-bar replay runs the full
analyser a thousand times — roughly 1.4 seconds of solid computation. Awaiting
that on the event loop would stall every other request in the process, the
bot's own tick included, so the replay is handed to a worker thread and the
loop stays free.

And it is **expensive to ask for**, which is why its budget is the tightest in
the table: a handful of concurrent replays can saturate the machine in a way no
number of quote lookups can.
"""

from __future__ import annotations

import asyncio
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import get_market_service, settings_dep
from app.backtest.engine import BacktestConfig, Backtester
from app.backtest.portfolio import PortfolioBacktestConfig, PortfolioBacktester
from app.config import Settings
from app.core.errors import MarketDataError
from app.market_data.schemas import Candle
from app.market_data.timeframes import parse_timeframe
from app.risk.manager import RiskLimits
from app.services.market_service import MarketService
from app.signals.analyzer import MIN_BARS

router = APIRouter(prefix="/backtest", tags=["backtest"])

SymbolPath = Annotated[str, Path(min_length=3, max_length=32)]

# Below this there is no replay left after the analyser's warm-up, and above it
# a single request costs more CPU than the whole deployment should spend on one
# visitor's curiosity.
MIN_REQUESTABLE = MIN_BARS + 50
MAX_REQUESTABLE = 1000


def _run_portfolio(
    config: PortfolioBacktestConfig, candles: dict[str, list[Candle]]
) -> dict[str, Any]:
    """One portfolio replay, on this thread. Same reasoning as `_run` below."""
    return asyncio.run(PortfolioBacktester(config).run(candles)).to_dict()


def _run(config: BacktestConfig, candles: list[Candle]) -> dict[str, Any]:
    """Run one replay to completion on this thread.

    `Backtester.run` is a coroutine because it shares the live bot's broker
    interface, not because it waits on anything; a private loop is therefore
    the whole of what it needs.
    """
    return asyncio.run(Backtester(config).run(candles)).to_dict()


@router.get("/{symbol}")
async def backtest(
    symbol: SymbolPath,
    settings: Annotated[Settings, Depends(settings_dep)],
    market: Annotated[MarketService, Depends(get_market_service)],
    timeframe: Annotated[str, Query()] = "1h",
    bars: Annotated[int, Query(ge=MIN_REQUESTABLE, le=MAX_REQUESTABLE)] = 500,
    risk_pct: Annotated[Decimal | None, Query(gt=0, le=5)] = None,
) -> dict[str, Any]:
    tf = parse_timeframe(timeframe)
    sourced = await market.get_candles(symbol, tf, limit=bars)

    config = BacktestConfig(
        symbol=symbol.upper(),
        timeframe=tf.value,
        starting_balance=settings.initial_balance_usdt,
        risk_pct=risk_pct if risk_pct is not None else settings.risk_per_trade_pct,
    )
    payload = await asyncio.to_thread(_run, config, list(sourced.data))

    payload["meta"] = {
        "source": sourced.provenance.provider,
        "stale": sourced.provenance.stale,
        "bars_requested": bars,
        "bars_received": len(sourced.data),
    }
    return payload


@router.get("")
async def portfolio_backtest(
    settings: Annotated[Settings, Depends(settings_dep)],
    market: Annotated[MarketService, Depends(get_market_service)],
    timeframe: Annotated[str, Query()] = "1h",
    bars: Annotated[int, Query(ge=MIN_REQUESTABLE, le=MAX_REQUESTABLE)] = 500,
    risk_pct: Annotated[Decimal | None, Query(gt=0, le=5)] = None,
) -> dict[str, Any]:
    """Replay every tracked symbol together, on one account.

    The per-symbol route answers "would this have worked on BTC". This answers
    "what would it have done to the account" — a different and harder question,
    because capital is shared and every portfolio limit binds.

    Costs more than the single-symbol replay by the number of symbols, so it
    shares that route's tight budget and its worker thread.
    """
    tf = parse_timeframe(timeframe)
    symbols = settings.symbol_list

    fetched = await asyncio.gather(
        *(market.get_candles(s, tf, limit=bars) for s in symbols),
        return_exceptions=True,
    )

    candles: dict[str, list[Candle]] = {}
    failures: list[dict[str, str]] = []
    for symbol, result in zip(symbols, fetched, strict=True):
        if isinstance(result, MarketDataError):
            failures.append({"symbol": symbol, "code": result.code})
        elif isinstance(result, BaseException):
            failures.append({"symbol": symbol, "code": "internal_error"})
        else:
            candles[symbol] = list(result.data)

    config = PortfolioBacktestConfig(
        symbols=tuple(candles),
        timeframe=tf.value,
        starting_balance=settings.initial_balance_usdt,
        risk_pct=risk_pct if risk_pct is not None else settings.risk_per_trade_pct,
        limits=RiskLimits(
            risk_per_trade_pct=settings.risk_per_trade_pct,
            max_open_trades=settings.max_open_trades,
            max_daily_loss_pct=settings.max_daily_loss_pct,
            max_drawdown_pct=settings.max_drawdown_pct,
            max_portfolio_heat_pct=settings.max_portfolio_heat_pct,
        ),
    )
    payload = await asyncio.to_thread(_run_portfolio, config, candles)

    payload["meta"] = {
        "bars_requested": bars,
        # A symbol that could not be fetched is named, not dropped: a four-symbol
        # replay reported as a five-symbol one is a quietly different result.
        "symbols_replayed": sorted(candles),
        "failures": failures,
    }
    return payload
