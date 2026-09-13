"""Durable record of events an operator needs after the fact.

stdout is not an audit trail. When someone asks in three weeks why the platform
stopped opening positions on a Tuesday, the answer has to be recoverable from
the database — long after the container that printed the log line was recycled.

Writing here must never be able to break the thing it is recording. A failure to
store an event is logged and swallowed: an outage report that itself throws
would turn a degraded feed into a failed request.
"""

from __future__ import annotations

from typing import Any

from app.core.logging import get_logger
from app.database.models.system_log import SystemLog
from app.database.session import session_scope

logger = get_logger(__name__)

# Categories are a closed set so they stay queryable. Free-form strings drift
# into near-duplicates ("market-data", "market_data", "marketdata") and make the
# table impossible to aggregate.
MARKET_DATA_OUTAGE = "market_data.outage"
MARKET_DATA_STALE = "market_data.stale"
MARKET_DATA_RECOVERED = "market_data.recovered"


async def record(level: str, category: str, message: str, **context: Any) -> None:
    try:
        async with session_scope() as session:
            session.add(
                SystemLog(
                    level=level.upper(),
                    category=category,
                    message=message,
                    context=context or None,
                )
            )
    except Exception:
        logger.exception("could not persist system log", extra={"category": category})
