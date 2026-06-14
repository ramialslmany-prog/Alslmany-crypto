# Alslmany Crypto — AI Trading Intelligence

An AI-powered crypto trading & market-intelligence platform. Live multi-exchange
data, a deterministic + AI signal engine, an **autonomous spot trader** that
enters/manages/reviews its own trades, a walk-forward **backtester**,
**smart-money** market-structure analysis, a real **whale feed**, and instant
**Telegram alerts** — fully bilingual (English / العربية, RTL-aware).

> ⚠️ Educational tool, **not financial advice**. Trade at your own risk.

---

## Features

| Section | What it does | Data source |
|---|---|---|
| **Overview** | Market snapshot, Fear & Greed, KPIs, whale flow | CoinGecko + alternative.me |
| **Markets** | 300 coins, spot/futures, search, sparklines | CoinGecko |
| **Manual Signals** | Rule-based recommendations (auditable confluences) | Binance/OKX/Bybit klines |
| **Tracker** | Track picks, entry amount, live P&L | local |
| **AI Signals** | Deep per-coin AI analysis + market brief | LLM (Groq/OpenAI) |
| **AI Trader** | Autonomous: enters → staged TP/stop → self-reviews → learns | engine + LLM |
| **Smart Money** | Market structure (BOS/CHoCH/FVG), key levels per major | klines |
| **Whales** | Large single prints (accumulation/distribution), live | Binance aggTrades |
| **Backtest** | Walk-forward the spot strategy on real history | klines |
| **News** | Live crypto headlines + AI market-impact read | RSS + LLM |
| **Settings** | Language, Telegram status/test, data, risk params | — |

Everything runs on **real data** with graceful fallbacks. No keys are required
to run it — the AI falls back to a built-in local engine, and signals come from
public exchange APIs.

---

## Quick start (local)

```bash
npm install
cp .env.example .env.local   # optional — see below
npm run dev                  # http://localhost:3000
```

Open `http://localhost:3000` → it redirects straight into the dashboard.

### Optional keys (`.env.local`)

All optional — the app works without them.

- **`GROQ_API_KEY`** — free LLM for the AI features ([console.groq.com/keys](https://console.groq.com/keys)). Without it, a local analysis engine is used.
- **`TELEGRAM_BOT_TOKEN`** — push the best picks + trade alerts to your Telegram. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`), press **Start** on it once; the chat id is auto-detected.
- **`CRON_SECRET`** — protects the 24/7 scan endpoint (see Deployment).

---

## Telegram alerts

Once `TELEGRAM_BOT_TOKEN` is set and you've pressed **Start** on your bot, you
get pro signal-channel cards on every event:

```
#BTC/USDT - طويل🟢

نقطة الدخول: 64,143
وقف الخسارة: 62,500

الهدف 1: 66,580
الهدف 2: 68,210
الهدف 3: 70,650
```

…and result cards on exits (target hit / stop / breakeven / time exit) with the
realized % and duration. The autonomous trader also moves the stop to breakeven
after Target 1 and trails it after Target 2.

---

## Deployment (Vercel) — 24/7

The browser-driven trader runs only while the site is open. For **24/7** pushes
(site closed), deploy and schedule the server-side scan.

1. Push this repo to GitHub.
2. Import it at [vercel.com/new](https://vercel.com/new) (framework auto-detected: Next.js).
3. Add the env vars in **Project → Settings → Environment Variables**:
   `GROQ_API_KEY`, `TELEGRAM_BOT_TOKEN`, and `CRON_SECRET` (any long random string).
4. Deploy.

### Scheduling the scan

`vercel.json` already declares a cron hitting `/api/cron/scan` every 4 hours.
Vercel Cron sends the auth header automatically.

> **Free (Hobby) plan note:** Vercel Cron on Hobby runs **once per day**. For
> more frequent pushes for free, use an external scheduler instead — e.g.
> [cron-job.org](https://cron-job.org): create a job that GETs
> `https://YOUR-APP.vercel.app/api/cron/scan?key=YOUR_CRON_SECRET` every few hours.

You can trigger it manually anytime:

```bash
curl "https://YOUR-APP.vercel.app/api/cron/scan?key=YOUR_CRON_SECRET"
```

---

## Architecture

- **Next.js 15** (App Router) · **React 19** · **TypeScript** · **Tailwind v3** · **Framer Motion** · **TanStack Query**.
- **Route handlers** (`src/app/api/*`) proxy/compute server-side: markets, klines, signals, validation, fear&greed, news, AI, telegram, whales, structure, backtest, cron.
- **Signal engine** (`src/lib/signal-engine.ts`) — deterministic, auditable confluence scoring (trend, momentum, structure, volume, volatility) with HTF gating.
- **Autonomous trader** (`src/lib/trader-engine.ts` + `JournalWatcher`) — strict strategy, max 3 positions, market-regime guard, staged take-profit, adaptive confidence, self-review lessons.
- **Indicators** (`src/lib/indicators.ts`) — pure TA primitives (EMA/RSI/MACD/BB/ATR/VWAP/swings/FVG).
- Client state via `useSyncExternalStore` + localStorage (journal, tracker, lessons).
- API keys are **server-side only** — never shipped to the browser.

### Scripts

```bash
npm run dev     # dev server
npm run build   # production build
npm start       # run the production build
npm run lint    # lint
```

> **Windows + OneDrive:** the dev server can intermittently throw `EBUSY` on
> `.next` because OneDrive locks the folder during sync. The production build is
> unaffected. For a smooth dev experience, keep the project **outside** a synced
> OneDrive folder.

---

## Disclaimer

This software is for **education and research only**. It is **not financial
advice**, not a solicitation, and makes no guarantee of profit. Crypto trading
carries substantial risk of loss. You are solely responsible for your decisions.

<!-- deploy trigger -->
