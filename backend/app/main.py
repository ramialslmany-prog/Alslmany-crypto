"""Application entry point.

Expensive, long-lived objects — the database engine, the HTTP clients behind
each exchange adapter, the quote cache — are built once in the lifespan and
torn down deterministically. Building them per request would give every call a
cold cache and a new connection pool.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.routes import health, market
from app.config import Settings, get_settings
from app.core.errors import AppError, app_error_handler, unhandled_error_handler
from app.core.logging import configure_logging, get_logger
from app.core.rate_limit import RateLimitMiddleware
from app.database.repositories import CoinRepository
from app.database.session import (
    create_all,
    dispose_engine,
    init_engine,
    session_scope,
)
from app.market_data.router import MarketDataRouter, build_providers
from app.services.market_service import MarketService

logger = get_logger(__name__)

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = get_settings()
    configure_logging("DEBUG" if settings.debug else "INFO")

    logger.info(
        "starting",
        extra={
            "environment": settings.environment,
            "providers": settings.provider_list,
            "symbols": settings.symbol_list,
            # Stated at boot so the guarantee is visible in the log of every
            # deployment, not only in the documentation.
            "paper_trading_only": settings.paper_trading_only,
        },
    )

    init_engine(settings)
    # Stage 1 creates the schema at startup so a fresh clone runs with no extra
    # command. Alembic owns schema changes from here on.
    await create_all(settings)

    async with session_scope() as session:
        created = await CoinRepository(session).ensure(settings.symbol_list)
    if created:
        logger.info("seeded coins", extra={"symbols": [c.symbol for c in created]})

    providers = build_providers(settings)
    app.state.market_service = MarketService(MarketDataRouter(providers, settings))
    app.state.settings = settings

    try:
        yield
    finally:
        await app.state.market_service.router.aclose()
        await dispose_engine()
        logger.info("stopped")


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        description=(
            "Cryptocurrency analysis and **paper-trading** platform. "
            "Simulated trades only: this service holds no exchange credentials "
            "and has no order-placement code path."
        ),
        lifespan=lifespan,
        docs_url="/docs",
        openapi_url="/openapi.json",
    )

    # Outermost: a throttled request should cost as little as possible.
    app.add_middleware(RateLimitMiddleware)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=False,
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    app.add_exception_handler(AppError, app_error_handler)
    app.add_exception_handler(Exception, unhandled_error_handler)

    app.include_router(health.router, prefix="/api")
    app.include_router(market.router, prefix="/api")

    if FRONTEND_DIR.is_dir():
        app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

    return app


app = create_app()
