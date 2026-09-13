"""Market data endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_market_service, settings_dep
from app.api.schemas import (
    CandleOut,
    CoinOut,
    Envelope,
    Meta,
    OrderBookOut,
    TickerOut,
)
from app.config import Settings
from app.database.repositories import CoinRepository
from app.database.session import get_session
from app.market_data.timeframes import Timeframe, parse_timeframe
from app.services.market_service import MarketService

router = APIRouter(prefix="/market", tags=["market"])

SymbolPath = Annotated[str, Path(min_length=3, max_length=32, description="e.g. BTCUSDT")]


@router.get("/symbols", response_model=list[CoinOut])
async def list_symbols(
    session: Annotated[AsyncSession, Depends(get_session)],
) -> list[CoinOut]:
    coins = await CoinRepository(session).list_active()
    return [CoinOut.model_validate(c) for c in coins]


@router.get("/timeframes")
async def list_timeframes() -> dict[str, object]:
    return {"timeframes": [{"value": tf.value, "seconds": tf.seconds} for tf in Timeframe]}


@router.get("/overview")
async def overview(
    settings: Annotated[Settings, Depends(settings_dep)],
    market: Annotated[MarketService, Depends(get_market_service)],
) -> dict[str, object]:
    """Every tracked symbol at once, for the market screen.

    Partial success is a real outcome and is represented as one: symbols that
    could be quoted appear under ``data``, and those that could not appear
    under ``failures`` with the reason. Nothing is filled in on their behalf.
    """
    result = await market.snapshot_all(settings.symbol_list)
    quotes = result["quotes"]
    failures = result["failures"]

    stale = sum(1 for s in quotes.values() if s.provenance.stale)

    return {
        "data": [
            {
                "symbol": symbol,
                "ticker": TickerOut.of(sourced.data),
                "meta": Meta.of(sourced.provenance),
            }
            for symbol, sourced in quotes.items()
        ],
        "failures": [{"symbol": symbol, "code": code} for symbol, code in failures.items()],
        "summary": {
            "tracked": len(settings.symbol_list),
            "quoted": len(quotes),
            "failed": len(failures),
            "stale": stale,
            # A served-from-stale-cache quote is NOT a healthy feed. Counting
            # only outright failures here would let the UI report "live" while
            # every price on screen came from a dead provider's last answer —
            # the precise misrepresentation this platform must never make.
            "feed_healthy": len(failures) == 0 and stale == 0,
        },
    }


@router.get("/{symbol}/ticker", response_model=Envelope[TickerOut])
async def ticker(
    symbol: SymbolPath,
    market: Annotated[MarketService, Depends(get_market_service)],
) -> Envelope[TickerOut]:
    sourced = await market.get_ticker(symbol)
    return Envelope(data=TickerOut.of(sourced.data), meta=Meta.of(sourced.provenance))


@router.get("/{symbol}/candles", response_model=Envelope[list[CandleOut]])
async def candles(
    symbol: SymbolPath,
    market: Annotated[MarketService, Depends(get_market_service)],
    timeframe: Annotated[str, Query(description="1m, 5m, 15m, 1h, 4h or 1d")] = "1h",
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
) -> Envelope[list[CandleOut]]:
    tf = parse_timeframe(timeframe)
    sourced = await market.get_candles(symbol, tf, limit)
    return Envelope(
        data=[CandleOut.of(c) for c in sourced.data],
        meta=Meta.of(sourced.provenance),
    )


@router.get("/{symbol}/orderbook", response_model=Envelope[OrderBookOut])
async def order_book(
    symbol: SymbolPath,
    market: Annotated[MarketService, Depends(get_market_service)],
    depth: Annotated[int, Query(ge=1, le=200)] = 20,
) -> Envelope[OrderBookOut]:
    sourced = await market.get_order_book(symbol, depth)
    return Envelope(data=OrderBookOut.of(sourced.data), meta=Meta.of(sourced.provenance))
