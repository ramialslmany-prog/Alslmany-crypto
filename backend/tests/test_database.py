"""Storage tests. The decimal round-trip is the one that matters most."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
import pytest_asyncio

from app.config import Settings
from app.database.repositories import CandleRepository, CoinRepository
from app.database.session import create_all, dispose_engine, init_engine, session_scope
from app.market_data.schemas import Candle
from app.market_data.timeframes import Timeframe


@pytest_asyncio.fixture
async def db():
    settings = Settings(environment="test", database_url="sqlite+aiosqlite:///:memory:")
    # A file-backed :memory: database is per-connection, so the whole test must
    # share one connection; a NullPool-less engine with a single session does.
    init_engine(settings)
    await create_all(settings)
    yield settings
    await dispose_engine()


def make_candle(minutes_ago: int, close: str = "108150.25") -> Candle:
    t = datetime.now(UTC).replace(second=0, microsecond=0) - timedelta(minutes=minutes_ago)
    return Candle(
        symbol="BTCUSDT",
        timeframe=Timeframe.M1,
        open_time=t,
        open=Decimal("108000.00000001"),
        high=Decimal("108900.5"),
        low=Decimal("107500.25"),
        close=Decimal(close),
        volume=Decimal("512.123456789"),
        quote_volume=Decimal("55300000.5"),
        trades=42311,
    )


async def test_decimal_survives_the_round_trip_exactly(db):
    async with session_scope() as session:
        await CandleRepository(session).upsert_many([make_candle(5)], source="binance")

    async with session_scope() as session:
        rows = await CandleRepository(session).latest("BTCUSDT", Timeframe.M1)

    assert len(rows) == 1
    row = rows[0]
    assert isinstance(row.open, Decimal)
    assert row.open == Decimal("108000.00000001")
    assert row.volume == Decimal("512.123456789")

    # And the timestamp comes back aware, not naive.
    assert row.open_time.tzinfo is not None


async def test_precision_beyond_float64_is_not_silently_truncated(db):
    """The value that proves the Money type is doing something.

    float64 carries ~17 significant decimal digits. This has 25, so a backend
    that round-trips through float cannot return it intact.
    """
    exact = Decimal("1234567890.123456789012345")
    candle = Candle(
        symbol="BTCUSDT",
        timeframe=Timeframe.M1,
        open_time=datetime.now(UTC).replace(second=0, microsecond=0),
        open=exact,
        high=exact,
        low=exact,
        close=exact,
        volume=Decimal("0.000000000000000001"),
    )
    assert Decimal(str(float(exact))) != exact, "precondition: float must lose this value"

    async with session_scope() as session:
        await CandleRepository(session).upsert_many([candle], source="binance")
    async with session_scope() as session:
        rows = await CandleRepository(session).latest("BTCUSDT", Timeframe.M1)

    assert rows[0].open == exact
    assert rows[0].volume == Decimal("0.000000000000000001")


async def test_reingesting_the_same_bar_updates_rather_than_duplicates(db):
    original = make_candle(5, close="108150.25")
    revised = make_candle(5, close="108222.75")

    async with session_scope() as session:
        repo = CandleRepository(session)
        await repo.upsert_many([original], source="binance")
        await repo.upsert_many([revised], source="okx")

    async with session_scope() as session:
        repo = CandleRepository(session)
        rows = await repo.latest("BTCUSDT", Timeframe.M1)
        assert await repo.count("BTCUSDT", Timeframe.M1) == 1, "must not duplicate the instant"

    assert rows[0].close == Decimal("108222.75"), "the revision must win"
    assert rows[0].source == "okx"


async def test_candles_come_back_oldest_first(db):
    candles = [make_candle(m) for m in (1, 2, 3, 4, 5)]
    async with session_scope() as session:
        await CandleRepository(session).upsert_many(candles, source="binance")

    async with session_scope() as session:
        rows = await CandleRepository(session).latest("BTCUSDT", Timeframe.M1, limit=10)

    times = [r.open_time for r in rows]
    assert times == sorted(times)


async def test_latest_returns_the_newest_n_not_the_oldest_n(db):
    candles = [make_candle(m) for m in range(1, 11)]
    async with session_scope() as session:
        await CandleRepository(session).upsert_many(candles, source="binance")

    async with session_scope() as session:
        rows = await CandleRepository(session).latest("BTCUSDT", Timeframe.M1, limit=3)

    assert len(rows) == 3
    newest = max(c.open_time for c in candles)
    assert rows[-1].open_time == newest


async def test_timeframes_are_separate_series(db):
    m1 = make_candle(5)
    h1 = Candle(**{**m1.model_dump(), "timeframe": Timeframe.H1})

    async with session_scope() as session:
        repo = CandleRepository(session)
        await repo.upsert_many([m1], source="binance")
        await repo.upsert_many([h1], source="binance")

    async with session_scope() as session:
        repo = CandleRepository(session)
        assert await repo.count("BTCUSDT", Timeframe.M1) == 1
        assert await repo.count("BTCUSDT", Timeframe.H1) == 1


async def test_ensure_creates_the_universe_and_is_idempotent(db):
    symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]

    async with session_scope() as session:
        created = await CoinRepository(session).ensure(symbols)
        assert len(created) == 3

    async with session_scope() as session:
        repo = CoinRepository(session)
        again = await repo.ensure(symbols)
        assert again == [], "a second run must create nothing"
        coins = await repo.list_active()

    assert [c.symbol for c in coins] == symbols
    btc = next(c for c in coins if c.symbol == "BTCUSDT")
    assert (btc.base_asset, btc.quote_asset) == ("BTC", "USDT")


async def test_a_deactivated_coin_is_not_resurrected_by_ensure(db):
    async with session_scope() as session:
        repo = CoinRepository(session)
        await repo.ensure(["BTCUSDT", "ETHUSDT"])

    async with session_scope() as session:
        repo = CoinRepository(session)
        eth = await repo.get("ETHUSDT")
        eth.is_active = False

    async with session_scope() as session:
        repo = CoinRepository(session)
        await repo.ensure(["BTCUSDT", "ETHUSDT"])
        active = await repo.list_active()

    assert [c.symbol for c in active] == ["BTCUSDT"]


async def test_a_failed_transaction_leaves_nothing_behind(db):
    with pytest.raises(RuntimeError):
        async with session_scope() as session:
            await CandleRepository(session).upsert_many([make_candle(5)], source="binance")
            raise RuntimeError("failure after the write")

    async with session_scope() as session:
        assert await CandleRepository(session).count("BTCUSDT", Timeframe.M1) == 0


async def test_timestamps_come_back_timezone_aware(db):
    """SQLite does not preserve tzinfo on its own; UtcDateTime must."""
    async with session_scope() as session:
        await CandleRepository(session).upsert_many([make_candle(5)], source="binance")
        await CoinRepository(session).ensure(["BTCUSDT"])

    async with session_scope() as session:
        row = (await CandleRepository(session).latest("BTCUSDT", Timeframe.M1))[0]
        coin = await CoinRepository(session).get("BTCUSDT")

    for value in (row.open_time, row.created_at, row.updated_at, coin.created_at):
        assert value.tzinfo is not None, "a naive timestamp escaped the database"
        assert value.utcoffset() == timedelta(0), "and it must be UTC"


async def test_a_naive_timestamp_is_rejected_rather_than_guessed(db):
    """Assuming naive means UTC is how local time gets into a trading database."""
    from app.database.models import TickerSnapshot

    with pytest.raises(Exception) as exc:
        async with session_scope() as session:
            session.add(
                TickerSnapshot(
                    symbol="BTCUSDT",
                    price=Decimal("1"),
                    observed_at=datetime(2026, 9, 13, 5, 0, 0),  # no tzinfo
                    source="binance",
                )
            )
            await session.flush()
    assert "naive datetime" in str(exc.value)
