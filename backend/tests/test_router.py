"""Failover, caching, and the refusal to invent a price."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from app.core.errors import (
    NoMarketDataError,
    ProviderUnavailableError,
    StaleMarketDataError,
    UnsupportedSymbolError,
)
from app.market_data.router import MarketDataRouter
from app.market_data.schemas import Candle, OrderBook, OrderBookLevel, Ticker
from app.market_data.timeframes import Timeframe


class FakeProvider:
    """A provider whose behaviour each test dictates outright."""

    def __init__(self, name: str, *, price: str = "100", fail: bool = False) -> None:
        self.name = name
        self.price = Decimal(price)
        self.fail = fail
        self.calls = 0
        self.timestamp = datetime.now(UTC)

    async def get_ticker(self, symbol: str) -> Ticker:
        self.calls += 1
        if self.fail:
            raise ProviderUnavailableError(f"{self.name} is down", provider=self.name)
        return Ticker(symbol=symbol, price=self.price, timestamp=self.timestamp)

    async def get_candles(self, symbol, timeframe, limit=200) -> list[Candle]:
        self.calls += 1
        if self.fail:
            raise ProviderUnavailableError(f"{self.name} is down", provider=self.name)
        return [
            Candle(
                symbol=symbol,
                timeframe=timeframe,
                open_time=datetime.now(UTC) - timedelta(hours=1),
                open=self.price,
                high=self.price,
                low=self.price,
                close=self.price,
                volume=Decimal("1"),
            )
        ]

    async def get_order_book(self, symbol, depth=20) -> OrderBook:
        self.calls += 1
        if self.fail:
            raise ProviderUnavailableError(f"{self.name} is down", provider=self.name)
        return OrderBook(
            symbol=symbol,
            bids=(OrderBookLevel(price=self.price, quantity=Decimal("1")),),
            asks=(OrderBookLevel(price=self.price + 1, quantity=Decimal("1")),),
            timestamp=datetime.now(UTC),
        )

    async def aclose(self) -> None:
        return None


async def test_primary_is_used_and_the_fallback_is_left_alone(settings):
    primary = FakeProvider("binance", price="108000")
    backup = FakeProvider("okx", price="108001")
    router = MarketDataRouter([primary, backup], settings)

    result = await router.get_ticker("BTCUSDT")

    assert result.data.price == Decimal("108000")
    assert result.provenance.provider == "binance"
    assert result.provenance.fallback_used is False
    assert backup.calls == 0, "the backup must not be called when the primary answers"


async def test_failover_to_the_second_provider_is_recorded_in_provenance(settings):
    primary = FakeProvider("binance", fail=True)
    backup = FakeProvider("okx", price="108001")
    router = MarketDataRouter([primary, backup], settings)

    result = await router.get_ticker("BTCUSDT")

    assert result.data.price == Decimal("108001")
    assert result.provenance.provider == "okx"
    assert result.provenance.fallback_used is True
    assert result.provenance.providers_tried == ("binance", "okx")


async def test_when_every_provider_fails_it_refuses_rather_than_inventing(settings):
    router = MarketDataRouter(
        [FakeProvider("binance", fail=True), FakeProvider("okx", fail=True)], settings
    )
    with pytest.raises(NoMarketDataError) as exc:
        await router.get_ticker("BTCUSDT")

    assert exc.value.code == "no_reliable_market_data"
    assert exc.value.http_status == 503
    assert "Insufficient reliable market data" in exc.value.message
    assert exc.value.details["providers_tried"] == ["binance", "okx"]


async def test_a_cached_value_does_not_hit_the_provider_again(settings):
    provider = FakeProvider("binance", price="108000")
    router = MarketDataRouter([provider], settings)

    first = await router.get_ticker("BTCUSDT")
    second = await router.get_ticker("BTCUSDT")

    assert provider.calls == 1
    assert first.provenance.cached is False
    assert second.provenance.cached is True


def age_entry(cache, key: str, seconds: float) -> None:
    """Backdate a cache entry so it is genuinely expired.

    Zeroing the TTL would not do this: a zero TTL means caching is disabled,
    which is a different state entirely.
    """
    stored_at, value = cache._entries[key]
    cache._entries[key] = (stored_at - seconds, value)


async def test_stale_cache_is_served_labelled_when_providers_die(settings):
    provider = FakeProvider("binance", price="108000")
    router = MarketDataRouter([provider], settings)

    await router.get_ticker("BTCUSDT")  # populate
    age_entry(router._tickers, "BTCUSDT", seconds=60)  # genuinely expired
    provider.fail = True  # and the venue is down

    result = await router.get_ticker("BTCUSDT", allow_stale=True)

    assert result.data.price == Decimal("108000")
    assert result.provenance.stale is True, "a stale value must say so"
    assert result.provenance.cached is True


async def test_stale_is_refused_when_the_caller_will_not_accept_it(settings):
    provider = FakeProvider("binance", price="108000")
    router = MarketDataRouter([provider], settings)

    await router.get_ticker("BTCUSDT")
    age_entry(router._tickers, "BTCUSDT", seconds=60)
    provider.fail = True

    with pytest.raises(NoMarketDataError):
        await router.get_ticker("BTCUSDT", allow_stale=False)


async def test_a_quote_older_than_the_limit_is_rejected_even_if_fresh_in_cache(settings):
    provider = FakeProvider("binance", price="108000")
    # The venue answers, but with a quote stamped well in the past.
    provider.timestamp = datetime.now(UTC) - timedelta(seconds=600)
    router = MarketDataRouter([provider], settings)

    with pytest.raises(StaleMarketDataError) as exc:
        await router.get_ticker("BTCUSDT")
    assert exc.value.details["age_seconds"] > settings.max_quote_age_seconds


async def test_an_untracked_symbol_is_rejected_before_any_network_call(settings):
    provider = FakeProvider("binance")
    router = MarketDataRouter([provider], settings)

    with pytest.raises(UnsupportedSymbolError):
        await router.get_ticker("DOGEUSDT")
    assert provider.calls == 0


async def test_candles_and_books_failover_too(settings):
    router = MarketDataRouter(
        [FakeProvider("binance", fail=True), FakeProvider("okx", price="42")], settings
    )
    candles = await router.get_candles("ETHUSDT", Timeframe.H1, limit=1)
    book = await router.get_order_book("ETHUSDT", depth=5)

    assert candles.provenance.provider == "okx"
    assert candles.data[0].close == Decimal("42")
    assert book.provenance.provider == "okx"


async def test_a_zero_ttl_disables_caching_rather_than_serving_stale(settings):
    """The footgun this guards: TTL 0 must mean OFF, not "instantly stale".

    Treating it as instant expiry would make disabling the cache serve OLDER
    data than leaving it enabled, because every entry becomes eligible for the
    stale tier the moment it is written.
    """
    from app.market_data.cache import TtlCache

    cache: TtlCache[str] = TtlCache(0.0)
    cache.set("k", "v")

    assert cache.enabled is False
    assert cache.get("k") is None
    assert cache.get("k", allow_stale=True) is None
    assert len(cache) == 0, "a disabled cache must not retain anything"


async def test_a_disabled_cache_means_every_call_reaches_the_provider(settings):
    no_cache = settings.model_copy(update={"ticker_cache_seconds": 0.0})
    provider = FakeProvider("binance", price="108000")
    router = MarketDataRouter([provider], no_cache)

    await router.get_ticker("BTCUSDT")
    await router.get_ticker("BTCUSDT")

    assert provider.calls == 2


async def test_beyond_the_stale_window_nothing_is_served(settings):
    provider = FakeProvider("binance", price="108000")
    router = MarketDataRouter([provider], settings)

    await router.get_ticker("BTCUSDT")
    age_entry(router._tickers, "BTCUSDT", seconds=10_000)  # far past max_stale
    provider.fail = True

    with pytest.raises(NoMarketDataError):
        await router.get_ticker("BTCUSDT", allow_stale=True)


async def test_a_cache_hit_reports_the_venue_that_actually_served_it(settings):
    """Provenance must survive the cache.

    The primary fails, OKX answers, and the value is cached. The next call is a
    cache hit and must still say OKX — naming the primary would be a false
    audit trail on a number the platform may later act on.
    """
    primary = FakeProvider("binance", fail=True)
    backup = FakeProvider("okx", price="108001")
    router = MarketDataRouter([primary, backup], settings)

    first = await router.get_ticker("BTCUSDT")
    second = await router.get_ticker("BTCUSDT")

    assert first.provenance.provider == "okx"
    assert second.provenance.cached is True
    assert second.provenance.provider == "okx", "a cache hit must not misattribute the venue"


async def test_stale_service_also_names_the_right_venue(settings):
    primary = FakeProvider("binance", fail=True)
    backup = FakeProvider("okx", price="108001")
    router = MarketDataRouter([primary, backup], settings)

    await router.get_ticker("BTCUSDT")
    age_entry(router._tickers, "BTCUSDT", seconds=60)
    backup.fail = True

    result = await router.get_ticker("BTCUSDT", allow_stale=True)
    assert result.provenance.stale is True
    assert result.provenance.provider == "okx"
