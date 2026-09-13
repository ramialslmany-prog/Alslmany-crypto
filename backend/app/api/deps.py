"""Request-scoped dependencies."""

from __future__ import annotations

from fastapi import Request

from app.config import Settings, get_settings
from app.services.market_service import MarketService


def get_market_service(request: Request) -> MarketService:
    """The service built once at startup and held on app state.

    Constructing it per request would create a fresh connection pool and an
    empty cache on every call, which would turn the cache into decoration and
    multiply upstream load by the request rate.
    """
    return request.app.state.market_service


def settings_dep() -> Settings:
    return get_settings()
