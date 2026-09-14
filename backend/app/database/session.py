"""Async engine and session lifecycle.

One engine per process. The session dependency commits on success and rolls
back on any exception, so a request that fails halfway cannot leave a
half-written trade behind — a property that matters far more from Stage 6
onward, but which is cheaper to get right now than to retrofit.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import Settings
from app.database.base import Base

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def init_engine(settings: Settings) -> AsyncEngine:
    global _engine, _sessionmaker

    kwargs: dict[str, object] = {"echo": settings.database_echo, "future": True}
    if not settings.is_sqlite:
        # Connections are recycled well inside the typical cloud idle timeout,
        # so the first query after a quiet period does not fail on a dead socket.
        kwargs |= {"pool_size": 10, "max_overflow": 20, "pool_pre_ping": True, "pool_recycle": 1800}

    _engine = create_async_engine(settings.database_url, **kwargs)
    _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False, class_=AsyncSession)
    return _engine


def get_engine() -> AsyncEngine:
    if _engine is None:
        raise RuntimeError("Database engine is not initialised; call init_engine() first.")
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    if _sessionmaker is None:
        raise RuntimeError("Database engine is not initialised; call init_engine() first.")
    return _sessionmaker


async def dispose_engine() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """A transactional scope for background workers."""
    async with get_sessionmaker()() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency."""
    async with session_scope() as session:
        yield session


async def create_all(settings: Settings) -> None:
    """Create the schema directly.

    Used by the suite and by a first local run. Production migrates with
    Alembic instead, so that a column change is reviewable as a diff rather
    than being applied implicitly at startup.
    """
    # `Base.metadata` is populated as a side effect of importing the model
    # modules. Without this line it is EMPTY unless something else happened to
    # import them first, and create_all() silently creates nothing at all —
    # succeeding loudly while doing nothing, which is the worst way to fail.
    import app.database.models  # noqa: F401

    engine = get_engine() if _engine is not None else init_engine(settings)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
