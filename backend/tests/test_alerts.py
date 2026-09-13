"""Telegram alerts.

A feature nobody had a test for is a feature that quietly did not survive the
rewrite — which is how this one went missing in the first place.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import httpx

from app.alerts import telegram
from app.alerts.telegram import (
    MAX_LENGTH,
    NullNotifier,
    TelegramConfig,
    TelegramNotifier,
)
from app.paper.models import PaperTrade


def trade(**overrides) -> PaperTrade:
    row = PaperTrade(
        symbol="BTCUSDT",
        direction="LONG",
        status="open",
        timeframe="1h",
        entry=Decimal("108150.25"),
        stop_loss=Decimal("106800.00"),
        take_profit=Decimal("112000.00"),
        quantity=Decimal("0.074"),
        notional=Decimal("8003.12"),
        risk_amount=Decimal("100"),
        reward_risk=Decimal("2.85"),
        fees=Decimal("3.20"),
        confidence=Decimal("84"),
        strategy="multi-factor-v1",
        reason="Bullish: trend-strong_up, price-above-ema20.",
        opened_at=datetime.now(UTC),
        is_paper=True,
    )
    for key, value in overrides.items():
        setattr(row, key, value)
    return row


# --- unconfigured is a state, not an error ---------------------------------


async def test_with_no_token_it_does_nothing_and_says_so():
    """Not an exception on every tick, and not a silent pretence of sending."""
    quiet = TelegramNotifier(TelegramConfig(token=None, chat_id=None))

    assert quiet.config.configured is False
    assert await quiet.send("hello") is False
    assert quiet.sent == []


async def test_a_token_without_a_chat_id_is_not_configured():
    half = TelegramNotifier(TelegramConfig(token="t", chat_id=None))
    assert half.config.configured is False
    assert await half.send("hello") is False


async def test_the_null_notifier_records_without_sending():
    null = NullNotifier()
    assert await null.send("x") is False
    assert null.sent == ["x"]


# --- failures never reach the trading path ---------------------------------


async def test_a_network_failure_is_swallowed_not_raised(monkeypatch):
    """An exchange outage is a reason not to trade. A chat outage is not, and
    letting it propagate would make the bot's behaviour depend on Telegram."""

    class Boom:
        def __init__(self, *a, **kw): ...
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **kw):
            raise httpx.ConnectError("no route")

    monkeypatch.setattr(httpx, "AsyncClient", Boom)
    client = TelegramNotifier(TelegramConfig(token="t", chat_id="c"))

    assert await client.send("hello") is False
    assert client.failures == 1


async def test_a_rejection_is_counted_and_the_token_is_never_logged(monkeypatch, caplog):
    class Rejects:
        def __init__(self, *a, **kw): ...
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **kw):
            return httpx.Response(401, json={"description": "Unauthorized"})

    monkeypatch.setattr(httpx, "AsyncClient", Rejects)
    client = TelegramNotifier(TelegramConfig(token="super-secret-token", chat_id="c"))

    with caplog.at_level("WARNING"):
        assert await client.send("hello") is False

    assert client.failures == 1
    # A log line is the most common place a secret becomes readable by people
    # who should not have it.
    assert "super-secret-token" not in caplog.text


async def test_a_successful_send_is_recorded(monkeypatch):
    captured: dict = {}

    class Accepts:
        def __init__(self, *a, **kw): ...
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, **kw):
            captured["url"] = url
            captured["json"] = json
            return httpx.Response(200, json={"ok": True})

    monkeypatch.setattr(httpx, "AsyncClient", Accepts)
    client = TelegramNotifier(TelegramConfig(token="tok", chat_id="42"))

    assert await client.send("hello") is True
    assert captured["json"]["chat_id"] == "42"
    assert captured["url"].endswith("/bottok/sendMessage")
    assert client.sent == ["hello"]


async def test_an_overlong_message_is_truncated_rather_than_rejected(monkeypatch):
    captured: dict = {}

    class Accepts:
        def __init__(self, *a, **kw): ...
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, **kw):
            captured["json"] = json
            return httpx.Response(200, json={"ok": True})

    monkeypatch.setattr(httpx, "AsyncClient", Accepts)
    client = TelegramNotifier(TelegramConfig(token="t", chat_id="c"))

    await client.send("x" * (MAX_LENGTH + 500))
    assert len(captured["json"]["text"]) == MAX_LENGTH


# --- the messages themselves ------------------------------------------------


def test_an_open_alert_carries_the_plan_and_says_it_is_paper():
    text = telegram.opened(trade())

    assert "BTCUSDT" in text and "LONG" in text
    assert "108150.25" in text and "106800.00" in text
    assert "paper" in text.lower(), "an alert that omits this reads as a real fill"


def test_a_close_alert_reports_the_result_without_dressing_it_up():
    losing = trade(exit_price=Decimal("106800.00"), exit_reason="stop_loss")
    text = telegram.closed(losing, Decimal("-100.00"), Decimal("-1.00"))

    assert "-100.00" in text and "-1.00R" in text
    assert "stop loss" in text
    assert "paper" in text.lower()


def test_a_halt_alert_names_the_limit_and_whether_it_clears_itself():
    text = telegram.halted(
        [
            {
                "limit": "max_drawdown",
                "value": "12.17",
                "threshold": "10",
                "clears": "manual",
            }
        ]
    )

    assert "max drawdown" in text
    assert "12.17" in text and "10" in text
    assert "manual" in text


def test_messages_are_built_from_the_trade_not_written_freely():
    """An alert must not be able to claim something the ledger does not say."""
    row = trade(symbol="ETHUSDT", direction="SHORT")
    text = telegram.opened(row)

    assert "ETHUSDT" in text
    assert "SHORT" in text
    assert "LONG" not in text
