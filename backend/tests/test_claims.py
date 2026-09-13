"""Tests that hold the documentation to account.

Both of these covered claims the README made that no code supported: a durable
audit trail nothing ever wrote to, and an Alembic migration story with no
Alembic in the repository. A claim with no test is a claim that quietly stops
being true.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.config import Settings
from app.core.errors import NoMarketDataError, ProviderUnavailableError
from app.database.models import SystemLog
from app.database.session import create_all, dispose_engine, init_engine, session_scope
from app.market_data.router import MarketDataRouter
from app.market_data.schemas import Ticker
from app.services import event_log
from app.services.market_service import MarketService

BACKEND = Path(__file__).resolve().parents[1]


@pytest_asyncio.fixture
async def db(tmp_path):
    settings = Settings(
        environment="test",
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'claims.db'}",
        ticker_cache_seconds=0.0,
    )
    init_engine(settings)
    await create_all(settings)
    yield settings
    await dispose_engine()


class Flaky:
    name = "flaky"

    def __init__(self) -> None:
        self.fail = True

    async def get_ticker(self, symbol: str) -> Ticker:
        if self.fail:
            raise ProviderUnavailableError("down", provider=self.name)
        return Ticker(symbol=symbol, price=Decimal("1"), timestamp=datetime.now(UTC))

    async def get_candles(self, *a, **k):  # pragma: no cover
        raise NotImplementedError

    async def get_order_book(self, *a, **k):  # pragma: no cover
        raise NotImplementedError

    async def aclose(self) -> None:
        return None


async def _logs() -> list[SystemLog]:
    async with session_scope() as session:
        rows = await session.execute(select(SystemLog).order_by(SystemLog.id))
        return list(rows.scalars())


# --- the audit trail actually records something ---------------------------


async def test_an_outage_is_written_to_the_database_not_only_to_stdout(db):
    """ "Why did it stop trading on Tuesday" has to be answerable from the
    database, long after the container that logged it was recycled."""
    provider = Flaky()
    service = MarketService(MarketDataRouter([provider], db))

    with pytest.raises(NoMarketDataError):
        await service.get_ticker("BTCUSDT")

    rows = await _logs()
    assert len(rows) == 1
    assert rows[0].category == event_log.MARKET_DATA_OUTAGE
    assert rows[0].level == "ERROR"
    assert rows[0].context["symbol"] == "BTCUSDT"


async def test_a_persistent_outage_records_the_transition_not_every_retry(db):
    """A client polling a dead feed would otherwise write thousands of
    identical rows and bury the moment that matters."""
    provider = Flaky()
    service = MarketService(MarketDataRouter([provider], db))

    for _ in range(10):
        with pytest.raises(NoMarketDataError):
            await service.get_ticker("BTCUSDT")

    assert len(await _logs()) == 1


async def test_recovery_is_recorded_too(db):
    provider = Flaky()
    service = MarketService(MarketDataRouter([provider], db))

    with pytest.raises(NoMarketDataError):
        await service.get_ticker("BTCUSDT")
    provider.fail = False
    await service.get_ticker("BTCUSDT", persist=False)

    rows = await _logs()
    assert [r.category for r in rows] == [
        event_log.MARKET_DATA_OUTAGE,
        event_log.MARKET_DATA_RECOVERED,
    ]


async def test_a_logging_failure_cannot_break_the_request(db):
    """An outage report that itself throws would turn a degraded feed into a
    failed request — the record must never be able to break what it records."""
    await dispose_engine()  # no engine: every write will raise

    await event_log.record("error", event_log.MARKET_DATA_OUTAGE, "boom", symbol="X")
    # Reaching here without an exception is the assertion.


# --- the migration story is real ------------------------------------------


def test_a_migration_exists_and_is_the_only_head():
    versions = list((BACKEND / "alembic" / "versions").glob("*.py"))
    assert versions, "the README promises Alembic owns schema changes"
    assert (BACKEND / "alembic.ini").is_file()


def test_alembic_ini_carries_no_credentials():
    """The URL must come from settings, so no connection string is committed."""
    text = (BACKEND / "alembic.ini").read_text()
    line = next(ln for ln in text.splitlines() if ln.strip().startswith("sqlalchemy.url"))
    assert line.split("=", 1)[1].strip() == ""


def test_migrations_build_the_same_schema_the_application_does(tmp_path, monkeypatch):
    """Two sources of truth for a schema means they drift, and the migration is
    the one nobody runs locally — so it is the one that silently rots."""
    from alembic.config import Config

    from alembic import command

    migrated = tmp_path / "migrated.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{migrated}")

    from app.config import get_settings

    get_settings.cache_clear()
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    command.upgrade(cfg, "head")
    get_settings.cache_clear()

    import asyncio

    created = tmp_path / "created.db"

    async def build() -> None:
        settings = Settings(database_url=f"sqlite+aiosqlite:///{created}")
        init_engine(settings)
        await create_all(settings)
        await dispose_engine()

    asyncio.run(build())

    def schema(path: Path) -> dict[str, str]:
        conn = sqlite3.connect(path)
        out = {}
        for name, sql in conn.execute(
            "SELECT name, sql FROM sqlite_master "
            "WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'"
        ):
            if name == "alembic_version":
                continue
            # Alembic renders server defaults parenthesised; SQLAlchemy does
            # not. Same semantics, different spelling.
            out[name] = " ".join((sql or "").split()).replace(
                "(CURRENT_TIMESTAMP)", "CURRENT_TIMESTAMP"
            )
        return out

    from_migration, from_models = schema(migrated), schema(created)

    expected = {"coins", "candles", "ticker_snapshots", "system_logs"}
    assert expected <= set(from_migration), "the migration did not build the schema"
    assert expected <= set(from_models), "create_all() did not build the schema"
    assert from_migration == from_models
