"""Performance analytics endpoints.

These read the ledger and nothing else. They are served from our own database,
touch no exchange, and — importantly — write nothing. No route here can change
a limit, a weight or a parameter, which is the property that keeps the
observations advisory.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.analytics import benchmark
from app.analytics.breakdown import KEYS, MIN_SAMPLE, breakdown
from app.analytics.insights import APPLIED, REQUIRES, observe
from app.api.deps import get_market_service, settings_dep
from app.config import Settings
from app.core.errors import MarketDataError, ValidationError
from app.database.session import get_session
from app.market_data.timeframes import Timeframe
from app.paper.store import TradeRepository
from app.services.market_service import MarketService

router = APIRouter(prefix="/analytics", tags=["analytics"])

# The ledger is not expected to grow beyond this in paper trading, and a cap
# keeps one request from loading an unbounded table into memory.
MAX_TRADES = 5000


@router.get("/breakdown")
async def performance_breakdown(
    settings: Annotated[Settings, Depends(settings_dep)],
    session: Annotated[AsyncSession, Depends(get_session)],
    by: Annotated[str, Query()] = "symbol",
) -> dict[str, Any]:
    if by not in KEYS:
        # The app's own error type, so this reads like every other 4xx here:
        # a coded `error` object rather than FastAPI's bare `detail` string.
        raise ValidationError(
            f"Unknown breakdown dimension '{by}'.",
            expected=sorted(KEYS),
        )

    trades = await TradeRepository(session).closed_trades(limit=MAX_TRADES)
    groups = breakdown(trades, by, settings.initial_balance_usdt)

    return {
        "by": by,
        "dimensions": sorted(KEYS),
        "min_sample": MIN_SAMPLE,
        "total_closed": len(trades),
        "data": [g.to_dict() for g in groups],
    }


@router.get("/insights")
async def insights(
    settings: Annotated[Settings, Depends(settings_dep)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, Any]:
    trades = await TradeRepository(session).closed_trades(limit=MAX_TRADES)
    found = observe(trades, settings.initial_balance_usdt)
    return {
        "applied": APPLIED,
        "requires": REQUIRES,
        "total_closed": len(trades),
        "data": [o.to_dict() for o in found],
    }


# Daily candles, one request per symbol. 1000 days is the most the venues serve
# in a single call and covers any paper-trading window this deployment will
# produce; a window older than that is reported as uncovered rather than
# silently truncated.
BENCHMARK_BARS = 1000


@router.get("/benchmark")
async def benchmark_vs_holding(
    settings: Annotated[Settings, Depends(settings_dep)],
    session: Annotated[AsyncSession, Depends(get_session)],
    market: Annotated[MarketService, Depends(get_market_service)],
) -> dict[str, Any]:
    """What holding each traded symbol would have returned over the same window.

    Unlike the other two routes here this one reaches upstream, once per symbol
    the bot has actually traded — so it is budgeted with the fan-out routes
    rather than the local ones.
    """
    trades = await TradeRepository(session).closed_trades(limit=MAX_TRADES)
    spans = benchmark.windows(trades)

    async def candles_for(symbol: str) -> tuple[str, list]:
        # `persist=False`: these daily bars feed one number and have no other
        # consumer, so archiving five thousand rows on every benchmark call
        # would be write amplification for nothing — and would contradict this
        # module's claim to write nothing at all.
        sourced = await market.get_candles(
            symbol, Timeframe.D1, limit=BENCHMARK_BARS, persist=False
        )
        return symbol, list(sourced.data)

    fetched = await asyncio.gather(*(candles_for(s) for s in spans), return_exceptions=True)

    by_symbol: dict[str, list] = {}
    failures: list[dict[str, str]] = []
    for symbol, result in zip(spans, fetched, strict=True):
        if isinstance(result, MarketDataError):
            failures.append({"symbol": symbol, "code": result.code})
        elif isinstance(result, BaseException):
            failures.append({"symbol": symbol, "code": "internal_error"})
        else:
            by_symbol[result[0]] = result[1]

    rows = benchmark.build(trades, by_symbol, settings.initial_balance_usdt)
    return {
        "denominator_note": benchmark.DENOMINATOR_NOTE,
        "generated_at": datetime.now(UTC).isoformat(),
        "data": [r.to_dict() for r in rows],
        "failures": failures,
    }
