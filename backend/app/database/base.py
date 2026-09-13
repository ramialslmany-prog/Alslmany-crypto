"""Declarative base and the columns every table carries."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.database.types import UtcDateTime


def utcnow() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    """All timestamps are timezone-aware UTC.

    Naive datetimes are banned throughout: a trading system that mixes local
    and UTC stamps misorders its own fills, and the bug surfaces months later
    as an unexplained performance figure.
    """


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        UtcDateTime(), default=utcnow, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime(),
        default=utcnow,
        onupdate=utcnow,
        server_default=func.now(),
        nullable=False,
    )
