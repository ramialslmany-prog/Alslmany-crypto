"""Liveness, readiness, and an honest view of the market-data feed."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import text

from app.api.deps import get_market_service, settings_dep
from app.config import Settings
from app.core.errors import MarketDataError
from app.database.session import get_engine
from app.services.market_service import MarketService

router = APIRouter(tags=["system"])


@router.get("/health")
async def health() -> dict[str, str]:
    """Liveness only: is the process up. No dependencies are touched."""
    return {"status": "ok"}


@router.get("/ready")
async def ready(
    response: Response,
    settings: Annotated[Settings, Depends(settings_dep)],
    market: Annotated[MarketService, Depends(get_market_service)],
) -> dict[str, object]:
    """Readiness: can this instance actually do its job.

    Deliberately reports 503 when the market feed is unusable. An instance that
    cannot obtain prices should not be advertised as healthy just because its
    web server is listening — that is how a fleet keeps serving a screen full
    of stale numbers.
    """
    checks: dict[str, object] = {}
    ok = True

    try:
        async with get_engine().connect() as conn:
            await conn.execute(text("SELECT 1"))
        checks["database"] = {"ok": True}
    except Exception as exc:
        ok = False
        checks["database"] = {"ok": False, "error": type(exc).__name__}

    probe = settings.symbol_list[0]
    try:
        # allow_stale=False is the whole point: a readiness check satisfied
        # by a cached value reports health it has not verified.
        sourced = await market.get_ticker(probe, persist=False, allow_stale=False)
        checks["market_data"] = {
            "ok": True,
            "probe_symbol": probe,
            "source": sourced.provenance.provider,
            "stale": sourced.provenance.stale,
        }
    except MarketDataError as exc:
        ok = False
        checks["market_data"] = {"ok": False, "probe_symbol": probe, "error": exc.code}

    if not ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    return {"status": "ready" if ok else "degraded", "checks": checks}


@router.get("/config")
async def config(settings: Annotated[Settings, Depends(settings_dep)]) -> dict[str, object]:
    """The configuration a client may see. Never secrets."""
    return settings.safe_summary()
