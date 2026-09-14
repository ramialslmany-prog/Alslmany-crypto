"""Request-scoped dependencies."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status

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


async def require_operator(
    settings: Annotated[Settings, Depends(settings_dep)],
    x_cron_secret: Annotated[str | None, Header()] = None,
) -> None:
    """Guard every endpoint that changes state.

    Written as a dependency rather than four lines repeated in each route,
    because the repetition is exactly what failed: `/bot/tick` and the drawdown
    acknowledgement checked the secret and the manual-close endpoint did not —
    so anyone who found the URL could close another operator's open positions
    and realise their P/L. A README-coverage test surfaced the route; making the
    check a dependency is what stops the next one being forgotten.

    Unset `CRON_SECRET` leaves these endpoints open, which is right for a local
    run and wrong for a deployment — so `/api/ready` reports whether it is
    configured rather than letting the omission pass unnoticed.
    """
    expected = getattr(settings, "cron_secret", None)
    if expected and x_cron_secret != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")
