"""Market data as the rest of the application consumes it.

Fetching and storing are one operation here on purpose. Every bar the platform
acts on should also be the bar it can be audited against later, and splitting
the two invites a future caller to analyse data that was never recorded.

Persistence failures are logged, never raised: being unable to *save* a quote
is not a reason to refuse to *serve* it. The reverse — serving something we
could not obtain — is what this layer must never do.
"""

from __future__ import annotations

from app.core.errors import MarketDataError
from app.core.logging import get_logger
from app.database.models.market_data import TickerSnapshot
from app.database.repositories import CandleRepository
from app.database.session import session_scope
from app.market_data.router import MarketDataRouter
from app.market_data.schemas import Candle, OrderBook, Sourced, Ticker
from app.market_data.timeframes import Timeframe

logger = get_logger(__name__)


class MarketService:
    def __init__(self, router: MarketDataRouter) -> None:
        self._router = router

    @property
    def router(self) -> MarketDataRouter:
        return self._router

    async def get_ticker(
        self, symbol: str, *, persist: bool = True, allow_stale: bool = True
    ) -> Sourced[Ticker]:
        sourced = await self._router.get_ticker(symbol, allow_stale=allow_stale)
        if persist and not sourced.provenance.cached:
            await self._persist_ticker(sourced)
        return sourced

    async def get_candles(
        self,
        symbol: str,
        timeframe: Timeframe,
        limit: int = 200,
        *,
        persist: bool = True,
    ) -> Sourced[list[Candle]]:
        sourced = await self._router.get_candles(symbol, timeframe, limit)
        if persist and not sourced.provenance.cached:
            await self._persist_candles(sourced)
        return sourced

    async def get_order_book(self, symbol: str, depth: int = 20) -> Sourced[OrderBook]:
        # Order books are not persisted: a depth snapshot is stale within
        # seconds and storing every one would be a large table nobody reads.
        return await self._router.get_order_book(symbol, depth)

    async def snapshot_all(self, symbols: list[str]) -> dict[str, object]:
        """Quote every tracked symbol, reporting failures rather than hiding them.

        One dead symbol must not blank the whole market screen, so each is
        collected independently and the response says which ones failed.
        """
        quotes: dict[str, Sourced[Ticker]] = {}
        failures: dict[str, str] = {}

        for symbol in symbols:
            try:
                quotes[symbol] = await self.get_ticker(symbol)
            except MarketDataError as exc:
                failures[symbol] = exc.code
                logger.warning("symbol quote failed", extra={"symbol": symbol, "code": exc.code})

        return {"quotes": quotes, "failures": failures}

    # --- persistence -----------------------------------------------------

    async def _persist_candles(self, sourced: Sourced[list[Candle]]) -> None:
        if not sourced.data:
            return
        try:
            async with session_scope() as session:
                await CandleRepository(session).upsert_many(
                    sourced.data, source=sourced.provenance.provider
                )
        except Exception:
            logger.exception(
                "could not persist candles",
                extra={"symbol": sourced.data[0].symbol, "count": len(sourced.data)},
            )

    async def _persist_ticker(self, sourced: Sourced[Ticker]) -> None:
        t = sourced.data
        try:
            async with session_scope() as session:
                session.add(
                    TickerSnapshot(
                        symbol=t.symbol,
                        price=t.price,
                        change_24h_pct=t.change_24h_pct,
                        high_24h=t.high_24h,
                        low_24h=t.low_24h,
                        volume_24h=t.volume_24h,
                        quote_volume_24h=t.quote_volume_24h,
                        observed_at=t.timestamp,
                        source=sourced.provenance.provider,
                    )
                )
        except Exception:
            logger.exception("could not persist ticker", extra={"symbol": t.symbol})
