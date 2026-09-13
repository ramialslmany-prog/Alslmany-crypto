"""Binance public market data.

Only public endpoints are used, and no key is sent. This is a read-only,
unauthenticated consumer of market data by design: the platform holds no
exchange credentials, so there is no code path through which it could place an
order even if a future bug tried to.

Reference shapes (spot REST v3):
  GET /api/v3/ticker/24hr?symbol=BTCUSDT   -> object
  GET /api/v3/klines?symbol=&interval=&limit= -> array of 12-element arrays
  GET /api/v3/depth?symbol=&limit=         -> {bids: [[p, q]], asks: [[p, q]]}
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx

from app.core.errors import MalformedUpstreamResponse
from app.market_data.http import HttpClient
from app.market_data.schemas import Candle, OrderBook, OrderBookLevel, Ticker
from app.market_data.timeframes import BINANCE_INTERVALS, Timeframe

BASE_URL = "https://api.binance.com"

# Binance caps klines at 1000 and depth at 5000 per request.
MAX_KLINES = 1000
MAX_DEPTH = 5000


class BinanceProvider:
    name = "binance"

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

    # --- ticker ----------------------------------------------------------

    async def get_ticker(self, symbol: str) -> Ticker:
        payload = await self._http.get_json("/api/v3/ticker/24hr", {"symbol": _normalise(symbol)})
        if not isinstance(payload, dict):
            raise MalformedUpstreamResponse(
                "binance: expected an object from /ticker/24hr.", provider=self.name
            )
        try:
            return Ticker(
                symbol=_normalise(symbol),
                price=_dec(payload["lastPrice"]),
                change_24h_pct=_dec(payload["priceChangePercent"]),
                high_24h=_dec(payload["highPrice"]),
                low_24h=_dec(payload["lowPrice"]),
                volume_24h=_dec(payload["volume"]),
                quote_volume_24h=_dec(payload["quoteVolume"]),
                # closeTime is the end of the rolling window, which is "now"
                # for a live quote and is what we want to age against.
                timestamp=_ms(payload["closeTime"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise MalformedUpstreamResponse(
                f"binance: could not parse the 24h ticker ({exc}).", provider=self.name
            ) from exc

    # --- candles ---------------------------------------------------------

    async def get_candles(
        self, symbol: str, timeframe: Timeframe, limit: int = 200
    ) -> list[Candle]:
        payload = await self._http.get_json(
            "/api/v3/klines",
            {
                "symbol": _normalise(symbol),
                "interval": BINANCE_INTERVALS[timeframe],
                "limit": min(max(1, limit), MAX_KLINES),
            },
        )
        if not isinstance(payload, list):
            raise MalformedUpstreamResponse(
                "binance: expected an array from /klines.", provider=self.name
            )

        now_ms = datetime.now(UTC).timestamp() * 1000
        candles: list[Candle] = []
        for row in payload:
            if not isinstance(row, list | tuple) or len(row) < 9:
                raise MalformedUpstreamResponse(
                    "binance: a kline row had an unexpected shape.", provider=self.name
                )
            try:
                open_ms = int(row[0])
                close_ms = int(row[6])
                candles.append(
                    Candle(
                        symbol=_normalise(symbol),
                        timeframe=timeframe,
                        open_time=_ms(open_ms),
                        open=_dec(row[1]),
                        high=_dec(row[2]),
                        low=_dec(row[3]),
                        close=_dec(row[4]),
                        volume=_dec(row[5]),
                        quote_volume=_dec(row[7]),
                        trades=int(row[8]),
                        # The final bar is still forming until its close time
                        # passes. Marking it is what lets the analysis engine
                        # refuse to fire a signal on an incomplete candle.
                        closed=close_ms <= now_ms,
                    )
                )
            except (IndexError, TypeError, ValueError) as exc:
                raise MalformedUpstreamResponse(
                    f"binance: could not parse a kline row ({exc}).", provider=self.name
                ) from exc
        return candles

    # --- order book ------------------------------------------------------

    async def get_order_book(self, symbol: str, depth: int = 20) -> OrderBook:
        payload = await self._http.get_json(
            "/api/v3/depth",
            {"symbol": _normalise(symbol), "limit": min(max(1, depth), MAX_DEPTH)},
        )
        if not isinstance(payload, dict):
            raise MalformedUpstreamResponse(
                "binance: expected an object from /depth.", provider=self.name
            )
        try:
            return OrderBook(
                symbol=_normalise(symbol),
                bids=tuple(_levels(payload["bids"])),
                asks=tuple(_levels(payload["asks"])),
                # /depth carries no timestamp; the fetch time is the honest
                # stamp, and it is never older than the data it describes.
                timestamp=datetime.now(UTC),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise MalformedUpstreamResponse(
                f"binance: could not parse the order book ({exc}).", provider=self.name
            ) from exc


def _levels(rows: Any) -> list[OrderBookLevel]:
    if not isinstance(rows, list):
        raise TypeError("order book side was not an array")
    out: list[OrderBookLevel] = []
    for row in rows:
        if not isinstance(row, list | tuple) or len(row) < 2:
            raise TypeError("order book level had an unexpected shape")
        quantity = _dec(row[1])
        # Zero-quantity levels are delete markers in the diff stream and
        # meaningless in a snapshot; carrying them would distort depth sums.
        if quantity > 0:
            out.append(OrderBookLevel(price=_dec(row[0]), quantity=quantity))
    return out


def _normalise(symbol: str) -> str:
    return symbol.strip().upper().replace("-", "").replace("/", "")


def _dec(value: Any) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError) as exc:
        raise ValueError(f"not a decimal: {value!r}") from exc


def _ms(value: Any) -> datetime:
    return datetime.fromtimestamp(int(value) / 1000, tz=UTC)
