"""A small TTL cache with an explicit stale tier.

Two tiers, because "fresh" and "gone" are not the only states a quote can be
in. A value past its TTL is not automatically worthless — served knowingly and
labelled stale, it still beats a blank screen. Served silently, it is a lie.
Callers must ask for stale data on purpose, and what they get says so.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Generic, TypeVar

T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class CacheHit(Generic[T]):
    value: T
    age_seconds: float
    stale: bool


class TtlCache(Generic[T]):
    def __init__(self, ttl_seconds: float, *, max_stale_seconds: float = 300.0) -> None:
        self._ttl = ttl_seconds
        self._max_stale = max_stale_seconds
        self._entries: dict[str, tuple[float, T]] = {}

    @property
    def enabled(self) -> bool:
        return self._ttl > 0

    def get(self, key: str, *, allow_stale: bool = False) -> CacheHit[T] | None:
        # A zero or negative TTL means the operator turned caching off. Treating
        # it as "instantly expired" instead would leave every entry eligible for
        # the stale tier, so disabling the cache would silently start serving
        # older data than leaving it on — the opposite of the intent.
        if not self.enabled:
            return None
        entry = self._entries.get(key)
        if entry is None:
            return None
        stored_at, value = entry
        age = time.monotonic() - stored_at

        if age <= self._ttl:
            return CacheHit(value=value, age_seconds=age, stale=False)
        if allow_stale and age <= self._max_stale:
            return CacheHit(value=value, age_seconds=age, stale=True)
        if age > self._max_stale:
            # Beyond the stale window it is not a cache entry any more.
            self._entries.pop(key, None)
        return None

    def set(self, key: str, value: T) -> None:
        if not self.enabled:
            return
        self._entries[key] = (time.monotonic(), value)

    def invalidate(self, key: str) -> None:
        self._entries.pop(key, None)

    def clear(self) -> None:
        self._entries.clear()

    def __len__(self) -> int:
        return len(self._entries)
