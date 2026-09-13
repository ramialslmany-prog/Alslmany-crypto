"""Durable record of events an operator would need after the fact."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base, utcnow
from app.database.types import UtcDateTime


class SystemLog(Base):
    """Stdout is not an audit trail.

    Market-data outages are recorded here because "why did the bot stop opening
    positions on Tuesday" must be answerable from the database alone, long
    after the container that logged it was recycled.
    """

    __tablename__ = "system_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    level: Mapped[str] = mapped_column(String(16), nullable=False)
    category: Mapped[str] = mapped_column(String(64), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    context: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utcnow, nullable=False)

    __table_args__ = (Index("ix_system_logs_lookup", "category", "created_at"),)

    def __repr__(self) -> str:
        return f"<SystemLog {self.level} {self.category}>"
