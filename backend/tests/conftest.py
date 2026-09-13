from __future__ import annotations

import json
from collections.abc import Callable

import httpx
import pytest

from app.config import Settings


def make_transport(
    handler: Callable[[httpx.Request], httpx.Response],
) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


def json_route(routes: dict[str, object], *, status: int = 200) -> httpx.MockTransport:
    """Serve recorded payloads by URL path, 404 for anything unexpected.

    Unmapped paths fail loudly rather than returning an empty body, so a test
    that silently requests the wrong endpoint cannot pass.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        payload = routes.get(request.url.path)
        if payload is None:
            return httpx.Response(404, json={"error": f"unmapped path {request.url.path}"})
        return httpx.Response(status, content=json.dumps(payload))

    return httpx.MockTransport(handler)


@pytest.fixture
def settings() -> Settings:
    return Settings(
        environment="test",
        database_url="sqlite+aiosqlite:///:memory:",
        ticker_cache_seconds=5.0,
        candle_cache_seconds=5.0,
        orderbook_cache_seconds=5.0,
        market_data_max_retries=2,
        market_data_backoff_seconds=0.0,
    )


@pytest.fixture
def api_app(tmp_path, monkeypatch):
    """The real app object, for tests that drive it through `TestClient`.

    Synchronous on purpose. `TestClient` runs the lifespan and the event loop
    itself, which is what makes WebSocket testing possible at all — the async
    `httpx` transport used elsewhere in this suite speaks HTTP only.
    """
    from tests.test_api import StubProvider

    db = tmp_path / "live-test.db"
    test_settings = Settings(
        environment="test",
        database_url=f"sqlite+aiosqlite:///{db}",
        symbols="BTCUSDT,ETHUSDT",
        ticker_cache_seconds=0.0,
        candle_cache_seconds=0.0,
    )
    from app.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setattr("app.config.get_settings", lambda: test_settings)
    monkeypatch.setattr("app.main.get_settings", lambda: test_settings)
    monkeypatch.setattr("app.api.deps.get_settings", lambda: test_settings)

    stub = StubProvider()
    monkeypatch.setattr("app.main.build_providers", lambda s: [stub])

    from app.main import create_app

    yield create_app(), stub
    get_settings.cache_clear()
