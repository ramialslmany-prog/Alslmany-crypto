"""The tradable universe.

A row here is what makes a symbol known to the platform. Adding a coin is a
row plus a config entry — never a code change — which is the property Stage 1
was asked to guarantee.
"""

from __future__ import annotations

from sqlalchemy import Boolean, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base, TimestampMixin


class Coin(Base, TimestampMixin):
    __tablename__ = "coins"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    base_asset: Mapped[str] = mapped_column(String(16), nullable=False)
    quote_asset: Mapped[str] = mapped_column(String(16), nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(64))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # Lower sorts first in the UI; ties fall back to symbol.
    sort_order: Mapped[int] = mapped_column(Integer, default=100, nullable=False)

    __table_args__ = (Index("ix_coins_active_sort", "is_active", "sort_order"),)

    def __repr__(self) -> str:
        return f"<Coin {self.symbol}>"
