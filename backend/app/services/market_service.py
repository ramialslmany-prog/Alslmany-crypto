"""Market data as the rest of the application consumes it.

Fetching and storing are one operation here on purpose. Every bar the platform
acts on should also be the bar it can be audited against later, and splitting
the two invites a future caller to analyse data that was never recorded.

Persistence failures are logged, never raised: being unable to *save* a quote
is not a reason to refuse to *serve* it. The reverse — serving something we
could not obtain — is what this layer must never do.
"""

from __future__ import annotations

import asyncio

from app.core.errors import MarketDataError
from app.core.logging import get_logger
from app.database.models.market_data import TickerSnapshot
from app.database.repositories import CandleRepository
from app.database.session import session_scope
from app.market_data.router import MarketDataRouter
from app.market_data.schemas import Candle, OrderBook, Sourced, Ticker
from app.market_data.timeframes import Timeframe
from app.services import event_log

logger = get_logger(__name__)


class MarketService:
    def __init__(self, router: MarketDataRouter) -> None:
        self._router = router
        # Which symbols are currently in an outage or stale, so transitions are
        # recorded rather than every individual failure.
        self._degraded: set[str] = set()
        self._stale: set[str] = set()

    @property
    def router(self) -> MarketDataRouter:
        return self._router

    async def get_ticker(
        self, symbol: str, *, persist: bool = True, allow_stale: bool = True
    ) -> Sourced[Ticker]:
        try:
            sourced = await self._router.get_ticker(symbol, allow_stale=allow_stale)
        except MarketDataError as exc:
            await self._record_outage(symbol, exc)
            raise

        await self._note_recovery(symbol, sourced)

        if persist and not sourced.provenance.cached:
            await self._persist_ticker(sourced)
        return sourced

    # --- durable event trail --------------------------------------------

    async def _record_outage(self, symbol: str, exc: MarketDataError) -> None:
        """Write the outage down once, not on every retry.

        A client polling a dead feed every few seconds would otherwise fill the
        table with thousands of identical rows and bury the moment that matters
        — the transition into the outage.
        """
        if symbol in self._degraded:
            return
        self._degraded.add(symbol)
        await event_log.record(
            "error",
            event_log.MARKET_DATA_OUTAGE,
            f"No reliable market data for {symbol}.",
            symbol=symbol,
            code=exc.code,
            **{k: v for k, v in exc.details.items() if k != "symbol"},
        )

    async def _note_recovery(self, symbol: str, sourced: Sourced[Ticker]) -> None:
        if sourced.provenance.stale:
            if symbol not in self._stale:
                self._stale.add(symbol)
                await event_log.record(
                    "warning",
                    event_log.MARKET_DATA_STALE,
                    f"Serving stale quotes for {symbol}; providers are not answering.",
                    symbol=symbol,
                    provider=sourced.provenance.provider,
                )
            return

        self._stale.discard(symbol)
        if symbol in self._degraded:
            self._degraded.discard(symbol)
            await event_log.record(
                "info",
                event_log.MARKET_DATA_RECOVERED,
                f"Market data for {symbol} recovered.",
                symbol=symbol,
                provider=sourced.provenance.provider,
            )

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

        Fetched concurrently. Serially, the market screen waited for the sum of
        every symbol's latency — five symbols at 200ms each took a full second
        to render a view the user expects to feel instant, and the cost grows
        linearly with every coin added.

        `return_exceptions=True` keeps the isolation that mattered in the serial
        version: one dead symbol must not blank the whole screen, so each result
        is judged on its own and the response says which ones failed.
        """
        results = await asyncio.gather(
            *(self.get_ticker(symbol) for symbol in symbols),
            return_exceptions=True,
        )

        quotes: dict[str, Sourced[Ticker]] = {}
        failures: dict[str, str] = {}

        for symbol, result in zip(symbols, results, strict=True):
            if isinstance(result, MarketDataError):
                failures[symbol] = result.code
                logger.warning("symbol quote failed", extra={"symbol": symbol, "code": result.code})
            elif isinstance(result, BaseException):
                # An unexpected exception is not a market-data outage. Recording
                # it under the same code would hide a real bug behind a
                # plausible-looking "provider down".
                failures[symbol] = "internal_error"
                logger.exception(
                    "unexpected error quoting symbol",
                    extra={"symbol": symbol, "error": type(result).__name__},
                    exc_info=result,
                )
            else:
                quotes[symbol] = result

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
