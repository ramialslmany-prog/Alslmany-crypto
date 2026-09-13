"""Collapse concurrent identical fetches into one upstream call.

Without this, a cache miss is a stampede. Twenty requests for BTCUSDT arriving
in the same instant all find the cache empty, and all twenty go to the
exchange — so the cache does nothing precisely when load is highest, which is
when it matters. Exchanges rate-limit by *our* server's address rather than the
visitor's, so the stampede spends a shared quota and can get the whole
deployment throttled, which in later stages would stop the bot from managing
open positions.

The first caller for a key does the work; everyone arriving while it is in
flight awaits the same result, success or failure alike.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Generic, TypeVar

T = TypeVar("T")


class SingleFlight(Generic[T]):
    def __init__(self) -> None:
        self._in_flight: dict[str, asyncio.Task[T]] = {}

    async def do(self, key: str, fn: Callable[[], Awaitable[T]]) -> T:
        existing = self._in_flight.get(key)
        if existing is not None:
            # shield() is deliberate: if the caller that started the fetch is
            # cancelled (client disconnects, request times out), the followers
            # must not inherit that cancellation and fail for a reason that has
            # nothing to do with them.
            return await asyncio.shield(existing)

        task: asyncio.Task[T] = asyncio.create_task(fn())
        self._in_flight[key] = task
        try:
            return await asyncio.shield(task)
        finally:
            # Cleared only by the originator, and only once the task is done,
            # so a follower can never be handed a task that has already been
            # removed and awaited to completion elsewhere.
            if task.done():
                self._in_flight.pop(key, None)

    @property
    def in_flight(self) -> int:
        return len(self._in_flight)
