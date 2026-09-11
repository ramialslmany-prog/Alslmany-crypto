# السلماني كريبتو · Alslmany Crypto

**توصيات عملات رقمية مبنية على تحليل قابل للمراجعة، وروبوت تداول ورقي بسجل أداء شفاف.**

Crypto recommendations built on analysis you can audit, plus a paper-trading
bot with a track record it cannot edit.

> ⚠️ **أداة تعليمية وليست نصيحة مالية.** تداول العملات الرقمية ينطوي على مخاطر
> خسارة رأس المال بالكامل. القرار مسؤوليتك وحدك.
>
> **Educational tool, not financial advice.** Crypto trading carries the risk of
> total loss of capital. Your decisions are your own.

---

## What this is

Most crypto "signal" sites hand you an arrow and a price. This one hands you the
reasoning, and lets you disagree with it.

Every recommendation ships with the exact factors that produced it — across four
timeframes and five independent analytical angles — an explicit invalidation
level decided *before* the entry, and the evidence that argues **against** the
call published beside the evidence that argues for it.

Two constraints hold the whole thing honest:

1. **Spot long only.** The engine never publishes a short or suggests leverage.
   Its bearish reads come out as *reduce* or *avoid*, which is the useful half
   of a bearish view for anyone not running a derivatives book.
2. **Probabilities, never certainty.** Output is three weighted scenarios with a
   defined invalidation. Nothing here claims to know what happens next.

Arabic-first with a full English toggle, resolved server-side so the first paint
already carries the right language and direction.

---

## The bot

A paper trader. It **holds no exchange keys, places no real orders, and has
access to no funds.** Execution sits behind a `Broker` port with only a paper
implementation, so the strategy never learns whether its fills are simulated —
which keeps the seam honest without anything real being at stake.

| It does | It never does |
|---|---|
| Enters only grade A/B at ≥ 1.8 reward-to-risk | Touches your money or asks for exchange keys |
| Takes profit in three stages at real levels | Uses leverage |
| Moves the stop to breakeven after target 1 | Widens a stop — not expressible in the code |
| Trails behind the high-water mark after target 2 | Trades on demo data |
| Closes the whole book when the regime turns | Hides a losing trade from the record |

Paper fills are charged slippage **against us** in both directions. A simulator
that fills perfectly flatters every strategy run through it.

---

## Quick start

```bash
npm install
npm run dev      # http://localhost:3000
```

No API keys required. Market data comes from public exchange endpoints.

```bash
npm test         # 247 assertions over the analysis, engine and bot
npm run build    # production build
npm run lint
npm run typecheck
```

---

## How it works

**Data** (`src/lib/market/`) — Binance, OKX and Bybit behind one interface with
automatic failover, so no single exchange can take the product down and a
geo-block is survivable rather than fatal. Upstream JSON is schema-validated at
the boundary. A TTL cache collapses duplicate in-flight calls and keeps serving
the last good value during an outage, clearly marked degraded.

Every response carries its provenance — which venue answered, when, and whether
the copy is stale. When no venue is reachable the app falls back to a **clearly
labelled demo generator**: it always reports `source: "synthetic"`, the UI shows
a standing banner, and **the bot refuses to trade on it**.

**Analysis** (`src/lib/analysis/`) — indicators (Wilder smoothing implemented
properly and verified against Wilder's 1978 RSI table), market structure
(fractal pivots, BOS/CHoCH, level clustering, fair value gaps, Fibonacci), and
regime classification. Bitcoin sets the tide, breadth says whether the market is
following, and sentiment is read contrarian at the extremes only. The output is
a **risk budget** that shrinks every position automatically when conditions turn,
rather than relying on anyone to remember to be careful.

**Engine** (`src/lib/engine/`) — deterministic confluence scoring. The same
candles always produce the same call. Confidence comes from *agreement across
timeframes*, not magnitude: four charts saying +40 is a better trade than one
saying +90 and three saying nothing. The higher timeframe holds a veto — a hot
1h setup inside a broken daily is demoted, never promoted.

**Risk** (`src/lib/engine/risk.ts`) — the stop is decided first, at the level
that would prove the idea wrong, and sits below structure rather than exactly on
it. Position size is derived from the stop distance, so a wider stop buys a
smaller position and the loss taken is the same either way. Targets sit at levels
the market has actually respected; where structure runs out, extensions are
labelled as extensions so you can tell the difference.

**Bot** (`src/lib/bot/`) — lifecycle, ledger and a walk-forward backtester that
runs the *same* engine, not a simplified copy. Decisions on the close of bar *i*,
execution at the open of bar *i+1*. When a bar covers both the stop and a target,
the stop is taken first — intrabar sequence is unknowable from OHLC, and
resolving that ambiguity in our own favour is how a backtest stops matching
reality.

---

## Deployment (Vercel)

1. Push the repo to GitHub and import it at [vercel.com/new](https://vercel.com/new).
2. Add any optional variables from `.env.example` under **Settings → Environment Variables**.
3. Deploy.

### 24/7 scanning

`vercel.json` declares a **daily** cron hitting `/api/cron/tick` — the most
frequent schedule the Vercel Hobby plan allows.

For more frequent scanning on the free tier, point an external scheduler such as
[cron-job.org](https://cron-job.org) at:

```
https://YOUR-APP.vercel.app/api/cron/tick?key=YOUR_CRON_SECRET
```

The endpoint is **closed unless `CRON_SECRET` is set**. It never defaults to
open — an unauthenticated endpoint that mutates a ledger is an invitation.

### Durable track record

Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` so the ledger
survives container recycling. Without them the bot desk states on screen that
storage is ephemeral, so a reset is never mistaken for a change in strategy.

---

## Testing

```bash
npm test
```

247 assertions run against compiled output, covering the indicators, market
structure, regime classification, the recommendation engine and the bot.

The suite is not decoration — it has caught nine real defects during this build,
each of which would have shipped silently. Among them: a percentile function that
reported a calm market as a volatility shock on floating-point noise; a
backtester that skipped every bar and reported "0 trades" as though it were a
finding; async assertions landing after the report was written; and a chart and a
signal card quoting different prices for the same asset on the same screen.

---

## Stack

Next.js 15 (App Router) · React 19 · TypeScript (strict) · Tailwind 3 ·
TanStack Query · Zod at the network boundary. Charts are hand-written SVG — the
token system already defines the colours and hairlines.

---

## Disclaimer

This software is for **education and research only**. It is not financial
advice, not a solicitation, and makes no guarantee of profit. Crypto trading
carries substantial risk of loss, up to and including your entire capital. Most
altcoins move with Bitcoin, so holding several of them is often one bet rather
than a diversified portfolio. You are solely responsible for your decisions —
do your own research and consult a licensed professional.
