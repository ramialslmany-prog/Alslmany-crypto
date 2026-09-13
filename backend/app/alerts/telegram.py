"""Telegram notifications.

Asked for at the start of this project and lost in the rewrite, which is its
own small lesson: a feature nobody has a test for is a feature that quietly
does not survive a rebuild.

Four properties matter more than the feature itself.

**It can only tell.** This client sends messages. It reads no updates, accepts
no commands, and has no path back into the trading engine — so a compromised
bot token leaks the fact that a paper position opened, and nothing else. A
Telegram bot that can be *instructed* is a remote control for an account, and
this platform deliberately has no such thing.

**The token never leaves the server.** It lives in an environment variable,
never in a response and never in the page. `/api/config` reports whether alerts
are configured, not what they are configured with.

**A failed alert never costs a trade.** Notification is downstream of the
decision. Every send is wrapped, timed out, and swallowed into a log line,
because an exchange outage is a reason not to trade and a Telegram outage is
not.

**Unconfigured is a state, not an error.** With no token the client reports
`configured: False` and does nothing. It does not raise on every tick, and it
does not silently pretend to have sent anything either.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Protocol

import httpx

from app.core.logging import get_logger

logger = get_logger(__name__)

API = "https://api.telegram.org"
TIMEOUT_SECONDS = 5.0
# Telegram rejects anything longer, and truncating here beats a 400 that loses
# the whole message.
MAX_LENGTH = 4096


class Notifier(Protocol):
    async def send(self, text: str) -> bool: ...


@dataclass(frozen=True, slots=True)
class TelegramConfig:
    token: str | None
    chat_id: str | None

    @property
    def configured(self) -> bool:
        return bool(self.token and self.chat_id)


class TelegramNotifier:
    """Sends, and only sends."""

    def __init__(self, config: TelegramConfig, *, base_url: str = API) -> None:
        self.config = config
        self.base_url = base_url
        self.sent: list[str] = []
        self.failures = 0

    async def send(self, text: str) -> bool:
        if not self.config.configured:
            return False

        payload = {
            "chat_id": self.config.chat_id,
            "text": text[:MAX_LENGTH],
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }

        try:
            async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
                response = await client.post(
                    f"{self.base_url}/bot{self.config.token}/sendMessage",
                    json=payload,
                )
            if response.status_code >= 400:
                # The token is never logged, deliberately: a log line is the
                # most common place a secret ends up readable by people who
                # should not have it.
                self.failures += 1
                logger.warning(
                    "telegram rejected the message",
                    extra={"status": response.status_code},
                )
                return False
        except (TimeoutError, httpx.HTTPError) as exc:
            # Swallowed on purpose. An exchange outage is a reason not to
            # trade; a Telegram outage is not, and letting it propagate would
            # make the bot's behaviour depend on a chat service.
            self.failures += 1
            logger.warning("telegram send failed", extra={"error": type(exc).__name__})
            return False

        self.sent.append(text)
        return True


class NullNotifier:
    """What runs when alerts are not configured. Records, sends nothing."""

    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, text: str) -> bool:
        self.sent.append(text)
        return False


# --- message bodies ---------------------------------------------------------
#
# Assembled from the trade itself rather than written freely, so an alert
# cannot claim something the ledger does not say.


def _money(value: Decimal | None) -> str:
    return "—" if value is None else f"{value:,.2f}"


def opened(trade: Any) -> str:
    direction = "🟢 LONG" if trade.direction == "LONG" else "🔴 SHORT"
    return (
        f"<b>{direction} {trade.symbol}</b>  <i>paper</i>\n"
        f"Entry <code>{trade.entry}</code>\n"
        f"Stop <code>{trade.stop_loss}</code> · "
        f"Target <code>{trade.take_profit}</code>\n"
        f"Risk {_money(trade.risk_amount)} · R:R {trade.reward_risk}\n"
        f"Confidence {trade.confidence}\n"
        f"<i>{trade.reason[:300]}</i>"
    )


def closed(trade: Any, pnl: Decimal, r_multiple: Decimal) -> str:
    mark = "✅" if pnl > 0 else "❌" if pnl < 0 else "▪"
    reason = (trade.exit_reason or "closed").replace("_", " ")
    return (
        f"<b>{mark} {trade.symbol} closed</b>  <i>paper</i>\n"
        f"{trade.direction} {trade.entry} → {trade.exit_price}\n"
        f"P/L {_money(pnl)} ({r_multiple}R) · {reason}"
    )


def halted(blocks: list[dict[str, Any]]) -> str:
    lines = "\n".join(
        f"• {b['limit'].replace('_', ' ')}: {b['value']}% against {b['threshold']}% "
        f"— clears: {b['clears']}"
        for b in blocks
    )
    return f"<b>⛔ The bot has stopped trading</b>\n{lines}"
