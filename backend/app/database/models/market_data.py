"""Stored market data: OHLCV bars and point-in-time quotes."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base, TimestampMixin
from app.database.types import Money, UtcDateTime


class Candle(Base, TimestampMixin):
    """One OHLCV bar, timestamped at its open.

    The unique constraint on (symbol, timeframe, open_time) is what makes
    ingestion idempotent: re-fetching an overlapping window updates bars rather
    than duplicating them, so a retry after a partial failure cannot corrupt
    the series an indicator will read.
    """

    __tablename__ = "candles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    timeframe: Mapped[str] = mapped_column(String(8), nullable=False)
    open_time: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False)

    open: Mapped[Decimal] = mapped_column(Money(), nullable=False)
    high: Mapped[Decimal] = mapped_column(Money(), nullable=False)
    low: Mapped[Decimal] = mapped_column(Money(), nullable=False)
    close: Mapped[Decimal] = mapped_column(Money(), nullable=False)
    volume: Mapped[Decimal] = mapped_column(Money(), nullable=False)
    quote_volume: Mapped[Decimal | None] = mapped_column(Money())
    trades: Mapped[int | None] = mapped_column(Integer)

    # A forming bar is stored so the UI can draw it, and flagged so the
    # analysis engine can decline to fire a signal on an incomplete candle.
    is_closed: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    source: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (
        UniqueConstraint("symbol", "timeframe", "open_time", name="uq_candle_series"),
        Index("ix_candles_lookup", "symbol", "timeframe", "open_time"),
    )

    def __repr__(self) -> str:
        return f"<Candle {self.symbol} {self.timeframe} {self.open_time.isoformat()}>"


class TickerSnapshot(Base, TimestampMixin):
    """A quote as it was at one instant, kept for audit.

    Every later claim the platform makes about why it acted has to be checkable
    against the prices it actually saw, not against prices refetched afterwards.
    """

    __tablename__ = "ticker_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    price: Mapped[Decimal] = mapped_column(Money(), nullable=False)
    change_24h_pct: Mapped[Decimal | None] = mapped_column(Money())
    high_24h: Mapped[Decimal | None] = mapped_column(Money())
    low_24h: Mapped[Decimal | None] = mapped_column(Money())
    volume_24h: Mapped[Decimal | None] = mapped_column(Money())
    quote_volume_24h: Mapped[Decimal | None] = mapped_column(Money())

    observed_at: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False)
    source: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (Index("ix_ticker_symbol_time", "symbol", "observed_at"),)

    def __repr__(self) -> str:
        return f"<TickerSnapshot {self.symbol} {self.price}>"
