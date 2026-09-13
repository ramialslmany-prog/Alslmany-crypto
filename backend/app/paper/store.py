"""Trade persistence."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.paper.models import PaperTrade


class TradeRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def all(self, limit: int = 500) -> list[PaperTrade]:
        stmt = select(PaperTrade).order_by(PaperTrade.opened_at.desc()).limit(limit)
        return list((await self.session.execute(stmt)).scalars())

    async def open_trades(self) -> list[PaperTrade]:
        stmt = (
            select(PaperTrade)
            .where(PaperTrade.status == "open")
            .order_by(PaperTrade.opened_at.desc())
        )
        return list((await self.session.execute(stmt)).scalars())

    async def closed_trades(self, limit: int = 500) -> list[PaperTrade]:
        stmt = (
            select(PaperTrade)
            .where(PaperTrade.status == "closed")
            .order_by(PaperTrade.closed_at.desc())
            .limit(limit)
        )
        return list((await self.session.execute(stmt)).scalars())

    def add_all(self, trades: list[PaperTrade]) -> None:
        for trade in trades:
            self.session.add(trade)
