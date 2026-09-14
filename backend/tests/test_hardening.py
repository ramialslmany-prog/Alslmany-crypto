"""Regression tests for the defects the Stage 1 audit found.

Each of these passed review and passed the original suite. They were found by
measuring behaviour rather than re-reading code, so each one is pinned here.
"""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime
from decimal import Decimal

from app.core.errors import ProviderUnavailableError
from app.core.rate_limit import BUDGETS, RateLimiter, classify
from app.market_data.binance import DEPTH_TIERS, depth_tier
from app.market_data.router import MarketDataRouter
from app.market_data.schemas import Ticker
from app.market_data.single_flight import SingleFlight
from app.services.market_service import MarketService


class CountingProvider:
    name = "counting"

    def __init__(self, *, delay: float = 0.05, fail_for: set[str] | None = None) -> None:
        self.calls = 0
        self.delay = delay
        self.fail_for = fail_for or set()

    async def get_ticker(self, symbol: str) -> Ticker:
        self.calls += 1
        await asyncio.sleep(self.delay)
        if symbol in self.fail_for:
            raise ProviderUnavailableError("down", provider=self.name)
        return Ticker(symbol=symbol, price=Decimal("1"), timestamp=datetime.now(UTC))

    async def get_candles(self, *a, **k):  # pragma: no cover - unused here
        raise NotImplementedError

    async def get_order_book(self, *a, **k):  # pragma: no cover - unused here
        raise NotImplementedError

    async def aclose(self) -> None:
        return None


# --- A. Binance rejects any depth outside its tier list --------------------


def test_every_requestable_depth_maps_to_a_value_binance_accepts():
    """/depth accepts only {5,10,20,50,100,500,1000,5000}; anything else is 400.

    Passing the caller's number through meant a request like depth=25 failed
    against the primary venue every time, silently pushing all order-book
    traffic to the fallback — or to a 503 when the fallback was also down.
    """
    for requested in range(1, 5001):
        assert depth_tier(requested) in DEPTH_TIERS


def test_depth_rounds_up_so_the_book_is_never_truncated():
    """Rounding down would quietly return fewer levels than asked for, and a
    liquidity calculation reading that would understate available depth."""
    for requested in range(1, 5001):
        assert depth_tier(requested) >= requested
    assert depth_tier(25) == 50
    assert depth_tier(20) == 20
    assert depth_tier(1) == 5
    assert depth_tier(10_000) == 5000


# --- B. Concurrent misses must not stampede the exchange -------------------


async def test_twenty_concurrent_misses_make_one_upstream_call(settings):
    provider = CountingProvider(delay=0.05)
    router = MarketDataRouter([provider], settings)

    results = await asyncio.gather(*[router.get_ticker("BTCUSDT") for _ in range(20)])

    assert provider.calls == 1, "a cache miss must not become a stampede"
    assert len(results) == 20
    assert len({str(r.data.price) for r in results}) == 1


async def test_single_flight_shares_the_failure_too(settings):
    """Followers must not silently succeed when the shared call failed."""
    flight: SingleFlight = SingleFlight()
    calls = {"n": 0}

    async def boom():
        calls["n"] += 1
        await asyncio.sleep(0.02)
        raise ProviderUnavailableError("down", provider="x")

    results = await asyncio.gather(
        *[flight.do("k", boom) for _ in range(5)], return_exceptions=True
    )

    assert calls["n"] == 1
    assert all(isinstance(r, ProviderUnavailableError) for r in results)


async def test_single_flight_releases_the_key_for_later_callers(settings):
    flight: SingleFlight = SingleFlight()
    calls = {"n": 0}

    async def work():
        calls["n"] += 1
        return calls["n"]

    await flight.do("k", work)
    await flight.do("k", work)

    assert calls["n"] == 2, "the key must not stay latched after completion"
    assert flight.in_flight == 0


async def test_different_keys_do_not_block_each_other(settings):
    provider = CountingProvider(delay=0.05)
    router = MarketDataRouter([provider], settings)

    await asyncio.gather(
        router.get_ticker("BTCUSDT"),
        router.get_ticker("ETHUSDT"),
    )

    assert provider.calls == 2


# --- C. The overview must fan out, not queue -------------------------------


async def test_overview_fetches_symbols_concurrently(settings):
    """Serially this took the SUM of every symbol's latency, and the cost grew
    linearly with each coin added."""
    symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]
    no_cache = settings.model_copy(update={"ticker_cache_seconds": 0.0})
    provider = CountingProvider(delay=0.1)
    service = MarketService(MarketDataRouter([provider], no_cache))

    started = time.perf_counter()
    result = await service.snapshot_all(symbols)
    elapsed = time.perf_counter() - started

    assert len(result["quotes"]) == 5
    # Serial would be ~0.5s; concurrent is ~0.1s. The midpoint separates them
    # without being sensitive to scheduling noise.
    assert elapsed < 0.3, f"looks serial: {elapsed:.2f}s for 5 x 100ms"


async def test_one_dead_symbol_does_not_blank_the_others(settings):
    """The isolation the serial loop had must survive the move to gather()."""
    symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
    no_cache = settings.model_copy(update={"ticker_cache_seconds": 0.0})
    provider = CountingProvider(delay=0.01, fail_for={"SOLUSDT"})
    service = MarketService(MarketDataRouter([provider], no_cache))

    result = await service.snapshot_all(symbols)

    assert set(result["quotes"]) == {"BTCUSDT", "ETHUSDT"}
    assert set(result["failures"]) == {"SOLUSDT"}


async def test_an_unexpected_error_is_not_reported_as_a_market_outage(settings):
    """A bug must not hide behind a plausible-looking "provider down"."""
    no_cache = settings.model_copy(update={"ticker_cache_seconds": 0.0})

    class Broken(CountingProvider):
        async def get_ticker(self, symbol: str) -> Ticker:
            raise ZeroDivisionError("a real bug")

    service = MarketService(MarketDataRouter([Broken()], no_cache))
    result = await service.snapshot_all(["BTCUSDT"])

    assert result["failures"]["BTCUSDT"] == "internal_error"


# --- D. Budgets protect a shared upstream quota ---------------------------


def test_budgets_are_sized_by_upstream_cost_not_our_own():
    """`overview` fans out to every tracked symbol, so it must be the tightest
    budget; `local` touches no exchange at all and can be the loosest."""
    assert BUDGETS["overview"].limit < BUDGETS["ticker"].limit
    assert BUDGETS["overview"].limit < BUDGETS["candles"].limit
    assert BUDGETS["local"].limit > BUDGETS["ticker"].limit


def test_routes_classify_to_the_budget_they_actually_cost():
    assert classify("/api/market/overview") == "overview"
    assert classify("/api/market/BTCUSDT/candles") == "candles"
    assert classify("/api/market/BTCUSDT/orderbook") == "orderbook"
    assert classify("/api/market/BTCUSDT/ticker") == "ticker"
    assert classify("/api/market/symbols") == "local"


def test_a_client_is_cut_off_at_its_budget():
    limiter = RateLimiter()
    budget = BUDGETS["overview"].limit

    allowed = sum(limiter.check("1.2.3.4", "overview")[0] for _ in range(budget + 10))

    assert allowed == budget


def test_one_abusive_client_does_not_throttle_everyone_else():
    limiter = RateLimiter()
    for _ in range(BUDGETS["overview"].limit + 5):
        limiter.check("1.2.3.4", "overview")

    allowed, remaining, _ = limiter.check("9.9.9.9", "overview")

    assert allowed is True
    assert remaining == BUDGETS["overview"].limit - 1


def test_the_budget_refills_when_the_window_rolls_over():
    limiter = RateLimiter()
    now = 1000.0
    for _ in range(BUDGETS["overview"].limit + 5):
        limiter.check("1.2.3.4", "overview", now=now)

    assert limiter.check("1.2.3.4", "overview", now=now)[0] is False
    assert limiter.check("1.2.3.4", "overview", now=now + 61)[0] is True


def test_expired_windows_are_pruned_so_memory_does_not_grow_forever():
    """One entry per address seen, kept forever, is a leak that only appears in
    production."""
    limiter = RateLimiter()
    now = 1000.0
    for i in range(500):
        limiter.check(f"10.0.0.{i}", "ticker", now=now)
    assert limiter.tracked_clients == 500

    dropped = limiter.prune(now=now + 3600)

    assert dropped == 500
    assert limiter.tracked_clients == 0
