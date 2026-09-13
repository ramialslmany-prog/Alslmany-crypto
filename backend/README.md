# Backend — analysis & paper-trading platform

FastAPI service behind the market screen. **Stage 1 of 10: market data and storage.**

> ## Paper trading only
>
> This service holds no exchange credentials and contains no order-placement
> code path. Every adapter is a read-only consumer of public market data. The
> architecture keeps execution behind a port (`MarketDataProvider` today, a
> `Broker` port from Stage 6) so real trading *could* be added deliberately
> later — but nothing here can place an order, and `paper_trading_only` is a
> runtime-checkable constant, not a comment.

---

## Run it

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
cp .env.example .env            # optional: the defaults work as-is
.venv/bin/python -m uvicorn app.main:app --reload
```

Then open <http://127.0.0.1:8000>. The schema is created and the coin universe
seeded on first start, so there is no setup step.

PostgreSQL is the production target; SQLite is the default so a fresh clone
runs with no server:

```bash
DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/alslmany
```

### Migrations

`create_all()` at startup is a convenience for a fresh local run. Schema
changes go through Alembic, so they are reviewable as a diff instead of being
applied implicitly:

```bash
.venv/bin/python -m alembic upgrade head           # apply
.venv/bin/python -m alembic revision --autogenerate -m "what changed"
```

`alembic.ini` carries no URL — `env.py` reads `DATABASE_URL` through
`app.config`, so there is one source of truth and no credential is committed. A
test asserts the migration builds exactly the schema the models describe,
because two sources of truth for a schema drift, and the migration is the one
nobody runs locally.

## Verify

```bash
bash verify.sh      # ruff check · ruff format --check · pytest
```

Also runs from the repository root as part of `npm run verify`, which the
pre-push hook and CI both call.

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness. Touches nothing. |
| GET | `/api/ready` | Readiness. **503 when the feed is unusable.** |
| GET | `/api/config` | Non-secret configuration. |
| GET | `/api/market/symbols` | The tracked universe. |
| GET | `/api/market/timeframes` | Supported intervals. |
| GET | `/api/market/overview` | Every symbol at once, with failures named. |
| GET | `/api/market/{symbol}/ticker` | Current quote. |
| GET | `/api/market/{symbol}/candles` | OHLCV. `?timeframe=1h&limit=200` |
| GET | `/api/market/{symbol}/orderbook` | Depth. `?depth=20` |

Every `/api` route except health and readiness carries a per-client budget,
sized by how much upstream work it causes — `overview` fans out to every symbol
and is budgeted hardest. Responses carry `X-RateLimit-*`, and a 429 carries
`Retry-After`, so a well-behaved client can back off instead of retrying into
the wall.

Interactive docs at `/docs`.

Every market response carries provenance:

```jsonc
{
  "data": { "symbol": "BTCUSDT", "price": "108150.25", ... },
  "meta": {
    "source": "binance",     // which venue actually answered
    "cached": false,
    "stale": false,          // served from cache after every provider failed
    "fallback_used": false,  // the primary was down
    "degraded": false
  }
}
```

---

## The rule this stage exists to establish

**The platform never invents a market value.**

When every provider fails and no usable cache entry remains, the API returns
`503 no_reliable_market_data` — *"Insufficient reliable market data"* — and no
price field at all. It does not return zero, the last value it happened to
remember, or a plausible guess. The market screen shows an explicit outage
notice rather than an empty table that looks like calm markets.

Three states are kept distinct, because collapsing them is how a trading system
ends up acting on a number that was never real:

| State | Response | Meaning |
|---|---|---|
| Live | `200`, `stale: false` | A provider answered just now. |
| Stale | `200`, `stale: true` | Providers are down; this was real when fetched, and is **labelled**, never passed off as current. |
| Unavailable | `503` | Nothing trustworthy exists. No number is returned. |

`feed_healthy` in `/api/market/overview` is false when *any* symbol is stale,
not only when one outright fails — otherwise the UI would report a live feed
while every price on screen came from a dead provider's last answer.

From Stage 5 onward the risk manager treats `no_reliable_market_data` as a hard
stop on opening positions.

---

## Layout

```
app/
  config.py              env-driven settings; secrets never serialised
  core/                  errors (stable codes) and JSON logging
  market_data/
    schemas.py           Ticker / Candle / OrderBook — validated, Decimal
    timeframes.py        per-venue interval spellings in one place
    http.py              retry, backoff with jitter, rate-limit handling
    binance.py  okx.py   adapters; provider payloads never escape this package
    cache.py             TTL cache with an explicit stale tier
    router.py            failover, provenance, and the refusal to invent
  database/
    types.py             Money (exact Decimal) · UtcDateTime (aware, always)
    models/              coins · candles · ticker_snapshots · system_logs
    repositories/        upserts keyed so re-ingestion is idempotent
  services/              fetch-and-store orchestration
  api/routes/            HTTP surface
tests/                   73 tests, no network required
```

### Three decisions worth knowing

**Prices are `Decimal`, end to end.** Floats cannot represent `0.1` exactly, and
a position-sizing routine that inherits that error is wrong on every trade.
SQLite has no decimal type, so `Money` stores text there and NUMERIC on
PostgreSQL — exact on both.

**Timestamps are timezone-aware UTC, enforced by the column type.**
`DateTime(timezone=True)` does *not* deliver this on SQLite; values come back
naive. `UtcDateTime` guarantees it and rejects naive input rather than guessing,
because guessing is how a local-time stamp enters a trading database.

**Candles are timestamped at their OPEN and flagged `closed`.** Mixing open- and
close-stamped bars shifts every signal by one interval and makes a backtest look
prescient. The forming bar is stored so the chart can draw it (hollow) and
flagged so Stage 2 can decline to fire a signal on it.

---

## Testing

51 tests, no network access required — adapters are driven through a stubbed
HTTP transport against recorded payload shapes.

They have already caught four real defects in this stage:

- **Naive timestamps escaping SQLite**, contradicting a guarantee the base class
  documented but did not enforce.
- **`ttl=0` turning the cache into a permanent stale store** instead of
  disabling it, so switching caching *off* would have served older data than
  leaving it on.
- **A readiness probe satisfied by cached data**, reporting a health it had not
  verified.
- **Provenance misattributed on cache hits**, via a side table that self-cleared
  and then named the wrong venue.

A fifth was caught by looking at the running screen: the feed badge read
**LIVE** while serving stale prices.

### And six more, found by a later audit

The suite above passed throughout. These were found by *measuring* behaviour
rather than re-reading code, and each is now pinned by a regression test:

- **`/depth` was sent limits Binance rejects.** It accepts only
  `{5,10,20,50,100,500,1000,5000}`; anything else is HTTP 400. A request for
  `depth=25` therefore failed against the primary venue every time, silently
  pushing all order-book traffic to the fallback — or to a 503 when the
  fallback was down too. Requests now round **up** to the next allowed tier, so
  the book is never truncated.
- **A cache miss was a stampede.** Twenty concurrent requests for one symbol
  made twenty upstream calls: the cache did nothing precisely when load was
  highest. Single-flight collapses them to one.
- **The market overview fetched serially** — measured at 1.01s for five symbols
  at 200ms each, growing linearly with every coin added. Now 0.20s, with the
  per-symbol failure isolation preserved.
- **Nothing rate-limited the API.** Exchanges count requests against *our*
  address, so one script could spend the shared quota and break the deployment
  for everyone — a lesson learned in an earlier codebase and lost in the
  rewrite.
- **`create_all()` could silently create nothing.** `Base.metadata` is filled as
  a side effect of importing the model modules; without that import it is empty
  and the call succeeds while doing nothing. The app only worked by accident of
  import order.
- **`UtcDateTime` could not be rebuilt from its own rendered form**, so every
  autogenerated migration raised `NameError` or `TypeError` on first run — the
  schema tool failing at the one job it has.

Two claims in this file were also false and are now true: `system_logs` was a
documented audit trail nothing ever wrote to, and Alembic was named as owning
schema changes with no Alembic in the repository.

## Next

Stage 2 — technical indicators (RSI, MACD, EMA/SMA, ATR, VWAP, volume) computed
over the stored series, with each one verified against published reference
values rather than against its own output.
