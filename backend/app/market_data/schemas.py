"""The shapes the rest of the platform is allowed to see.

Provider payloads never escape the market_data package. Each adapter parses its
own dialect into these models, so a change at Binance cannot reach the analysis
engine, and every number that leaves here has been through validation.

Prices are ``Decimal``. Floats are not acceptable for money: 0.1 + 0.2 is not
0.3, and a position-sizing routine that inherits that error produces a risk
figure that is quietly wrong on every trade.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated, Generic, Self, TypeVar

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.market_data.timeframes import Timeframe

Price = Annotated[Decimal, Field(gt=0)]
NonNegative = Annotated[Decimal, Field(ge=0)]


class Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class Ticker(Frozen):
    """A current quote for one instrument."""

    symbol: str
    price: Price
    change_24h_pct: Decimal | None = None
    high_24h: Price | None = None
    low_24h: Price | None = None
    volume_24h: NonNegative | None = None
    quote_volume_24h: NonNegative | None = None
    timestamp: datetime

    @model_validator(mode="after")
    def _check_range(self) -> Self:
        if self.high_24h is not None and self.low_24h is not None:
            if self.low_24h > self.high_24h:
                raise ValueError("24h low is above 24h high")
        return self

    @property
    def age_seconds(self) -> float:
        return (datetime.now(UTC) - self.timestamp).total_seconds()


class Candle(Frozen):
    """One OHLCV bar, timestamped at its OPEN.

    Anchoring at the open is stated because it is the single most common source
    of off-by-one-bar errors in backtesting: mixing open- and close-stamped
    bars shifts every signal by one interval and makes a strategy look
    prescient.
    """

    symbol: str
    timeframe: Timeframe
    open_time: datetime
    open: Price
    high: Price
    low: Price
    close: Price
    volume: NonNegative
    quote_volume: NonNegative | None = None
    trades: int | None = Field(default=None, ge=0)
    closed: bool = True

    @model_validator(mode="after")
    def _check_ohlc(self) -> Self:
        # A bar whose high is below its open is not a data point, it is a bug
        # somewhere upstream — and it must not reach an indicator.
        if self.high < self.low:
            raise ValueError("high is below low")
        if not (self.low <= self.open <= self.high):
            raise ValueError("open is outside the high/low range")
        if not (self.low <= self.close <= self.high):
            raise ValueError("close is outside the high/low range")
        return self

    @property
    def close_time(self) -> datetime:
        return datetime.fromtimestamp(self.open_time.timestamp() + self.timeframe.seconds, tz=UTC)


class OrderBookLevel(Frozen):
    price: Price
    quantity: NonNegative


class OrderBook(Frozen):
    symbol: str
    bids: tuple[OrderBookLevel, ...]
    asks: tuple[OrderBookLevel, ...]
    timestamp: datetime

    @model_validator(mode="after")
    def _check_sides(self) -> Self:
        # Crossed books indicate a stitching error across venues far more often
        # than a genuine market state, so refuse rather than reason about them.
        if self.bids and self.asks and self.bids[0].price >= self.asks[0].price:
            raise ValueError("order book is crossed: best bid >= best ask")
        return self

    @property
    def best_bid(self) -> Decimal | None:
        return self.bids[0].price if self.bids else None

    @property
    def best_ask(self) -> Decimal | None:
        return self.asks[0].price if self.asks else None

    @property
    def spread_pct(self) -> Decimal | None:
        if self.best_bid is None or self.best_ask is None:
            return None
        mid = (self.best_bid + self.best_ask) / 2
        return (self.best_ask - self.best_bid) / mid * 100


class Provenance(Frozen):
    """Where a value came from, and whether it can be trusted.

    Carried alongside every payload rather than logged and forgotten. A number
    whose origin is unknown cannot be audited later, and this platform's whole
    claim is that its outputs are auditable.
    """

    provider: str
    fetched_at: datetime
    cached: bool = False
    stale: bool = False
    fallback_used: bool = False
    providers_tried: tuple[str, ...] = ()


T = TypeVar("T")


class Sourced(Frozen, Generic[T]):
    """A payload bound to its provenance."""

    data: T
    provenance: Provenance
