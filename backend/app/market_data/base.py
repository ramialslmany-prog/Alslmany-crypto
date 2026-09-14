"""The contract every exchange adapter satisfies.

Defined as a Protocol rather than a base class so an adapter is testable in
isolation and a fake provider in the suite is a plain object, not a subclass
carrying inherited behaviour it did not ask for.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from app.market_data.schemas import Candle, OrderBook, Ticker
from app.market_data.timeframes import Timeframe


@runtime_checkable
class MarketDataProvider(Protocol):
    name: str

    async def get_ticker(self, symbol: str) -> Ticker: ...

    async def get_candles(
        self, symbol: str, timeframe: Timeframe, limit: int = 200
    ) -> list[Candle]: ...

    async def get_order_book(self, symbol: str, depth: int = 20) -> OrderBook: ...

    async def aclose(self) -> None: ...
