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
