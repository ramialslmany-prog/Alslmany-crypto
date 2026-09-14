"""The single door through which the platform obtains market data.

Nothing above this layer knows which exchange answered, or that there is more
than one. What every caller does get is provenance: which venue served the
value, whether it came from cache, and whether it is stale.

The failure mode is the point. When every provider fails, this raises
``NoMarketDataError`` rather than returning a placeholder — the platform is
built so that the absence of trustworthy data is a first-class, visible state,
because the alternative is an analysis engine reasoning about invented prices.
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.config import Settings
from app.core.errors import (
    MarketDataError,
    NoMarketDataError,
    StaleMarketDataError,
    UnsupportedSymbolError,
)
from app.core.logging import get_logger
from app.market_data.base import MarketDataProvider
from app.market_data.binance import BinanceProvider
from app.market_data.cache import TtlCache
from app.market_data.okx import OkxProvider
from app.market_data.schemas import Candle, OrderBook, Provenance, Sourced, Ticker
from app.market_data.single_flight import SingleFlight
from app.market_data.timeframes import Timeframe

logger = get_logger(__name__)

PROVIDER_FACTORIES = {
    "binance": BinanceProvider,
    "okx": OkxProvider,
}

BASE_URL_SETTING = {
    "binance": "binance_base_url",
    "okx": "okx_base_url",
}


def build_providers(settings: Settings) -> list[MarketDataProvider]:
    providers: list[MarketDataProvider] = []
    for name in settings.provider_list:
        factory = PROVIDER_FACTORIES.get(name)
        if factory is None:
            logger.warning("unknown market data provider configured", extra={"provider": name})
            continue
        providers.append(
            factory(
                base_url=getattr(settings, BASE_URL_SETTING[name]),
                timeout=settings.market_data_timeout_seconds,
                max_retries=settings.market_data_max_retries,
                backoff=settings.market_data_backoff_seconds,
            )
        )
    if not providers:
        raise ValueError("No usable market data providers are configured.")
    return providers


class MarketDataRouter:
    def __init__(
        self,
        providers: list[MarketDataProvider],
        settings: Settings,
    ) -> None:
        if not providers:
            raise ValueError("MarketDataRouter needs at least one provider.")
        self._providers = providers
        self._settings = settings
        self._symbols = set(settings.symbol_list)
        # Each entry carries the venue that produced it, so a cache hit can
        # report provenance as accurately as a live fetch.
        self._tickers: TtlCache[tuple[Ticker, str]] = TtlCache(settings.ticker_cache_seconds)
        self._candles: TtlCache[tuple[list[Candle], str]] = TtlCache(settings.candle_cache_seconds)
        self._books: TtlCache[tuple[OrderBook, str]] = TtlCache(settings.orderbook_cache_seconds)
        # Concurrent misses for the same key share one upstream call.
        self._flight: SingleFlight = SingleFlight()

    @property
    def provider_names(self) -> list[str]:
        return [p.name for p in self._providers]

    async def aclose(self) -> None:
        for provider in self._providers:
            await provider.aclose()

    def ensure_supported(self, symbol: str) -> str:
        normalised = symbol.strip().upper().replace("-", "").replace("/", "")
        if normalised not in self._symbols:
            raise UnsupportedSymbolError(
                f"{normalised} is not tracked by this deployment.",
                symbol=normalised,
                supported=sorted(self._symbols),
            )
        return normalised

    # --- public API ------------------------------------------------------

    async def get_ticker(self, symbol: str, *, allow_stale: bool = True) -> Sourced[Ticker]:
        symbol = self.ensure_supported(symbol)
        sourced = await self._fetch(
            cache=self._tickers,
            key=symbol,
            allow_stale=allow_stale,
            call=lambda p: p.get_ticker(symbol),
            what=f"ticker {symbol}",
        )
        # A quote can be cache-fresh and still describe a market that moved on,
        # if every provider has been failing for longer than the TTL.
        age = sourced.data.age_seconds
        if age > self._settings.max_quote_age_seconds:
            raise StaleMarketDataError(
                f"The newest quote for {symbol} is {age:.0f}s old.",
                symbol=symbol,
                age_seconds=round(age, 1),
                max_age_seconds=self._settings.max_quote_age_seconds,
            )
        return sourced

    async def get_candles(
        self,
        symbol: str,
        timeframe: Timeframe,
        limit: int = 200,
        *,
        allow_stale: bool = True,
    ) -> Sourced[list[Candle]]:
        symbol = self.ensure_supported(symbol)
        return await self._fetch(
            cache=self._candles,
            key=f"{symbol}:{timeframe.value}:{limit}",
            allow_stale=allow_stale,
            call=lambda p: p.get_candles(symbol, timeframe, limit),
            what=f"candles {symbol} {timeframe.value}",
        )

    async def get_order_book(
        self, symbol: str, depth: int = 20, *, allow_stale: bool = True
    ) -> Sourced[OrderBook]:
        symbol = self.ensure_supported(symbol)
        return await self._fetch(
            cache=self._books,
            key=f"{symbol}:{depth}",
            allow_stale=allow_stale,
            call=lambda p: p.get_order_book(symbol, depth),
            what=f"order book {symbol}",
        )

    # --- machinery -------------------------------------------------------

    async def _fetch(self, *, cache, key, allow_stale, call, what):
        fresh = cache.get(key)
        if fresh is not None:
            value, provider = fresh.value
            return Sourced(
                data=value,
                provenance=Provenance(
                    provider=provider,
                    fetched_at=datetime.now(UTC),
                    cached=True,
                ),
            )

        # Only one caller per key walks the providers; the rest await it.
        return await self._flight.do(
            f"{what}|{key}", lambda: self._fetch_uncached(cache, key, allow_stale, call, what)
        )

    async def _fetch_uncached(self, cache, key, allow_stale, call, what):
        tried: list[str] = []
        errors: dict[str, str] = {}

        for index, provider in enumerate(self._providers):
            tried.append(provider.name)
            try:
                value = await call(provider)
            except MarketDataError as exc:
                errors[provider.name] = exc.code
                logger.warning(
                    "market data provider failed",
                    extra={"provider": provider.name, "what": what, "code": exc.code},
                )
                continue

            cache.set(key, (value, provider.name))
            return Sourced(
                data=value,
                provenance=Provenance(
                    provider=provider.name,
                    fetched_at=datetime.now(UTC),
                    cached=False,
                    fallback_used=index > 0,
                    providers_tried=tuple(tried),
                ),
            )

        # Every provider failed. A knowingly stale value, clearly labelled, is
        # the last acceptable answer; an invented one never is.
        if allow_stale:
            stale = cache.get(key, allow_stale=True)
            if stale is not None:
                value, provider_name = stale.value
                logger.warning(
                    "serving stale market data",
                    extra={"what": what, "age_seconds": round(stale.age_seconds, 1)},
                )
                return Sourced(
                    data=value,
                    provenance=Provenance(
                        provider=provider_name,
                        fetched_at=datetime.now(UTC),
                        cached=True,
                        stale=True,
                        providers_tried=tuple(tried),
                    ),
                )

        logger.error(
            "no reliable market data", extra={"what": what, "tried": tried, "errors": errors}
        )
        raise NoMarketDataError(
            f"Insufficient reliable market data for {what}.",
            providers_tried=tried,
            provider_errors=errors,
        )
