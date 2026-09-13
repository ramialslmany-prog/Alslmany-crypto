"""Per-client request budgets.

This is not politeness, it is correctness. Every public route here proxies to
Binance or OKX, and those venues count requests against *our* server's address,
not the visitor's. One script hammering `/api/market/overview` spends a quota
the whole deployment shares: the site starts failing for everyone, and from
Stage 6 onward the bot stops being able to manage open positions — which is a
far worse outcome than a stranger seeing HTTP 429.

Budgets are therefore sized by how much upstream work a route causes, not by
how expensive it is for us to serve.

A fixed window is used rather than a sliding log: it costs two integers per
client instead of a timestamp per request, and the burst it permits at a window
boundary is bounded and acceptable here. Counters live in memory, so each
process keeps its own — correct for a single instance, and the point at which
this should move to Redis is the point at which the deployment has several.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import JSONResponse


@dataclass(frozen=True, slots=True)
class Budget:
    """`limit` requests per `window` seconds."""

    limit: int
    window: float = 60.0


# Sized by upstream cost. `overview` fans out to every tracked symbol, so it is
# the most expensive thing a single request can trigger and is budgeted hardest.
BUDGETS: dict[str, Budget] = {
    "overview": Budget(limit=20),
    "candles": Budget(limit=60),
    "orderbook": Budget(limit=60),
    "ticker": Budget(limit=120),
    # A full scan analyses every symbol over 300 bars, so it is the most
    # expensive thing a single request can ask for.
    "signals": Budget(limit=20),
    "analysis": Budget(limit=40),
    # Opens and closes positions, and fans out across the whole universe.
    "bot_tick": Budget(limit=10),
    # The only CPU-bound route: a thousand-bar replay runs the full analyser a
    # thousand times. Budgeted on the machine's own capacity rather than on any
    # venue's quota, since it touches upstream exactly once.
    "backtest": Budget(limit=5),
    # Served from our own database, so upstream is not touched at all.
    "local": Budget(limit=300),
}

DEFAULT_BUDGET = Budget(limit=120)


def classify(path: str) -> str:
    if "/backtest" in path:
        return "backtest"
    if path.endswith("/bot/tick"):
        return "bot_tick"
    if path.endswith("/analysis"):
        return "analysis"
    if "/signals" in path:
        return "signals"
    if path.endswith("/overview"):
        return "overview"
    if path.endswith("/candles"):
        return "candles"
    if path.endswith("/orderbook"):
        return "orderbook"
    if path.endswith("/ticker"):
        return "ticker"
    return "local"


@dataclass
class _Window:
    started_at: float
    count: int = 0


@dataclass
class RateLimiter:
    budgets: dict[str, Budget] = field(default_factory=lambda: dict(BUDGETS))
    _windows: dict[tuple[str, str], _Window] = field(default_factory=dict)

    def check(self, client: str, category: str, now: float | None = None) -> tuple[bool, int, int]:
        """Return (allowed, remaining, retry_after_seconds)."""
        now = time.monotonic() if now is None else now
        budget = self.budgets.get(category, DEFAULT_BUDGET)
        key = (client, category)

        window = self._windows.get(key)
        if window is None or now - window.started_at >= budget.window:
            window = _Window(started_at=now)
            self._windows[key] = window

        retry_after = max(1, int(budget.window - (now - window.started_at)) + 1)

        if window.count >= budget.limit:
            return False, 0, retry_after

        window.count += 1
        return True, budget.limit - window.count, retry_after

    def prune(self, now: float | None = None) -> int:
        """Drop windows that have fully expired.

        Without this the dictionary grows one entry per client address seen,
        forever — a slow memory leak that only shows up in production.
        """
        now = time.monotonic() if now is None else now
        longest = max((b.window for b in self.budgets.values()), default=60.0)
        stale = [k for k, w in self._windows.items() if now - w.started_at >= longest]
        for key in stale:
            del self._windows[key]
        return len(stale)

    @property
    def tracked_clients(self) -> int:
        return len({client for client, _ in self._windows})


def client_key(request: Request) -> str:
    """Identify the caller.

    Behind a proxy the socket address is the proxy's, so the first hop in
    X-Forwarded-For is used when present. That header is client-controllable
    and therefore spoofable; it is acceptable here because the budget protects
    a shared upstream quota rather than authenticating anyone, and the
    alternative — bucketing every visitor behind one proxy together — would
    throttle real users for each other's traffic.
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    return request.client.host if request.client else "unknown"


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, limiter: RateLimiter | None = None) -> None:
        super().__init__(app)
        self.limiter = limiter or RateLimiter()
        self._requests_since_prune = 0

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        # Health and readiness are exempt: throttling them would make an
        # orchestrator believe the instance is unhealthy and recycle it.
        path = request.url.path
        if not path.startswith("/api") or path in ("/api/health", "/api/ready"):
            return await call_next(request)

        self._requests_since_prune += 1
        if self._requests_since_prune >= 1000:
            self._requests_since_prune = 0
            self.limiter.prune()

        category = classify(path)
        allowed, remaining, retry_after = self.limiter.check(client_key(request), category)
        budget = self.limiter.budgets.get(category, DEFAULT_BUDGET)

        if not allowed:
            # Standard headers, so a well-behaved client can back off instead of
            # retrying straight into the wall.
            return JSONResponse(
                status_code=429,
                content={
                    "error": {
                        "code": "rate_limited",
                        "message": (
                            f"Too many requests for {category}. "
                            f"Budget is {budget.limit} per {int(budget.window)}s."
                        ),
                    }
                },
                headers={
                    "Retry-After": str(retry_after),
                    "X-RateLimit-Limit": str(budget.limit),
                    "X-RateLimit-Remaining": "0",
                },
            )

        response = await call_next(request)
        response.headers["X-RateLimit-Limit"] = str(budget.limit)
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        return response
