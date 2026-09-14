"""Live updates over a WebSocket.

Polling was the Stage 7 mechanism and it has two costs. The screen is up to
twenty seconds stale, and every open tab is its own client hitting the API on
its own timer — so the upstream load a deployment causes grows with the number
of people watching it, which is exactly what the rate-limit module exists to
stop.

Four decisions shape this module, and each is a place where a naive live feed
goes wrong.

**One producer, many consumers.** A fetch loop per connection would multiply
the venue's rate limit by the number of viewers. A single broadcaster polls
once and fans the result out, so a hundred tabs cost what one costs.

**It sleeps when nobody is watching.** The broadcaster starts on the first
connection and stops after the last one leaves. A background task quietly
spending an exchange quota for an audience of nobody is a bug that only shows
up on the bill.

**A slow client cannot stall the others.** Each connection has a small bounded
queue; when it fills, the OLDEST update is dropped rather than the newest,
because a stale tick has no value and the current one does. Awaiting a blocked
socket inside the broadcast loop would let one bad connection freeze the feed
for everyone.

**It never invents a price.** The rule the whole platform is built on does not
weaken because the transport changed. When the feed fails, the message says the
feed failed and carries no prices at all — not the last ones it happened to
remember, and not a zero.
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.errors import MarketDataError
from app.core.logging import get_logger
from app.database.session import session_scope
from app.paper.portfolio import performance, portfolio_state
from app.paper.store import RiskOverrideRepository, TradeRepository
from app.risk.manager import RiskLimits, RiskManager

logger = get_logger(__name__)
router = APIRouter()

# Fast enough that the desk feels live, slow enough that five symbols stay well
# inside every venue's quota with room for the bot's own requests.
TICK_SECONDS = 5.0

# Two updates of slack. A client that cannot keep up with a five-second tick is
# not going to be rescued by a deeper buffer; it is going to be handed older
# and older prices.
QUEUE_DEPTH = 2

# How long a departing client waits for an in-flight snapshot to finish before
# the loop is cancelled instead. Comfortably longer than a healthy read, short
# enough that a wedged provider cannot stall a disconnect.
SHUTDOWN_GRACE = 10.0


class Hub:
    """The connections, the broadcaster, and the rule that it sleeps when idle."""

    def __init__(self, app) -> None:
        self.app = app
        self.clients: set[asyncio.Queue[dict[str, Any]]] = set()
        self.task: asyncio.Task | None = None
        self.dropped = 0
        # The loop is stopped by setting this, never by cancelling the task.
        # Cancelling it mid-query abandons a database connection that is
        # checked out and never returned — SQLAlchemy warns about exactly that,
        # and enough connect/disconnect cycles would drain the pool.
        self.stopping = asyncio.Event()

    async def join(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=QUEUE_DEPTH)
        self.clients.add(queue)
        if self.task is None or self.task.done():
            self.stopping.clear()
            self.task = asyncio.create_task(self._broadcast_loop())
            logger.info("live feed started", extra={"clients": len(self.clients)})
        return queue

    async def leave(self, queue: asyncio.Queue) -> None:
        self.clients.discard(queue)
        if not self.clients and self.task is not None:
            self.stopping.set()
            # Awaited rather than cancelled, so an in-flight snapshot finishes
            # and hands its connection back. Bounded by one read, not by the
            # tick interval: the sleep below is interruptible.
            #
            # The timeout is the backstop. Waiting unboundedly would let one
            # wedged provider call turn a client disconnect into a hang, so a
            # snapshot that overruns is cancelled after all — accepting the
            # connection leak rather than the deadlock.
            try:
                await asyncio.wait_for(self.task, timeout=SHUTDOWN_GRACE)
            except (TimeoutError, asyncio.CancelledError):
                self.task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self.task
            self.task = None
            logger.info("live feed stopped; no clients remain")

    def publish(self, message: dict[str, Any]) -> None:
        for queue in list(self.clients):
            if queue.full():
                # Drop the OLDEST, not the newest. A client behind by two ticks
                # wants the current price, not the one from ten seconds ago.
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
                self.dropped += 1
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(message)

    async def _broadcast_loop(self) -> None:
        while not self.stopping.is_set():
            try:
                self.publish(await self._snapshot())
            except asyncio.CancelledError:
                raise
            except Exception:
                # The loop must outlive any single failure: a feed that stops
                # on the first bad tick is worse than one that reports it.
                logger.exception("live snapshot failed")
                self.publish(
                    {
                        "kind": "error",
                        "at": datetime.now(UTC).isoformat(),
                        "message": "The live snapshot could not be built.",
                    }
                )
            # An interruptible sleep: waiting on the stop event rather than the
            # clock means shutdown is immediate without cancelling anything.
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.stopping.wait(), timeout=TICK_SECONDS)

    async def _snapshot(self) -> dict[str, Any]:
        settings = self.app.state.settings
        market = self.app.state.market_service

        symbols = settings.symbol_list
        result = await market.snapshot_all(symbols)
        quotes = result["quotes"]
        failures = result["failures"]

        prices = [
            {
                "symbol": symbol,
                "price": str(sourced.data.price),
                "change_24h_pct": str(sourced.data.change_24h_pct),
                "source": sourced.provenance.provider,
                # A stale value was real when it was fetched. It is labelled,
                # never passed off as current.
                "stale": sourced.provenance.stale,
            }
            for symbol, sourced in quotes.items()
        ]

        return {
            "kind": "tick",
            "at": datetime.now(UTC).isoformat(),
            "feed_healthy": bool(quotes) and not any(s.provenance.stale for s in quotes.values()),
            # Symbols that could not be read appear here rather than being
            # dropped: a missing row and a stale row mean different things.
            "unavailable": [{"symbol": s, "code": c} for s, c in failures.items()],
            "prices": prices,
            "account": await self._account(settings),
        }

    async def _account(self, settings) -> dict[str, Any]:
        """Balance, equity and the halt state, read from the ledger.

        Marks are deliberately left empty: this runs every five seconds, and
        quoting every open position on every tick would multiply upstream load
        by the size of the book. Open positions are carried at entry here, which
        `portfolio_state` documents as the conservative read — the Open tab is
        where marked-to-market numbers live.
        """
        async with session_scope() as session:
            trades = await TradeRepository(session).all()
            override = await RiskOverrideRepository(session).latest_drawdown_reset()

        state = portfolio_state(
            trades=trades,
            starting_balance=settings.initial_balance_usdt,
            marks={},
            peak_reset=(None if override is None else (override.at, override.baseline_equity)),
        )
        limits = RiskLimits(
            risk_per_trade_pct=settings.risk_per_trade_pct,
            max_open_trades=settings.max_open_trades,
            max_daily_loss_pct=settings.max_daily_loss_pct,
            max_drawdown_pct=settings.max_drawdown_pct,
            max_portfolio_heat_pct=settings.max_portfolio_heat_pct,
        )
        closed = [t for t in trades if t.status == "closed"]

        return {
            "balance": str(state.balance),
            "equity": str(state.equity),
            "open_positions": len([t for t in trades if t.status == "open"]),
            "realised_today": str(state.realised_today),
            "total_pnl": str(performance(closed, settings.initial_balance_usdt).total_pnl),
            "halt": RiskManager(limits).halt_state(state),
        }


def get_hub(app) -> Hub:
    hub = getattr(app.state, "live_hub", None)
    if hub is None:
        hub = Hub(app)
        app.state.live_hub = hub
    return hub


@router.websocket("/ws")
async def live(websocket: WebSocket) -> None:
    await websocket.accept()
    hub = get_hub(websocket.app)
    queue = await hub.join()

    # The first frame goes out immediately rather than after a full tick: a
    # dashboard that shows nothing for five seconds after connecting looks
    # broken, and "broken" is what a user acts on.
    try:
        await websocket.send_json(await hub._snapshot())
    except MarketDataError as exc:
        await websocket.send_json(
            {
                "kind": "error",
                "at": datetime.now(UTC).isoformat(),
                "code": exc.code,
                "message": "No reliable market data. No prices are sent.",
            }
        )
    except WebSocketDisconnect:
        await hub.leave(queue)
        return

    try:
        while True:
            await websocket.send_json(await queue.get())
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception:
        logger.exception("live connection failed")
    finally:
        await hub.leave(queue)
