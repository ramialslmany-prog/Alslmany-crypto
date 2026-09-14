"""Slippage read from the book instead of assumed.

A flat percentage says a strategy costs the same at $1,000 and $1,000,000.
Exactly one of those is true, and which one it is depends on the book.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from app.market_data.schemas import OrderBook, OrderBookLevel
from app.paper.broker import PaperBroker
from app.paper.depth import cost_to_cross
from app.risk.sizing import SLIPPAGE_PCT


def book(
    *,
    best_bid: str = "99.99",
    best_ask: str = "100.01",
    step: str = "0.01",
    size: str = "10",
    levels: int = 20,
) -> OrderBook:
    bid, ask, gap, qty = (Decimal(best_bid), Decimal(best_ask), Decimal(step), Decimal(size))
    return OrderBook(
        symbol="BTCUSDT",
        bids=tuple(OrderBookLevel(price=bid - gap * i, quantity=qty) for i in range(levels)),
        asks=tuple(OrderBookLevel(price=ask + gap * i, quantity=qty) for i in range(levels)),
        timestamp=datetime.now(UTC),
    )


# --- walking the book -------------------------------------------------------


def test_an_order_inside_the_best_level_pays_the_spread_and_no_impact():
    """Impact is what you pay for eating PAST the best quote. An order that
    does not reach the second level has not moved anything."""
    cost = cost_to_cross(book(), "buy", Decimal("5"))

    assert cost is not None
    assert cost.impact_pct == Decimal("0.0000")
    assert cost.spread_pct > 0
    assert cost.levels_consumed == 1


def test_a_larger_order_pays_more_than_a_smaller_one():
    """The whole point. A flat percentage cannot express this at all."""
    small = cost_to_cross(book(), "buy", Decimal("5"))
    large = cost_to_cross(book(), "buy", Decimal("150"))

    assert large.impact_pct > small.impact_pct
    assert large.levels_consumed > small.levels_consumed


def test_a_thin_book_costs_more_than_a_deep_one_for_the_same_order():
    deep = cost_to_cross(book(size="100"), "buy", Decimal("200"))
    thin = cost_to_cross(book(size="2"), "buy", Decimal("200"))

    assert thin.impact_pct > deep.impact_pct


def test_the_average_price_is_the_weighted_one_not_the_last_level():
    """Hand-checked: 10 at 100.01 and 5 at 100.02 averages 100.013333…, so the
    impact over the 100.01 best quote is about 0.0033%."""
    cost = cost_to_cross(book(best_ask="100.01", step="0.01", size="10"), "buy", Decimal("15"))

    assert cost.levels_consumed == 2
    assert Decimal("0.0030") <= cost.impact_pct <= Decimal("0.0037")


def test_buying_walks_the_asks_and_selling_walks_the_bids():
    """Reading the wrong side would report a buy filling BELOW the ask, which
    is a rebate rather than a cost."""
    buy = cost_to_cross(book(), "buy", Decimal("150"))
    sell = cost_to_cross(book(), "sell", Decimal("150"))

    assert buy.impact_pct > 0 and sell.impact_pct > 0
    assert buy.levels_consumed == sell.levels_consumed


def test_a_book_too_thin_to_fill_the_order_says_so():
    """Not a price. "This size does not trade here" is the honest answer, and
    the measured cost describes only the part that filled."""
    cost = cost_to_cross(book(size="1", levels=5), "buy", Decimal("500"))

    assert cost.exhausted is True
    assert cost.filled_fraction < 1


def test_an_empty_side_is_unknown_rather_than_free():
    empty = OrderBook(
        symbol="BTCUSDT",
        bids=(OrderBookLevel(price=Decimal("99"), quantity=Decimal("1")),),
        asks=(),
        timestamp=datetime.now(UTC),
    )
    assert cost_to_cross(empty, "buy", Decimal("1")) is None


def test_a_zero_order_is_not_a_measurement():
    assert cost_to_cross(book(), "buy", Decimal("0")) is None


# --- what the broker does with it -------------------------------------------


async def test_a_fill_priced_from_a_book_records_that_it_was():
    """A fill priced from a real book and one priced from an assumption are
    different kinds of evidence, and a ledger that cannot tell them apart
    cannot be audited."""
    broker = PaperBroker()

    measured = await broker.place(
        symbol="BTCUSDT",
        side="buy",
        quantity=Decimal("5"),
        price=Decimal("100"),
        book=book(),
    )
    assumed = await broker.place(
        symbol="BTCUSDT",
        side="buy",
        quantity=Decimal("5"),
        price=Decimal("100"),
    )

    assert measured.depth_measured is True
    assert assumed.depth_measured is False
    assert assumed.slippage_pct == SLIPPAGE_PCT


async def test_a_big_order_in_a_thin_book_fills_worse_than_the_flat_assumption():
    """The case the constant was hiding: at size, the real cost is a multiple
    of what the simulation was charging."""
    broker = PaperBroker()

    flat = await broker.place(
        symbol="BTCUSDT",
        side="buy",
        quantity=Decimal("400"),
        price=Decimal("100"),
    )
    real = await broker.place(
        symbol="BTCUSDT",
        side="buy",
        quantity=Decimal("400"),
        price=Decimal("100"),
        book=book(size="2", levels=40),
    )

    assert real.price > flat.price
    assert real.slippage_pct > flat.slippage_pct


async def test_slippage_is_adverse_in_both_directions_with_a_book_too():
    """The property the whole simulation rests on. A book must not become a
    route to a favourable fill."""
    broker = PaperBroker()

    buy = await broker.place(
        symbol="BTCUSDT",
        side="buy",
        quantity=Decimal("50"),
        price=Decimal("100"),
        book=book(),
    )
    sell = await broker.place(
        symbol="BTCUSDT",
        side="sell",
        quantity=Decimal("50"),
        price=Decimal("100"),
        book=book(),
    )

    assert buy.price > Decimal("100")
    assert sell.price < Decimal("100")


async def test_an_exhausted_book_never_produces_a_cheaper_fill_than_the_assumption():
    """A book that ran out is evidence the order is too big, not evidence it is
    cheap. Its measured cost covers only the part that filled, so the flat
    assumption is kept as a floor."""
    broker = PaperBroker()

    # One level, deliberately tight: the measured cost of the sliver that fills
    # is tiny, and taking it at face value would make an untradeable size look
    # free.
    sliver = OrderBook(
        symbol="BTCUSDT",
        bids=(OrderBookLevel(price=Decimal("99.999"), quantity=Decimal("1")),),
        asks=(OrderBookLevel(price=Decimal("100.001"), quantity=Decimal("1")),),
        timestamp=datetime.now(UTC),
    )

    fill = await broker.place(
        symbol="BTCUSDT",
        side="buy",
        quantity=Decimal("1000"),
        price=Decimal("100"),
        book=sliver,
    )

    assert fill.depth.exhausted is True
    assert fill.slippage_pct >= SLIPPAGE_PCT


def test_the_broker_still_holds_no_client_and_no_credentials():
    """Depth arrives as an argument; it is never fetched here. That is what
    keeps "no real trading" a property of the code rather than a promise.

    Checked over the parsed IDENTIFIERS rather than the raw text: the first
    version of this scanned the source for "http" and tripped on the docstring
    saying the class has no http client, which is a test that fails hardest
    when the code is most clearly correct.
    """
    import ast
    from pathlib import Path

    module = Path(__file__).resolve().parents[1] / "app" / "paper" / "broker.py"
    tree = ast.parse(module.read_text())

    banned = {"http", "httpx", "requests", "session", "api_key", "secret", "aiohttp"}
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            names.add(node.id.lower())
        elif isinstance(node, ast.Attribute):
            names.add(node.attr.lower())
        elif isinstance(node, ast.arg):
            names.add(node.arg.lower())
        elif isinstance(node, ast.Import):
            names.update(a.name.split(".")[0].lower() for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".")[0].lower())

    assert not (names & banned), f"PaperBroker reaches for {sorted(names & banned)}"
