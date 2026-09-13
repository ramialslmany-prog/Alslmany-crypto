"""Adapter tests: every number that leaves a provider is parsed, not guessed."""

from __future__ import annotations

from decimal import Decimal

import httpx
import pytest

from app.core.errors import (
    MalformedUpstreamResponse,
    ProviderRateLimitedError,
    ProviderUnavailableError,
)
from app.market_data.binance import BinanceProvider
from app.market_data.okx import OkxProvider
from app.market_data.timeframes import Timeframe
from tests.conftest import json_route
from tests.fixtures import (
    BINANCE_DEPTH,
    BINANCE_KLINES,
    BINANCE_TICKER_24HR,
    OKX_BOOKS,
    OKX_CANDLES,
    OKX_ERROR,
    OKX_TICKER,
)

BINANCE_ROUTES = {
    "/api/v3/ticker/24hr": BINANCE_TICKER_24HR,
    "/api/v3/klines": BINANCE_KLINES,
    "/api/v3/depth": BINANCE_DEPTH,
}
OKX_ROUTES = {
    "/api/v5/market/ticker": OKX_TICKER,
    "/api/v5/market/candles": OKX_CANDLES,
    "/api/v5/market/books": OKX_BOOKS,
}


def binance(**kw) -> BinanceProvider:
    return BinanceProvider(transport=json_route(BINANCE_ROUTES), backoff=0.0, **kw)


def okx(**kw) -> OkxProvider:
    return OkxProvider(transport=json_route(OKX_ROUTES), backoff=0.0, **kw)


# --- binance --------------------------------------------------------------


async def test_binance_ticker_parses_exactly():
    p = binance()
    t = await p.get_ticker("BTCUSDT")
    assert t.symbol == "BTCUSDT"
    # Exact Decimal, not a float approximation.
    assert t.price == Decimal("108150.25")
    assert t.change_24h_pct == Decimal("1.170")
    assert t.high_24h == Decimal("108900.00")
    assert t.low_24h == Decimal("106500.00")
    assert t.timestamp.tzinfo is not None
    await p.aclose()


async def test_binance_candles_are_oldest_first_and_flag_the_forming_bar():
    p = binance()
    candles = await p.get_candles("BTCUSDT", Timeframe.H1, limit=2)
    assert len(candles) == 2
    assert candles[0].open_time < candles[1].open_time
    assert candles[0].open == Decimal("107900.00")
    assert candles[1].close == Decimal("108150.25")
    # Both fixture bars closed long ago, so both must read as closed.
    assert all(c.closed for c in candles)
    await p.aclose()


async def test_binance_depth_drops_zero_quantity_levels():
    p = binance()
    book = await p.get_order_book("BTCUSDT", depth=5)
    # The fixture carries a 0.00000-quantity bid, which is a delete marker.
    assert len(book.bids) == 2
    assert book.best_bid == Decimal("108150.20")
    assert book.best_ask == Decimal("108150.30")
    assert book.spread_pct is not None and book.spread_pct > 0
    await p.aclose()


async def test_binance_rejects_a_kline_row_of_the_wrong_shape():
    transport = json_route({"/api/v3/klines": [[1, "2", "3"]]})
    p = BinanceProvider(transport=transport, backoff=0.0)
    with pytest.raises(MalformedUpstreamResponse):
        await p.get_candles("BTCUSDT", Timeframe.H1)
    await p.aclose()


async def test_binance_rejects_a_non_json_200():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>maintenance</html>")

    p = BinanceProvider(transport=httpx.MockTransport(handler), backoff=0.0)
    with pytest.raises(MalformedUpstreamResponse):
        await p.get_ticker("BTCUSDT")
    await p.aclose()


# --- okx ------------------------------------------------------------------


async def test_okx_ticker_derives_change_from_the_24h_open():
    p = okx()
    t = await p.get_ticker("BTCUSDT")
    assert t.symbol == "BTCUSDT"  # normalised back from BTC-USDT
    assert t.price == Decimal("108160.5")
    # (108160.5 - 106900) / 106900 * 100 == 1.1791...
    assert t.change_24h_pct is not None
    assert Decimal("1.17") < t.change_24h_pct < Decimal("1.19")
    await p.aclose()


async def test_okx_candles_are_reordered_oldest_first():
    p = okx()
    candles = await p.get_candles("BTCUSDT", Timeframe.H1, limit=3)
    assert len(candles) == 3
    times = [c.open_time for c in candles]
    assert times == sorted(times), "OKX returns newest-first; the adapter must reverse it"
    # The newest fixture bar has confirm="0" and must be flagged as forming.
    assert candles[-1].closed is False
    assert candles[0].closed is True
    await p.aclose()


async def test_okx_business_error_on_http_200_is_not_treated_as_success():
    p = OkxProvider(transport=json_route({"/api/v5/market/ticker": OKX_ERROR}), backoff=0.0)
    with pytest.raises(MalformedUpstreamResponse) as exc:
        await p.get_ticker("BTCUSDT")
    assert exc.value.details["upstream_code"] == "51001"
    await p.aclose()


async def test_okx_order_book_parses_four_element_levels():
    p = okx()
    book = await p.get_order_book("BTCUSDT", depth=5)
    assert book.best_bid == Decimal("108160.4")
    assert book.best_ask == Decimal("108160.6")
    await p.aclose()


# --- transport behaviour ---------------------------------------------------


async def test_rate_limit_is_surfaced_as_its_own_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"msg": "too many requests"})

    p = BinanceProvider(transport=httpx.MockTransport(handler), max_retries=2, backoff=0.0)
    with pytest.raises(ProviderRateLimitedError):
        await p.get_ticker("BTCUSDT")
    await p.aclose()


async def test_a_500_is_retried_and_then_succeeds():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(500, json={"msg": "boom"})
        return httpx.Response(200, json=BINANCE_TICKER_24HR)

    p = BinanceProvider(transport=httpx.MockTransport(handler), max_retries=3, backoff=0.0)
    t = await p.get_ticker("BTCUSDT")
    assert t.price == Decimal("108150.25")
    assert calls["n"] == 2, "the first attempt should have been retried exactly once"
    await p.aclose()


async def test_a_400_is_not_retried():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, json={"code": -1121, "msg": "Invalid symbol."})

    p = BinanceProvider(transport=httpx.MockTransport(handler), max_retries=3, backoff=0.0)
    with pytest.raises(ProviderUnavailableError):
        await p.get_ticker("BTCUSDT")
    assert calls["n"] == 1, "a client error must fail immediately, not burn retries"
    await p.aclose()


async def test_connect_failure_is_retried_then_raised():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        raise httpx.ConnectError("network unreachable")

    p = BinanceProvider(transport=httpx.MockTransport(handler), max_retries=3, backoff=0.0)
    with pytest.raises(ProviderUnavailableError):
        await p.get_ticker("BTCUSDT")
    assert calls["n"] == 3
    await p.aclose()
