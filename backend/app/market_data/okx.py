"""OKX public market data.

The failover partner for Binance. Two venues that fail independently are the
difference between "the platform is down" and "one exchange is down", and OKX
was chosen because it is reachable in jurisdictions where Binance is not.

OKX differs from Binance in three ways that matter, and each one has produced
a real bug in systems that assumed otherwise:

  1. Symbols are hyphenated instrument ids: BTCUSDT -> BTC-USDT.
  2. Every response is wrapped in {"code": "0", "msg": "", "data": [...]},
     and ``code`` is a STRING. A non-zero code arrives with HTTP 200, so
     checking the status alone reports success on a failed call.
  3. Candles are returned NEWEST FIRST. Feeding them to an indicator in
     arrival order computes it backwards through time, which yields
     plausible numbers that are entirely wrong.

Reference shapes (v5):
  GET /api/v5/market/ticker?instId=BTC-USDT
  GET /api/v5/market/candles?instId=&bar=&limit=
  GET /api/v5/market/books?instId=&sz=
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx

from app.core.errors import MalformedUpstreamResponse
from app.market_data.http import HttpClient
from app.market_data.schemas import Candle, OrderBook, OrderBookLevel, Ticker
from app.market_data.timeframes import OKX_INTERVALS, Timeframe

BASE_URL = "https://www.okx.com"

MAX_CANDLES = 300
MAX_DEPTH = 400

# Quote assets are stripped longest-first so USDC is not mistaken for USD.
_QUOTES = ("USDT", "USDC", "TUSD", "BUSD", "USD", "BTC", "ETH")


class OkxProvider:
    name = "okx"

    def __init__(
        self,
        *,
        base_url: str = BASE_URL,
        timeout: float = 10.0,
        max_retries: int = 3,
        backoff: float = 0.5,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._http = HttpClient(
            base_url,
            provider=self.name,
            timeout=timeout,
            max_retries=max_retries,
            backoff=backoff,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _data(self, path: str, params: dict[str, Any]) -> list[Any]:
        payload = await self._http.get_json(path, params)
        if not isinstance(payload, dict):
            raise MalformedUpstreamResponse(
                f"okx: expected an object from {path}.", provider=self.name
            )
        code = str(payload.get("code", ""))
        if code != "0":
            # HTTP 200 with a business error. Surfacing it as malformed rather
            # than unavailable is deliberate: retrying will return the same
            # code, so this needs an operator, not another attempt.
            raise MalformedUpstreamResponse(
                f"okx: responded with code {code} ({payload.get('msg') or 'no message'}).",
                provider=self.name,
                upstream_code=code,
            )
        data = payload.get("data")
        if not isinstance(data, list):
            raise MalformedUpstreamResponse(
                f"okx: 'data' was not an array on {path}.", provider=self.name
            )
        return data

    # --- ticker ----------------------------------------------------------

    async def get_ticker(self, symbol: str) -> Ticker:
        inst = to_inst_id(symbol)
        data = await self._data("/api/v5/market/ticker", {"instId": inst})
        if not data:
            raise MalformedUpstreamResponse(
                f"okx: no ticker returned for {inst}.", provider=self.name
            )
        row = data[0]
        try:
            last = _dec(row["last"])
            open_24h = _dec(row["open24h"])
            # OKX reports the 24h open, not the percentage change, so it is
            # derived here rather than invented.
            change = (last - open_24h) / open_24h * 100 if open_24h > 0 else Decimal(0)
            return Ticker(
                symbol=from_inst_id(inst),
                price=last,
                change_24h_pct=change,
                high_24h=_dec(row["high24h"]),
                low_24h=_dec(row["low24h"]),
                volume_24h=_dec(row["vol24h"]),
                quote_volume_24h=_dec(row["volCcy24h"]),
                timestamp=_ms(row["ts"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise MalformedUpstreamResponse(
                f"okx: could not parse the ticker ({exc}).", provider=self.name
            ) from exc

    # --- candles ---------------------------------------------------------

    async def get_candles(
        self, symbol: str, timeframe: Timeframe, limit: int = 200
    ) -> list[Candle]:
        inst = to_inst_id(symbol)
        data = await self._data(
            "/api/v5/market/candles",
            {
                "instId": inst,
                "bar": OKX_INTERVALS[timeframe],
                "limit": min(max(1, limit), MAX_CANDLES),
            },
        )

        candles: list[Candle] = []
        for row in data:
            if not isinstance(row, list | tuple) or len(row) < 6:
                raise MalformedUpstreamResponse(
                    "okx: a candle row had an unexpected shape.", provider=self.name
                )
            try:
                # Row: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
                confirm = str(row[8]) if len(row) > 8 else "1"
                candles.append(
                    Candle(
                        symbol=from_inst_id(inst),
                        timeframe=timeframe,
                        open_time=_ms(row[0]),
                        open=_dec(row[1]),
                        high=_dec(row[2]),
                        low=_dec(row[3]),
                        close=_dec(row[4]),
                        volume=_dec(row[5]),
                        quote_volume=_dec(row[7]) if len(row) > 7 else None,
                        closed=confirm == "1",
                    )
                )
            except (IndexError, TypeError, ValueError) as exc:
                raise MalformedUpstreamResponse(
                    f"okx: could not parse a candle row ({exc}).", provider=self.name
                ) from exc

        # Oldest first, to match Binance and every indexing assumption made by
        # the indicator layer.
        candles.sort(key=lambda c: c.open_time)
        return candles

    # --- order book ------------------------------------------------------

    async def get_order_book(self, symbol: str, depth: int = 20) -> OrderBook:
        inst = to_inst_id(symbol)
        data = await self._data(
            "/api/v5/market/books",
            {"instId": inst, "sz": min(max(1, depth), MAX_DEPTH)},
        )
        if not data:
            raise MalformedUpstreamResponse(
                f"okx: no order book returned for {inst}.", provider=self.name
            )
        book = data[0]
        try:
            return OrderBook(
                symbol=from_inst_id(inst),
                bids=tuple(_levels(book["bids"])),
                asks=tuple(_levels(book["asks"])),
                timestamp=_ms(book["ts"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise MalformedUpstreamResponse(
                f"okx: could not parse the order book ({exc}).", provider=self.name
            ) from exc


def _levels(rows: Any) -> list[OrderBookLevel]:
    if not isinstance(rows, list):
        raise TypeError("order book side was not an array")
    out: list[OrderBookLevel] = []
    for row in rows:
        # OKX levels are [price, size, liquidated_orders, order_count].
        if not isinstance(row, list | tuple) or len(row) < 2:
            raise TypeError("order book level had an unexpected shape")
        quantity = _dec(row[1])
        if quantity > 0:
            out.append(OrderBookLevel(price=_dec(row[0]), quantity=quantity))
    return out


def to_inst_id(symbol: str) -> str:
    """BTCUSDT -> BTC-USDT. Already-hyphenated input is passed through."""
    s = symbol.strip().upper().replace("/", "-")
    if "-" in s:
        return s
    for quote in _QUOTES:
        if s.endswith(quote) and len(s) > len(quote):
            return f"{s[: -len(quote)]}-{quote}"
    return s


def from_inst_id(inst_id: str) -> str:
    """BTC-USDT -> BTCUSDT, so one symbol spelling reaches the database."""
    return inst_id.replace("-", "").upper()


def _dec(value: Any) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError) as exc:
        raise ValueError(f"not a decimal: {value!r}") from exc


def _ms(value: Any) -> datetime:
    return datetime.fromtimestamp(int(value) / 1000, tz=UTC)
