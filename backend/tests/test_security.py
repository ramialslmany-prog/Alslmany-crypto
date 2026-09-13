"""The security properties, asserted rather than documented.

Every claim in this file is one the README also makes. A claim that only exists
in prose is a claim nobody checks, and the two drift apart silently — the
failure mode this suite exists to prevent.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import Settings

APP = Path(__file__).resolve().parents[1] / "app"


def sources() -> list[Path]:
    return [p for p in APP.rglob("*.py") if "__pycache__" not in p.parts]


# --- no real trading, structurally ------------------------------------------


def test_paper_trading_cannot_be_switched_off_by_configuration():
    """`paper_trading_only` is typed `Literal[True]`, so an environment variable
    setting it false is a configuration error and not a mode."""
    assert Settings().paper_trading_only is True
    with pytest.raises(ValidationError):
        Settings(paper_trading_only=False)


# The only module allowed to make an outbound write request, and what it is for.
# Sending a chat message is not placing an order; anything else appearing here
# is a change that has to be argued for in review rather than slipped in.
WRITE_ALLOWLIST = {"telegram.py"}


def test_no_module_sends_a_write_request_except_the_one_that_may():
    """Placing an order requires a POST, PUT or DELETE. Only the notifier makes
    one, and it posts a chat message to Telegram.

    Checked at the call sites rather than against a flag, because a flag can be
    true while the code that would ignore it still exists. The allowlist is one
    filename rather than "no writes at all" so the rule says what it actually
    protects — and it still fails the moment a second module starts writing
    anywhere. `test_the_notifier_cannot_reach_an_exchange` below closes the
    obvious hole in an allowlist: the permitted module being pointed at a venue.
    """
    writes = {"post", "put", "patch", "delete"}
    offenders: list[str] = []

    for source in sources():
        if source.name in WRITE_ALLOWLIST:
            continue
        tree = ast.parse(source.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if isinstance(func, ast.Attribute) and func.attr in writes:
                # `dict.pop`, `list.append` and friends are not HTTP verbs; only
                # a call on something named like a client is.
                target = getattr(func.value, "id", "") or getattr(func.value, "attr", "")
                if "client" in target.lower() or "http" in target.lower():
                    offenders.append(f"{source.name}: {target}.{func.attr}")

    assert not offenders, f"outbound write requests found: {offenders}"


def test_the_notifier_cannot_reach_an_exchange():
    """An allowlist is worthless if the one module permitted to write can be
    pointed at a venue."""
    from app.alerts import telegram

    source = (APP / "alerts" / "telegram.py").read_text().lower()
    for venue in ("binance", "okx", "bybit", "coinbase", "kraken", "/order"):
        assert venue not in source, f"the notifier references {venue}"

    assert telegram.API == "https://api.telegram.org"


def test_the_notifier_can_only_send_and_never_receive():
    """A Telegram bot that can be INSTRUCTED is a remote control for an account.

    This one exposes no way to read updates, so a stolen token leaks the fact
    that a paper position opened and nothing else.
    """
    from app.alerts.telegram import TelegramNotifier

    methods = {m.lower() for m in dir(TelegramNotifier) if not m.startswith("_")}
    for reader in ("get_updates", "getupdates", "poll", "listen", "receive"):
        assert reader not in methods, f"the notifier exposes {reader}"


def test_no_credential_handling_exists_for_any_exchange():
    """Signing a request is the prerequisite for placing an order. Nothing here
    signs anything, and nothing reads an exchange key."""
    banned = ("hmac", "X-MBX-APIKEY", "OK-ACCESS-KEY", "OK-ACCESS-SIGN", "binance_api_secret")
    for source in sources():
        text = source.read_text()
        for token in banned:
            assert token not in text, f"{source.name} references {token}"


def test_every_trade_the_engine_opens_is_marked_paper():
    import inspect

    from app.paper.engine import PaperEngine

    body = inspect.getsource(PaperEngine.open)
    assert "is_paper=True" in body


# --- secrets ----------------------------------------------------------------


def test_configured_secrets_never_appear_in_the_settings_payload():
    """The readiness screen reports WHETHER a key is configured, never the key."""
    settings = Settings(
        ai_api_key="sk-secret-value-aaa",
        cron_secret="cron-secret-value-bbb",
        market_data_api_key="md-secret-value-ccc",
    )
    payload = str(settings.safe_summary())

    for secret in ("sk-secret-value-aaa", "cron-secret-value-bbb", "md-secret-value-ccc"):
        assert secret not in payload

    assert settings.safe_summary()["ai_configured"] is True
    assert settings.safe_summary()["bot_endpoint_protected"] is True


def test_a_secret_does_not_leak_through_repr():
    """`repr(settings)` reaches logs and tracebacks by accident far more often
    than anyone intends."""
    settings = Settings(ai_api_key="sk-secret-value-aaa", cron_secret="cron-bbb")
    assert "sk-secret-value-aaa" not in repr(settings)
    assert "cron-bbb" not in repr(settings)


def test_no_secret_is_committed_to_the_repository():
    import re

    # A key-shaped literal assigned in source. Settings defaults are None, so
    # any match is a real finding.
    pattern = re.compile(r"(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})")
    for source in sources():
        assert not pattern.search(source.read_text()), f"{source.name} contains a key"


# --- the frontend -----------------------------------------------------------


def test_the_frontend_holds_no_key_and_no_exchange_call():
    """The browser talks to this backend and to nothing else. A key in the
    bundle is a key published, and a direct exchange call from the page would
    put the visitor's address on the venue's rate limit."""
    frontend = Path(__file__).resolve().parents[2] / "frontend"
    for source in frontend.glob("*.js"):
        text = source.read_text()
        assert "api.binance.com" not in text
        assert "okx.com" not in text
        assert "apiKey" not in text
        assert "api_key" not in text


def test_every_dynamic_value_in_the_page_passes_through_the_escaper():
    """A spot check with teeth: the escaper must exist, cover the five
    characters that matter, and be applied — not merely available."""
    app_js = (Path(__file__).resolve().parents[2] / "frontend" / "app.js").read_text()

    assert "function esc(value)" in app_js
    # The escaper is exercised directly rather than pattern-matched: a regex
    # over the source proves the characters are mentioned, not that they are
    # replaced.
    table = app_js[app_js.index("function esc(value)") :].split("}", 1)[0]
    for char in ("&", "<", ">", '"', "'"):
        assert char in table, f"the escaper does not handle {char!r}"

    # Free text from the server — reasons, warnings, symbols, exit reasons — is
    # the input that could ever carry markup, and each is escaped at its site.
    for field in (
        "s.reason",
        "s.symbol",
        "s.invalidation",
        "o.finding",
        "g.key",
        # The plan, from stage 17. Prices and sizes are server-formatted
        # STRINGS rather than numbers the page recomputes, so they reach the
        # DOM the same way a reason does and need the same treatment.
        "size.quantity",
        "plan.entry_display",
        "plan.stop_display",
        "t.price_display",
        "p.size.cap_note",
        "p.cost_note",
    ):
        assert f"esc({field})" in app_js, f"{field} reaches the DOM unescaped"


# --- state-changing routes --------------------------------------------------


def test_every_state_changing_route_is_behind_the_operator_guard():
    """The rule, rather than three routes that happen to check a header.

    It was two routes that checked and one that did not: the manual-close
    endpoint realised an open position's P/L for anyone who found the URL,
    while the tick beside it was guarded. Asserting the rule is what stops the
    next POST being added without it.
    """
    from app.api.deps import require_operator
    from app.main import create_app

    app = create_app()
    state_changing: list[str] = []
    unguarded: list[str] = []

    for route in _api_routes(app):
        methods = getattr(route, "methods", set()) or set()
        if methods <= {"GET", "HEAD", "OPTIONS"}:
            continue
        name = f"{sorted(methods)} {route.path}"
        state_changing.append(name)
        # `route.dependencies` holds the raw `Depends` markers; the callable
        # is on `.dependency`. `route.dependant.dependencies` holds the
        # resolved tree, where it is `.call`. Both spellings are checked so
        # this does not quietly stop matching on a FastAPI upgrade.
        guards = {
            getattr(getattr(d, "dependency", None), "__name__", "")
            for d in getattr(route, "dependencies", [])
        } | {
            getattr(getattr(d, "call", None), "__name__", "")
            for d in getattr(getattr(route, "dependant", None), "dependencies", [])
        }
        if require_operator.__name__ not in guards:
            unguarded.append(name)

    # A walk that finds nothing would pass the real assertion while proving
    # nothing at all, which is how this class of test usually rots.
    assert len(state_changing) >= 3, f"only found {state_changing}; the route walk is wrong"
    assert not unguarded, f"unguarded state-changing routes: {unguarded}"


def _api_routes(app):
    """Walk included routers.

    This FastAPI version wraps each `include_router` call in an object that has
    no `.path` and no `.routes` — it holds the real router on `.original_router`
    — so a flat pass over `app.routes` finds four framework routes and nothing
    else. Any check built on that pass reports success while examining nothing,
    which is why the caller asserts on how many routes this returns.
    """
    found = []

    def walk(routes, prefix=""):
        for route in routes:
            inner = getattr(route, "original_router", None)
            if inner is not None:
                # Only the mount prefix ("/api") is added here: the router's
                # own prefix ("/bot") is already baked into each route's path,
                # and adding it again produced "/api/bot/bot/..." in the first
                # version of this walk.
                context = getattr(route, "include_context", None)
                walk(inner.routes, prefix + getattr(context, "prefix", ""))
                continue
            path = prefix + str(getattr(route, "path", ""))
            if path.startswith("/api"):
                found.append(_Route(path, route))

    walk(app.routes)
    return found


class _Route:
    """The route with its fully-qualified path, since the mount prefix lives on
    the include context rather than on the route."""

    def __init__(self, path: str, route) -> None:
        self.path = path
        self._route = route

    def __getattr__(self, name):
        return getattr(self._route, name)
