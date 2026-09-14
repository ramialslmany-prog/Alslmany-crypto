"""Response models for the HTTP surface.

Decimals are serialised as strings. JSON numbers are IEEE doubles, so emitting
a price as a bare number hands the browser a value that has already lost
precision — the exact loss the storage layer works to avoid.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict, field_serializer

from app.market_data.schemas import Candle, OrderBook, Provenance, Ticker


class ApiModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Meta(ApiModel):
    """Provenance, attached to every market-data response.

    A consumer can always tell which venue answered, whether the value came
    from cache, and whether it is stale — without having to ask.
    """

    source: str
    fetched_at: datetime
    cached: bool
    stale: bool
    fallback_used: bool
    providers_tried: list[str]
    degraded: bool

    @classmethod
    def of(cls, p: Provenance) -> Meta:
        return cls(
            source=p.provider,
            fetched_at=p.fetched_at,
            cached=p.cached,
            stale=p.stale,
            fallback_used=p.fallback_used,
            providers_tried=list(p.providers_tried),
            # One flag the UI can act on without interpreting the others.
            degraded=p.stale or p.fallback_used,
        )


class TickerOut(ApiModel):
    symbol: str
    price: Decimal
    change_24h_pct: Decimal | None
    high_24h: Decimal | None
    low_24h: Decimal | None
    volume_24h: Decimal | None
    quote_volume_24h: Decimal | None
    timestamp: datetime
    age_seconds: float

    @field_serializer(
        "price", "change_24h_pct", "high_24h", "low_24h", "volume_24h", "quote_volume_24h"
    )
    def _decimals(self, v: Decimal | None) -> str | None:
        return None if v is None else str(v)

    @classmethod
    def of(cls, t: Ticker) -> TickerOut:
        return cls(**t.model_dump(), age_seconds=round(t.age_seconds, 3))


class CandleOut(ApiModel):
    open_time: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal
    quote_volume: Decimal | None
    trades: int | None
    closed: bool

    @field_serializer("open", "high", "low", "close", "volume", "quote_volume")
    def _decimals(self, v: Decimal | None) -> str | None:
        return None if v is None else str(v)

    @classmethod
    def of(cls, c: Candle) -> CandleOut:
        return cls(
            open_time=c.open_time,
            open=c.open,
            high=c.high,
            low=c.low,
            close=c.close,
            volume=c.volume,
            quote_volume=c.quote_volume,
            trades=c.trades,
            closed=c.closed,
        )


class LevelOut(ApiModel):
    price: Decimal
    quantity: Decimal

    @field_serializer("price", "quantity")
    def _decimals(self, v: Decimal) -> str:
        return str(v)


class OrderBookOut(ApiModel):
    symbol: str
    bids: list[LevelOut]
    asks: list[LevelOut]
    best_bid: Decimal | None
    best_ask: Decimal | None
    spread_pct: Decimal | None
    timestamp: datetime

    @field_serializer("best_bid", "best_ask", "spread_pct")
    def _decimals(self, v: Decimal | None) -> str | None:
        return None if v is None else str(v)

    @classmethod
    def of(cls, b: OrderBook) -> OrderBookOut:
        return cls(
            symbol=b.symbol,
            bids=[LevelOut(price=x.price, quantity=x.quantity) for x in b.bids],
            asks=[LevelOut(price=x.price, quantity=x.quantity) for x in b.asks],
            best_bid=b.best_bid,
            best_ask=b.best_ask,
            spread_pct=None if b.spread_pct is None else round(b.spread_pct, 6),
            timestamp=b.timestamp,
        )


class CoinOut(ApiModel):
    symbol: str
    base_asset: str
    quote_asset: str
    display_name: str | None
    is_active: bool


T = TypeVar("T")


class Envelope(ApiModel, Generic[T]):
    data: T
    meta: Meta
