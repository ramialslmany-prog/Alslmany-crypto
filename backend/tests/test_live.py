"""The live feed.

The interesting behaviour is not "a message arrives" — it is what happens when
nobody is watching, when one client falls behind, and when the feed dies. Those
are the three ways a live feed goes wrong in production and the three things a
happy-path test would never see.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.api.live import QUEUE_DEPTH, Hub


class FakeApp:
    """Just enough app for the hub: settings, a market service, nothing else."""

    def __init__(self, snapshot) -> None:
        self.state = type("S", (), {})()
        self._snapshot = snapshot


class SilentHub(Hub):
    """A hub whose broadcaster produces nothing on its own.

    The queue-discipline tests are about `publish`, so the real fetch loop must
    not race them by injecting frames of its own — and `FakeApp` has no market
    service for it to fetch from anyway.
    """

    async def _snapshot(self):
        # Waits on the hub's own stop event rather than the clock, so teardown
        # is immediate. A plain long sleep would make `leave()` wait out its
        # shutdown grace on every one of these tests.
        await self.stopping.wait()
        return {"kind": "tick"}


@pytest.fixture
async def hub():
    """Always torn down.

    Setting `hub.task = None` at the end of a test ORPHANS a running broadcast
    loop rather than stopping it: the task survives the test, keeps waking every
    tick, and outlives the event loop it was created on. `leave()` cancels it.
    """
    instance = SilentHub(FakeApp(None))
    yield instance
    for queue in list(instance.clients):
        await instance.leave(queue)


# --- the queue discipline ---------------------------------------------------


async def test_a_slow_client_loses_the_oldest_update_not_the_newest(hub):
    """A client two ticks behind wants the current price, not the one from ten
    seconds ago. Dropping the newest would hand it permanently stale data."""
    queue = await hub.join()

    for i in range(QUEUE_DEPTH + 3):
        hub.publish({"kind": "tick", "n": i})

    received = []
    while not queue.empty():
        received.append(queue.get_nowait()["n"])

    assert len(received) == QUEUE_DEPTH
    assert received[-1] == QUEUE_DEPTH + 2, "the newest update was dropped"
    assert hub.dropped == 3


async def test_one_stalled_client_does_not_block_the_others(hub):
    """Awaiting a blocked socket inside the broadcast loop would freeze the feed
    for everyone. The publish path never awaits."""
    stalled = await hub.join()
    healthy = await hub.join()

    for i in range(QUEUE_DEPTH + 5):
        hub.publish({"n": i})
        # The healthy client keeps draining; the stalled one never does.
        if not healthy.empty():
            healthy.get_nowait()

    assert stalled.full()
    assert healthy.qsize() <= QUEUE_DEPTH


# --- sleeping when nobody is watching ---------------------------------------


async def test_the_broadcaster_stops_when_the_last_client_leaves():
    """A background task quietly spending an exchange quota for an audience of
    nobody is a bug that only shows up on the bill."""
    ticks = 0

    class CountingHub(Hub):
        async def _snapshot(self):
            nonlocal ticks
            ticks += 1
            return {"kind": "tick"}

    hub = CountingHub(FakeApp(None))

    first = await hub.join()
    second = await hub.join()
    assert hub.task is not None and not hub.task.done()

    await hub.leave(first)
    assert hub.task is not None, "the feed stopped while a client was still connected"

    await hub.leave(second)
    assert hub.task is None

    before = ticks
    await asyncio.sleep(0.05)
    assert ticks == before, "the broadcaster kept polling with no clients"


async def test_one_broadcaster_serves_every_client():
    """Per-connection polling would multiply the venue's rate limit by the
    number of open tabs."""
    calls = 0

    class CountingHub(Hub):
        async def _snapshot(self):
            nonlocal calls
            calls += 1
            return {"kind": "tick"}

    hub = CountingHub(FakeApp(None))
    queues = [await hub.join() for _ in range(5)]

    await asyncio.sleep(0.02)
    assert calls <= 1, f"{calls} fetches for one tick across 5 clients"

    for q in queues:
        await hub.leave(q)


# --- surviving a bad tick ---------------------------------------------------


async def test_a_failing_snapshot_is_reported_and_the_feed_keeps_running():
    """A feed that stops on the first bad tick is worse than one that says the
    tick was bad: the screen silently freezes on old numbers."""

    class BrokenHub(Hub):
        async def _snapshot(self):
            raise RuntimeError("provider exploded")

    hub = BrokenHub(FakeApp(None))
    queue = await hub.join()

    message = await asyncio.wait_for(queue.get(), timeout=2.0)
    assert message["kind"] == "error"
    assert hub.task is not None and not hub.task.done(), "the loop died on one failure"

    await hub.leave(queue)


# --- the end-to-end contract ------------------------------------------------


def test_the_socket_sends_a_frame_immediately_and_never_invents_a_price(api_app):
    """Two guarantees in one connection.

    A dashboard showing nothing for five seconds after connecting looks broken,
    so the first frame goes out at once. And when the feed is unavailable the
    message says so and carries NO prices — the rule the whole platform is
    built on does not weaken because the transport changed.
    """
    app, stub = api_app

    with TestClient(app) as client:
        with client.websocket_connect("/ws") as socket:
            first = socket.receive_json()
            assert first["kind"] == "tick"
            assert {p["symbol"] for p in first["prices"]} == {"BTCUSDT", "ETHUSDT"}
            assert first["feed_healthy"] is True
            assert first["account"]["balance"] == "10000.00"

        stub.fail = True
        with client.websocket_connect("/ws") as socket:
            frame = socket.receive_json()
            assert frame["prices"] == []
            assert frame["feed_healthy"] is False
            assert {u["symbol"] for u in frame["unavailable"]} == {"BTCUSDT", "ETHUSDT"}
            # Not a zero, not a remembered value, not a key at all.
            assert all("price" not in u for u in frame["unavailable"])


async def test_leaving_lets_an_in_flight_snapshot_finish():
    """Cancelling the loop mid-query abandons a checked-out database connection.

    SQLAlchemy warns about exactly that, and enough connect/disconnect cycles
    would drain the pool — so the loop is stopped by an event and the departing
    client waits for the read to complete.
    """
    started = asyncio.Event()
    finished = False

    class SlowHub(Hub):
        async def _snapshot(self):
            nonlocal finished
            started.set()
            await asyncio.sleep(0.1)
            finished = True
            return {"kind": "tick"}

    hub = SlowHub(FakeApp(None))
    queue = await hub.join()
    await asyncio.wait_for(started.wait(), timeout=2.0)

    await hub.leave(queue)

    assert finished, "the snapshot was cancelled mid-flight"
    assert hub.task is None


async def test_a_wedged_snapshot_cannot_stall_a_disconnect(monkeypatch):
    """The backstop. Waiting unboundedly would let one hung provider call turn a
    client disconnect into a deadlock, so an overrunning snapshot is cancelled
    after all — accepting the connection leak rather than the hang."""
    import app.api.live as live_module

    class WedgedHub(Hub):
        async def _snapshot(self):
            await asyncio.sleep(3600)

    monkeypatch.setattr(live_module, "SHUTDOWN_GRACE", 0.1)

    hub = WedgedHub(FakeApp(None))
    queue = await hub.join()
    await asyncio.sleep(0.02)

    # Would raise if `leave` waited on the wedged snapshot instead of bounding it.
    await asyncio.wait_for(hub.leave(queue), timeout=3.0)
    assert hub.task is None
