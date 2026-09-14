"""Column types that keep money exact.

``Decimal`` is only worth using if it survives the round trip to storage.
PostgreSQL has NUMERIC and does; SQLite has no real decimal type and SQLAlchemy
falls back to float there, which silently reintroduces the binary-fraction
error this system exists to avoid — a stop-loss read back as 107799.99999999
prices every position wrong.

So the value is stored as TEXT on SQLite and NUMERIC on PostgreSQL, and comes
back a Decimal on both.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import DateTime, Dialect, Numeric, String, TypeDecorator


class Money(TypeDecorator):
    """An exact decimal, on any backend."""

    impl = Numeric
    cache_ok = True

    def __init__(self, precision: int = 38, scale: int = 18) -> None:
        self.precision = precision
        self.scale = scale
        super().__init__(precision=precision, scale=scale, asdecimal=True)

    def load_dialect_impl(self, dialect: Dialect) -> Any:
        if dialect.name == "sqlite":
            return dialect.type_descriptor(String(64))
        return dialect.type_descriptor(Numeric(self.precision, self.scale, asdecimal=True))

    def process_bind_param(self, value: Any, dialect: Dialect) -> Any:
        if value is None:
            return None
        if not isinstance(value, Decimal):
            value = Decimal(str(value))
        return str(value) if dialect.name == "sqlite" else value

    def process_result_value(self, value: Any, dialect: Dialect) -> Decimal | None:
        if value is None:
            return None
        return value if isinstance(value, Decimal) else Decimal(str(value))


class UtcDateTime(TypeDecorator):
    """A timestamp that is timezone-aware UTC on the way out, on every backend.

    ``DateTime(timezone=True)`` does not deliver this. PostgreSQL honours it,
    but SQLite has no timestamp type and SQLAlchemy stores an ISO string, so
    the value returns *naive* — and naive-vs-aware comparison either raises or,
    worse, silently sorts wrong. For a system whose ordering of fills decides
    reported P/L, "works on Postgres, subtly wrong on SQLite" is not acceptable
    in a type used by every table.

    Naive input is rejected rather than assumed to be UTC: guessing is how a
    local-time stamp enters the database in the first place.
    """

    impl = DateTime
    cache_ok = True

    def __init__(self, timezone: bool = True) -> None:
        # The keyword is accepted, and ignored, on purpose. Alembic's
        # autogenerate renders this column as `UtcDateTime(timezone=True)`
        # because that is what the underlying impl reports, and a type that
        # cannot be reconstructed from its own rendered form breaks every
        # generated migration. Timezone awareness is not optional here, so the
        # argument cannot turn it off.
        del timezone
        super().__init__(timezone=True)

    def process_bind_param(self, value: Any, dialect: Dialect) -> Any:
        if value is None:
            return None
        if not isinstance(value, datetime):
            raise TypeError(f"expected datetime, got {type(value).__name__}")
        if value.tzinfo is None:
            raise ValueError("naive datetime rejected: timestamps must carry an explicit timezone")
        return value.astimezone(UTC)

    def process_result_value(self, value: Any, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)
