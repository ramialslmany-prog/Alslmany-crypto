"""Trade and risk-override persistence."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.paper.models import PaperTrade, RiskOverride


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


class RiskOverrideRepository:
    """Append-only. There is no update and no delete, deliberately.

    A risk override that can be edited is not an audit trail; the question
    "who decided to keep trading after a 10% loss, and when" must keep its
    answer.
    """

    DRAWDOWN_RESET = "drawdown_baseline_reset"

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def latest_drawdown_reset(self) -> RiskOverride | None:
        stmt = (
            select(RiskOverride)
            .where(RiskOverride.kind == self.DRAWDOWN_RESET)
            .order_by(RiskOverride.at.desc())
            .limit(1)
        )
        return (await self.session.execute(stmt)).scalars().first()

    async def history(self, limit: int = 50) -> list[RiskOverride]:
        stmt = select(RiskOverride).order_by(RiskOverride.at.desc()).limit(limit)
        return list((await self.session.execute(stmt)).scalars())

    def record_drawdown_reset(
        self, *, baseline_equity: Decimal, drawdown_pct: Decimal, note: str | None, at: datetime
    ) -> RiskOverride:
        override = RiskOverride(
            kind=self.DRAWDOWN_RESET,
            baseline_equity=baseline_equity,
            drawdown_pct_at_reset=drawdown_pct,
            note=note,
            at=at,
        )
        self.session.add(override)
        return override
