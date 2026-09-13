"""Database tables for the paper-trading engine."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import JSON, Boolean, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base, TimestampMixin
from app.database.types import Money, UtcDateTime


class PaperTrade(Base, TimestampMixin):
    """One simulated trade, open or closed.

    Open and closed positions share a table rather than being split into two.
    Two tables would mean copying rows on close — and a copy that fails halfway
    loses the trade, while a copy that succeeds twice double-counts it. One row
    whose `status` changes cannot do either.

    The thesis is frozen at entry (`reason`, `evidence`, `confidence`). Judging a
    closed trade against an explanation regenerated afterwards is judging it
    against hindsight.
    """

    __tablename__ = "paper_trades"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    direction: Mapped[str] = mapped_column(String(8), nullable=False)  # LONG | SHORT
    status: Mapped[str] = mapped_column(String(16), nullable=False)  # open | closed
    timeframe: Mapped[str] = mapped_column(String(8), nullable=False)

    entry: Mapped[Decimal] = mapped_column(Money(), nullable=False)
    stop_loss: Mapped[Decimal] = mapped_column(Money(), nullable=False)
    take_profit: Mapped[Decimal] = mapped_column(Money(), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Money(), nullable=False)
    notional: Mapped[Decimal] = mapped_column(Money(), nullable=False)
    risk_amount: Mapped[Decimal] = mapped_column(Money(), nullable=False)
    reward_risk: Mapped[Decimal] = mapped_column(Money(), nullable=False)

    exit_price: Mapped[Decimal | None] = mapped_column(Money())
    pnl: Mapped[Decimal | None] = mapped_column(Money())
    pnl_pct: Mapped[Decimal | None] = mapped_column(Money())
    r_multiple: Mapped[Decimal | None] = mapped_column(Money())
    fees: Mapped[Decimal] = mapped_column(Money(), nullable=False, default=Decimal(0))

    result: Mapped[str | None] = mapped_column(String(16))  # WIN | LOSS | BREAKEVEN
    exit_reason: Mapped[str | None] = mapped_column(String(32))

    confidence: Mapped[Decimal] = mapped_column(Money(), nullable=False)
    strategy: Mapped[str] = mapped_column(String(64), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    evidence: Mapped[dict[str, Any] | None] = mapped_column(JSON)

    opened_at: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(UtcDateTime())

    # Always true. Stored rather than assumed so that a row can prove what it
    # was, independently of whatever the code says today.
    is_paper: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    __table_args__ = (
        Index("ix_paper_trades_status", "status", "symbol"),
        Index("ix_paper_trades_opened", "opened_at"),
    )

    @property
    def is_open(self) -> bool:
        return self.status == "open"


class PortfolioSnapshot(Base, TimestampMixin):
    """Equity over time, for the curve and the drawdown figure."""

    __tablename__ = "portfolio_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    balance: Mapped[Decimal] = mapped_column(Money(), nullable=False)
    equity: Mapped[Decimal] = mapped_column(Money(), nullable=False)
    open_positions: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    at: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False)

    __table_args__ = (Index("ix_portfolio_snapshots_at", "at"),)
