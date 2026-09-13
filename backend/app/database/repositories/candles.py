"""Candle persistence.

Writes are upserts on (symbol, timeframe, open_time). Exchanges revise the most
recent bars as trades settle, and a forming bar is refetched repeatedly by
design, so insert-only storage would accumulate duplicates of the same instant
and hand the indicator layer a series with phantom bars in it.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.models.market_data import Candle as CandleRow
from app.market_data.schemas import Candle
from app.market_data.timeframes import Timeframe

_UPDATABLE = (
    "open",
    "high",
    "low",
    "close",
    "volume",
    "quote_volume",
    "trades",
    "is_closed",
    "source",
    "updated_at",
)


class CandleRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def upsert_many(self, candles: list[Candle], *, source: str) -> int:
        if not candles:
            return 0

        now = datetime.now(candles[0].open_time.tzinfo)
        rows = [
            {
                "symbol": c.symbol,
                "timeframe": c.timeframe.value,
                "open_time": c.open_time,
                "open": c.open,
                "high": c.high,
                "low": c.low,
                "close": c.close,
                "volume": c.volume,
                "quote_volume": c.quote_volume,
                "trades": c.trades,
                "is_closed": c.closed,
                "source": source,
                "created_at": now,
                "updated_at": now,
            }
            for c in candles
        ]

        dialect = self.session.bind.dialect.name if self.session.bind else "sqlite"
        insert = pg_insert if dialect == "postgresql" else sqlite_insert
        stmt = insert(CandleRow).values(rows)
        stmt = stmt.on_conflict_do_update(
            index_elements=["symbol", "timeframe", "open_time"],
            set_={name: getattr(stmt.excluded, name) for name in _UPDATABLE},
        )
        await self.session.execute(stmt)
        return len(rows)

    async def latest(self, symbol: str, timeframe: Timeframe, limit: int = 200) -> list[CandleRow]:
        stmt = (
            select(CandleRow)
            .where(CandleRow.symbol == symbol, CandleRow.timeframe == timeframe.value)
            .order_by(CandleRow.open_time.desc())
            .limit(limit)
        )
        rows = list((await self.session.execute(stmt)).scalars())
        rows.reverse()  # hand back oldest-first, as every consumer expects
        return rows

    async def count(self, symbol: str, timeframe: Timeframe) -> int:
        from sqlalchemy import func

        stmt = (
            select(func.count())
            .select_from(CandleRow)
            .where(CandleRow.symbol == symbol, CandleRow.timeframe == timeframe.value)
        )
        return int((await self.session.execute(stmt)).scalar_one())
