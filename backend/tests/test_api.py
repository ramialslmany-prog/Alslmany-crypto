"""API contract tests, including how the surface behaves when the feed dies."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx
import pytest_asyncio
from asgi_lifespan import LifespanManager

from app.config import Settings, get_settings
from app.market_data.schemas import Candle, OrderBook, OrderBookLevel, Ticker


class StubProvider:
    name = "stub"

    def __init__(self) -> None:
        self.fail = False

    def _guard(self):
        if self.fail:
            from app.core.errors import ProviderUnavailableError

            raise ProviderUnavailableError("stub is down", provider=self.name)

    async def get_ticker(self, symbol: str) -> Ticker:
        self._guard()
        return Ticker(
            symbol=symbol,
            price=Decimal("108150.25"),
            change_24h_pct=Decimal("1.17"),
            high_24h=Decimal("108900"),
            low_24h=Decimal("106500"),
            volume_24h=Decimal("18234.5512"),
            timestamp=datetime.now(UTC),
        )

    async def get_candles(self, symbol, timeframe, limit=200) -> list[Candle]:
        self._guard()
        now = datetime.now(UTC).replace(second=0, microsecond=0)
        return [
            Candle(
                symbol=symbol,
                timeframe=timeframe,
                open_time=now.fromtimestamp(
                    now.timestamp() - (limit - i) * timeframe.seconds, tz=UTC
                ),
                open=Decimal("100"),
                high=Decimal("110"),
                low=Decimal("95"),
                close=Decimal("105"),
                volume=Decimal("10"),
                closed=i < limit - 1,
            )
            for i in range(limit)
        ]

    async def get_order_book(self, symbol, depth=20) -> OrderBook:
        self._guard()
        return OrderBook(
            symbol=symbol,
            bids=(OrderBookLevel(price=Decimal("108150.20"), quantity=Decimal("1.25")),),
            asks=(OrderBookLevel(price=Decimal("108150.30"), quantity=Decimal("0.90")),),
            timestamp=datetime.now(UTC),
        )

    async def aclose(self) -> None:
        return None


@pytest_asyncio.fixture
async def api(tmp_path, monkeypatch):
    """A real app, with the network replaced at the provider seam only."""
    db = tmp_path / "api-test.db"
    test_settings = Settings(
        environment="test",
        database_url=f"sqlite+aiosqlite:///{db}",
        symbols="BTCUSDT,ETHUSDT",
        ticker_cache_seconds=0.0,
        candle_cache_seconds=0.0,
    )
    get_settings.cache_clear()
    monkeypatch.setattr("app.config.get_settings", lambda: test_settings)
    monkeypatch.setattr("app.main.get_settings", lambda: test_settings)
    monkeypatch.setattr("app.api.deps.get_settings", lambda: test_settings)

    stub = StubProvider()
    monkeypatch.setattr("app.main.build_providers", lambda s: [stub])

    from app.main import create_app

    app = create_app()
    async with LifespanManager(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            yield client, stub
    get_settings.cache_clear()


async def test_health_is_dependency_free(api):
    client, _ = api
    r = await client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


async def test_symbols_are_seeded_from_config(api):
    client, _ = api
    r = await client.get("/api/market/symbols")
    assert r.status_code == 200
    assert [c["symbol"] for c in r.json()] == ["BTCUSDT", "ETHUSDT"]


async def test_ticker_carries_provenance_and_string_decimals(api):
    client, _ = api
    r = await client.get("/api/market/BTCUSDT/ticker")
    assert r.status_code == 200
    body = r.json()

    # Serialised as a string: a JSON number would already have lost precision.
    assert body["data"]["price"] == "108150.25"
    assert isinstance(body["data"]["price"], str)
    assert body["meta"]["source"] == "stub"
    assert body["meta"]["degraded"] is False


async def test_candles_respect_limit_and_flag_the_forming_bar(api):
    client, _ = api
    r = await client.get("/api/market/BTCUSDT/candles?timeframe=1h&limit=50")
    assert r.status_code == 200
    candles = r.json()["data"]
    assert len(candles) == 50
    times = [c["open_time"] for c in candles]
    assert times == sorted(times)
    assert candles[-1]["closed"] is False


async def test_an_unsupported_timeframe_is_rejected_with_its_code(api):
    client, _ = api
    r = await client.get("/api/market/BTCUSDT/candles?timeframe=3m")
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "unsupported_timeframe"


async def test_an_untracked_symbol_is_a_404_not_a_500(api):
    client, _ = api
    r = await client.get("/api/market/DOGEUSDT/ticker")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "unsupported_symbol"


async def test_order_book_reports_the_spread(api):
    client, _ = api
    r = await client.get("/api/market/BTCUSDT/orderbook?depth=5")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["best_bid"] == "108150.20"
    assert data["best_ask"] == "108150.30"
    assert Decimal(data["spread_pct"]) > 0


async def test_overview_lists_every_tracked_symbol(api):
    client, _ = api
    r = await client.get("/api/market/overview")
    body = r.json()
    assert body["summary"] == {
        "tracked": 2,
        "quoted": 2,
        "failed": 0,
        "stale": 0,
        "feed_healthy": True,
    }
    assert {row["symbol"] for row in body["data"]} == {"BTCUSDT", "ETHUSDT"}


# --- the behaviour that matters most --------------------------------------


async def test_when_the_feed_dies_the_api_refuses_rather_than_inventing(api):
    client, stub = api
    stub.fail = True

    r = await client.get("/api/market/BTCUSDT/ticker")

    assert r.status_code == 503
    body = r.json()
    assert body["error"]["code"] == "no_reliable_market_data"
    assert "Insufficient reliable market data" in body["error"]["message"]
    # And critically: no price field anywhere in the response.
    assert "data" not in body


async def test_overview_reports_failures_instead_of_blanking(api):
    client, stub = api
    stub.fail = True

    r = await client.get("/api/market/overview")

    assert r.status_code == 200, "a total outage is still a valid overview response"
    body = r.json()
    assert body["data"] == []
    assert body["summary"]["feed_healthy"] is False
    assert {f["symbol"] for f in body["failures"]} == {"BTCUSDT", "ETHUSDT"}
    assert all(f["code"] == "no_reliable_market_data" for f in body["failures"])


async def test_readiness_goes_503_when_the_feed_is_down(api):
    client, stub = api
    r = await client.get("/api/ready")
    assert r.status_code == 200
    assert r.json()["status"] == "ready"

    stub.fail = True
    r = await client.get("/api/ready")
    assert r.status_code == 503
    assert r.json()["status"] == "degraded"
    assert r.json()["checks"]["market_data"]["ok"] is False


async def test_config_endpoint_never_exposes_a_secret(api):
    client, _ = api
    r = await client.get("/api/config")
    body = r.json()
    assert body["paper_trading_only"] is True
    assert "ai_api_key" not in body
    assert "database_url" not in body
    assert "market_data_api_key" not in body
    assert body["ai_configured"] is False


async def test_overview_does_not_call_the_feed_healthy_while_serving_stale(api_cached):
    """The badge must not read "live" on prices from a dead provider.

    Every symbol still answers — from cache — so a health check that counts
    only outright failures would report a healthy feed while nothing on the
    screen is current. That is the misrepresentation this asserts against.
    """
    client, stub, app = api_cached

    first = (await client.get("/api/market/overview")).json()
    assert first["summary"]["feed_healthy"] is True
    assert first["summary"]["stale"] == 0

    # Take the providers down and age the cached entries past their TTL.
    stub.fail = True
    router = app.state.market_service.router
    for key in list(router._tickers._entries):
        stored_at, value = router._tickers._entries[key]
        router._tickers._entries[key] = (stored_at - 60, value)

    body = (await client.get("/api/market/overview")).json()

    assert body["summary"]["quoted"] == 2, "stale values should still be served"
    assert body["summary"]["failed"] == 0
    assert body["summary"]["stale"] == 2
    assert body["summary"]["feed_healthy"] is False, "stale prices are not a live feed"
    assert all(row["meta"]["stale"] is True for row in body["data"])
    assert all(row["meta"]["degraded"] is True for row in body["data"])


@pytest_asyncio.fixture
async def api_cached(tmp_path, monkeypatch):
    """Like `api`, but with caching ON so stale behaviour can be exercised."""
    db = tmp_path / "api-cached.db"
    test_settings = Settings(
        environment="test",
        database_url=f"sqlite+aiosqlite:///{db}",
        symbols="BTCUSDT,ETHUSDT",
        ticker_cache_seconds=5.0,
    )
    get_settings.cache_clear()
    for target in ("app.config.get_settings", "app.main.get_settings", "app.api.deps.get_settings"):
        monkeypatch.setattr(target, lambda: test_settings)

    stub = StubProvider()
    monkeypatch.setattr("app.main.build_providers", lambda s: [stub])

    from app.main import create_app

    app = create_app()
    async with LifespanManager(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            yield client, stub, app
    get_settings.cache_clear()


async def test_a_backtest_is_labelled_and_reports_its_benchmark(api):
    client, _ = api
    r = await client.get("/api/backtest/BTCUSDT?timeframe=1h&bars=260")
    assert r.status_code == 200
    body = r.json()

    # The label is the point: a replay and a paper-trading record must never be
    # read as the same kind of evidence.
    assert body["kind"] == "BACKTEST"
    assert "buy_and_hold_pct" in body
    assert body["meta"]["source"] == "stub"
    assert body["meta"]["bars_requested"] == 260


async def test_a_backtest_larger_than_the_machine_should_serve_is_refused(api):
    client, _ = api
    r = await client.get("/api/backtest/BTCUSDT?bars=5000")
    assert r.status_code == 422


async def test_a_backtest_too_short_to_mean_anything_is_refused(api):
    """Rejected at the edge rather than returning an empty result that reads
    like a finding. "0 trades" from 20 bars is not a strategy result."""
    client, _ = api
    r = await client.get("/api/backtest/BTCUSDT?bars=30")
    assert r.status_code == 422


async def test_a_backtest_does_not_block_the_event_loop(api):
    """The replay is the one CPU-bound route here, and it is handed to a worker
    thread for exactly this reason.

    The assertion that carries the weight is `not task.done()`: the health check
    answers *while the replay is still running*. Were the replay awaited on the
    loop instead, nothing else could be served until it finished, so the health
    check could only return after it — and the task would already be done. A
    timeout alone would not catch that; it would just pass more slowly.
    """
    import asyncio

    client, _ = api
    task = asyncio.create_task(client.get("/api/backtest/BTCUSDT?bars=800"))
    await asyncio.sleep(0.05)  # let the request reach the worker thread
    health = await asyncio.wait_for(client.get("/api/health"), timeout=2.0)

    assert health.status_code == 200
    assert not task.done(), "the replay held the event loop while it ran"
    assert (await task).status_code == 200


async def test_analytics_on_an_empty_ledger_refuses_rather_than_reports(api):
    client, _ = api
    r = await client.get("/api/analytics/insights")
    assert r.status_code == 200
    body = r.json()

    assert body["applied"] is False
    assert body["total_closed"] == 0
    assert [o["strength"] for o in body["data"]] == ["insufficient"]


async def test_the_breakdown_names_its_dimensions_and_its_sample_floor(api):
    client, _ = api
    r = await client.get("/api/analytics/breakdown?by=symbol")
    assert r.status_code == 200
    body = r.json()

    # The floor is part of the response, not documentation: a client rendering
    # this table needs to state it beside the numbers.
    assert body["min_sample"] >= 20
    assert "confidence" in body["dimensions"]


async def test_an_unknown_breakdown_dimension_is_a_422(api):
    client, _ = api
    r = await client.get("/api/analytics/breakdown?by=phase_of_moon")
    assert r.status_code == 422


async def test_the_benchmark_reads_prices_without_archiving_them(api, monkeypatch):
    """The analytics routes claim in their own docstring to write nothing.

    A thousand daily bars per traded symbol, archived on every call, would make
    that claim false and cost a five-thousand-row write for one percentage.
    """
    from app.database.session import get_sessionmaker
    from app.paper.models import PaperTrade
    from app.services.market_service import MarketService

    client, _ = api

    # The benchmark only fetches prices for symbols that were actually traded,
    # so without a closed trade this test would pass by doing nothing.
    now = datetime.now(UTC)
    async with get_sessionmaker()() as session:
        session.add(
            PaperTrade(
                symbol="BTCUSDT",
                direction="LONG",
                status="closed",
                timeframe="1h",
                entry=Decimal("100"),
                stop_loss=Decimal("95"),
                take_profit=Decimal("115"),
                quantity=Decimal("20"),
                notional=Decimal("2000"),
                risk_amount=Decimal("100"),
                reward_risk=Decimal("3"),
                exit_price=Decimal("115"),
                pnl=Decimal("300"),
                r_multiple=Decimal("3"),
                fees=Decimal("2"),
                result="WIN",
                exit_reason="take_profit",
                confidence=Decimal("82"),
                strategy="multi-factor-v1",
                reason="fixture",
                opened_at=now - timedelta(days=3),
                closed_at=now - timedelta(days=1),
                is_paper=True,
            )
        )
        await session.commit()

    original = MarketService.get_candles
    seen: list[bool] = []

    async def spy(self, symbol, timeframe, limit=200, *, persist=True):
        seen.append(persist)
        return await original(self, symbol, timeframe, limit, persist=persist)

    monkeypatch.setattr(MarketService, "get_candles", spy)

    r = await client.get("/api/analytics/benchmark")
    assert r.status_code == 200
    assert r.json()["data"], "the traded symbol produced no benchmark row"
    assert seen, "no price history was fetched, so nothing was actually tested"
    assert all(p is False for p in seen), (
        f"the benchmark archived candles: persist flags were {seen}"
    )
