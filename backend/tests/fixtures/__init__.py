"""Recorded upstream payloads.

These mirror the documented response shapes of each venue, including the
details that are easy to get wrong: Binance returns numbers as strings inside
arrays, OKX wraps everything in a string-typed ``code`` and returns candles
newest-first.
"""

from __future__ import annotations

# --- binance ---------------------------------------------------------------

BINANCE_TICKER_24HR = {
    "symbol": "BTCUSDT",
    "priceChange": "1250.00000000",
    "priceChangePercent": "1.170",
    "weightedAvgPrice": "107800.12",
    "prevClosePrice": "106900.00",
    "lastPrice": "108150.25000000",
    "lastQty": "0.01230000",
    "bidPrice": "108150.24000000",
    "askPrice": "108150.25000000",
    "openPrice": "106900.25000000",
    "highPrice": "108900.00000000",
    "lowPrice": "106500.00000000",
    "volume": "18234.55120000",
    "quoteVolume": "1965432100.44000000",
    "openTime": 1757000000000,
    "closeTime": 1757086400000,
    "firstId": 1,
    "lastId": 2,
    "count": 2,
}

# [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades,
#  takerBase, takerQuote, ignore]
BINANCE_KLINES = [
    [
        1757080800000,
        "107900.00",
        "108200.00",
        "107850.00",
        "108100.00",
        "512.33",
        1757084399999,
        "55300000.00",
        42311,
        "260.10",
        "28100000.00",
        "0",
    ],
    [
        1757084400000,
        "108100.00",
        "108400.00",
        "108000.00",
        "108150.25",
        "480.11",
        1757087999999,
        "51900000.00",
        39822,
        "240.55",
        "26000000.00",
        "0",
    ],
]

BINANCE_DEPTH = {
    "lastUpdateId": 77712345,
    "bids": [["108150.20", "1.25000"], ["108150.10", "0.80000"], ["108150.00", "0.00000"]],
    "asks": [["108150.30", "0.90000"], ["108150.40", "2.10000"]],
}

# --- okx -------------------------------------------------------------------

OKX_TICKER = {
    "code": "0",
    "msg": "",
    "data": [
        {
            "instType": "SPOT",
            "instId": "BTC-USDT",
            "last": "108160.5",
            "lastSz": "0.01",
            "askPx": "108160.6",
            "bidPx": "108160.4",
            "open24h": "106900.0",
            "high24h": "108910.0",
            "low24h": "106480.0",
            "vol24h": "9123.44",
            "volCcy24h": "985400000.0",
            "ts": "1757086400000",
        }
    ],
}

# OKX returns NEWEST FIRST — the ordering trap this layer must undo.
# [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
OKX_CANDLES = {
    "code": "0",
    "msg": "",
    "data": [
        [
            "1757084400000",
            "108100.0",
            "108400.0",
            "108000.0",
            "108160.5",
            "470.2",
            "50800000.0",
            "50800000.0",
            "0",
        ],
        [
            "1757080800000",
            "107900.0",
            "108200.0",
            "107850.0",
            "108100.0",
            "505.9",
            "54600000.0",
            "54600000.0",
            "1",
        ],
        [
            "1757077200000",
            "107500.0",
            "108000.0",
            "107300.0",
            "107900.0",
            "610.4",
            "65700000.0",
            "65700000.0",
            "1",
        ],
    ],
}

OKX_BOOKS = {
    "code": "0",
    "msg": "",
    "data": [
        {
            "asks": [["108160.6", "0.5", "0", "2"], ["108160.8", "1.1", "0", "3"]],
            "bids": [["108160.4", "0.7", "0", "1"], ["108160.2", "1.9", "0", "4"]],
            "ts": "1757086400000",
        }
    ],
}

OKX_ERROR = {"code": "51001", "msg": "Instrument ID does not exist", "data": []}
