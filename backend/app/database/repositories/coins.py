"""Universe persistence."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.models.coin import Coin
from app.market_data.okx import to_inst_id


class CoinRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list_active(self) -> list[Coin]:
        stmt = select(Coin).where(Coin.is_active.is_(True)).order_by(Coin.sort_order, Coin.symbol)
        return list((await self.session.execute(stmt)).scalars())

    async def get(self, symbol: str) -> Coin | None:
        stmt = select(Coin).where(Coin.symbol == symbol.upper())
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def ensure(self, symbols: list[str]) -> list[Coin]:
        """Make the configured universe exist, without disturbing what is there.

        Deliberately additive: a coin an operator deactivated stays deactivated
        on the next restart rather than silently coming back.
        """
        created: list[Coin] = []
        for order, symbol in enumerate(symbols):
            symbol = symbol.upper()
            if await self.get(symbol) is not None:
                continue
            base, _, quote = to_inst_id(symbol).partition("-")
            coin = Coin(
                symbol=symbol,
                base_asset=base or symbol,
                quote_asset=quote or "",
                display_name=f"{base}/{quote}" if quote else symbol,
                sort_order=order,
                is_active=True,
            )
            self.session.add(coin)
            created.append(coin)
        if created:
            await self.session.flush()
        return created
