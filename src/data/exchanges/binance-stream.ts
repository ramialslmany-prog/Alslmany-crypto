/**
 * Binance live stream.
 *
 * Three failure modes must be survived for a bot that runs 24/7, and each one
 * is handled explicitly below — none of them are theoretical:
 *
 *  1. Binance FORCE-CLOSES every websocket after 24 hours. A stream with no
 *     reconnect logic silently dies once a day.
 *  2. A TCP connection can stay "open" while delivering nothing (a black-hole
 *     route, a sleeping container). We therefore track last-message time and
 *     tear the socket down ourselves if it goes quiet.
 *  3. Reconnecting must re-send the subscription — the server keeps no state.
 *
 * Reconnects use exponential backoff with jitter and never give up, because
 * giving up means the bot is blind but still believes it is running.
 */
import WebSocket from "ws";
import type { AppConfig } from "@/shared/config";
import { createLogger } from "@/shared/logger";
import { tfMillis, type Timeframe } from "@/shared/time";
import type { MarketStream, StreamEvent, StreamSubscription } from "@/data/market-source";
import type { Candle, Liquidation, OrderBook, Trade } from "@/core/types";

const log = createLogger("binance:ws");

/** If no frame of any kind arrives within this window, assume the socket is dead. */
const SILENCE_TIMEOUT_MS = 90_000;
/** Reconnect well before Binance's own 24h cut, at a moment we choose. */
const PROACTIVE_RECYCLE_MS = 23 * 60 * 60 * 1000;
const MAX_BACKOFF_MS = 60_000;

export class BinanceStream implements MarketStream {
  private ws: WebSocket | null = null;
  private handlers = new Set<(e: StreamEvent) => void>();
  private stopped = false;
  private attempt = 0;
  private lastMessageAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private recycleTimer: NodeJS.Timeout | null = null;
  private openResolve: (() => void) | null = null;

  constructor(
    private readonly cfg: AppConfig,
    private readonly sub: StreamSubscription,
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  on(handler: (e: StreamEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(e: StreamEvent): void {
    for (const h of this.handlers) {
      try {
        h(e);
      } catch (err) {
        log.error("handler threw", { err: String(err) });
      }
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    const opened = new Promise<void>((resolve) => {
      this.openResolve = resolve;
    });
    this.connect();
    // Do not block the caller forever if the venue is unreachable — the
    // reconnect loop keeps running in the background either way.
    await Promise.race([opened, delay(this.cfg.HTTP_TIMEOUT_MS)]);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
  }

  private streamNames(): string[] {
    const names: string[] = [];
    const market = this.sub.market ?? "spot";
    for (const raw of this.sub.symbols) {
      const s = raw.toLowerCase();
      if (this.sub.channels.includes("candle")) {
        for (const tf of this.sub.timeframes ?? []) names.push(`${s}@kline_${tf}`);
      }
      if (this.sub.channels.includes("trade")) names.push(`${s}@aggTrade`);
      if (this.sub.channels.includes("book")) names.push(`${s}@depth20@100ms`);
      if (this.sub.channels.includes("liquidation") && market === "perp") {
        names.push(`${s}@forceOrder`);
      }
    }
    return names;
  }

  private endpoint(): string {
    return this.sub.market === "perp" ? this.cfg.BINANCE_FUTURES_WS : this.cfg.BINANCE_SPOT_WS;
  }

  private connect(): void {
    if (this.stopped) return;
    const names = this.streamNames();
    if (names.length === 0) {
      log.warn("no streams requested — not connecting");
      return;
    }
    // Binance caps a single connection at 1024 streams.
    if (names.length > 1024) {
      log.error("too many streams for one socket", { count: names.length });
    }

    const url = this.endpoint();
    log.info("connecting", { url, streams: names.length });
    this.emit({ type: "status", state: this.attempt === 0 ? "connected" : "reconnecting" });

    const ws = new WebSocket(url, { handshakeTimeout: 15_000 });
    this.ws = ws;

    ws.on("open", () => {
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      ws.send(JSON.stringify({ method: "SUBSCRIBE", params: names, id: Date.now() }));
      log.info("connected", { streams: names.length });
      this.emit({ type: "status", state: "connected" });
      this.openResolve?.();
      this.openResolve = null;
      this.startTimers();
    });

    ws.on("message", (raw) => {
      this.lastMessageAt = Date.now();
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.route(msg);
    });

    // `ws` answers server pings automatically; this is only for observability.
    ws.on("ping", () => {
      this.lastMessageAt = Date.now();
    });

    ws.on("error", (err) => {
      log.warn("socket error", { err: err.message });
    });

    ws.on("close", (code) => {
      this.clearTimers();
      if (this.stopped) return;
      this.emit({ type: "status", state: "reconnecting", detail: `code ${code}` });
      const wait = backoff(this.attempt++);
      log.warn("socket closed — reconnecting", { code, waitMs: wait, attempt: this.attempt });
      setTimeout(() => this.connect(), wait);
    });
  }

  private startTimers(): void {
    this.clearTimers();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastMessageAt > SILENCE_TIMEOUT_MS) {
        log.warn("socket silent — forcing reconnect", {
          silentMs: Date.now() - this.lastMessageAt,
        });
        this.ws?.terminate(); // triggers "close" → reconnect
      }
    }, 15_000);

    this.recycleTimer = setTimeout(() => {
      log.info("proactive socket recycle (ahead of the venue's 24h cut)");
      this.ws?.terminate();
    }, PROACTIVE_RECYCLE_MS);
  }

  private clearTimers(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.recycleTimer) clearTimeout(this.recycleTimer);
    this.watchdog = null;
    this.recycleTimer = null;
  }

  private route(msg: unknown): void {
    const m = msg as Record<string, unknown>;
    // Subscription acks have { result: null, id } and carry no payload.
    if (!("e" in m) && !("lastUpdateId" in m)) return;

    switch (m.e) {
      case "kline":
        this.onKline(m as unknown as KlineMsg);
        return;
      case "aggTrade":
        this.onAggTrade(m as unknown as AggTradeMsg);
        return;
      case "forceOrder":
        this.onForceOrder(m as unknown as ForceOrderMsg);
        return;
      case "depthUpdate":
        return; // we use the partial-book stream, not the diff stream
      default:
        if ("lastUpdateId" in m) this.onPartialBook(m as unknown as PartialBookMsg);
    }
  }

  private onKline(m: KlineMsg): void {
    const k = m.k;
    const tf = k.i as Timeframe;
    const candle: Candle = {
      openTime: k.t,
      // Normalize to the exclusive boundary, matching the REST adapter.
      closeTime: k.t + tfMillis(tf),
      open: Number(k.o),
      high: Number(k.h),
      low: Number(k.l),
      close: Number(k.c),
      volume: Number(k.v),
      quoteVolume: Number(k.q),
      trades: k.n,
      takerBuyBase: Number(k.V),
      takerBuyQuote: Number(k.Q),
    };
    // `k.x` is the venue's own "this bar is final" flag. Consumers that make
    // decisions must gate on `closed === true`; the rest is display only.
    this.emit({ type: "candle", symbol: m.s, timeframe: tf, candle, closed: k.x });
  }

  private onAggTrade(m: AggTradeMsg): void {
    const trade: Trade = {
      id: m.a,
      price: Number(m.p),
      quantity: Number(m.q),
      quoteQuantity: Number(m.p) * Number(m.q),
      timestamp: m.T,
      buyerIsMaker: m.m,
    };
    this.emit({ type: "trade", symbol: m.s, trade });
  }

  private onPartialBook(m: PartialBookMsg): void {
    if (!m.s) return; // the raw partial-book payload carries no symbol on /ws
    const book: OrderBook = {
      symbol: m.s,
      bids: m.bids.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
      asks: m.asks.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
      timestamp: Date.now(),
      lastUpdateId: m.lastUpdateId,
    };
    this.emit({ type: "book", symbol: m.s, book });
  }

  private onForceOrder(m: ForceOrderMsg): void {
    const o = m.o;
    // A forced SELL closes a LONG; a forced BUY closes a SHORT.
    const side: Liquidation["side"] = o.S === "SELL" ? "long" : "short";
    const price = Number(o.ap) || Number(o.p);
    const qty = Number(o.z) || Number(o.q);
    this.emit({
      type: "liquidation",
      liquidation: {
        symbol: o.s,
        side,
        price,
        quantity: qty,
        quoteQuantity: price * qty,
        timestamp: o.T,
      },
    });
  }
}

interface KlineMsg {
  e: "kline";
  s: string;
  k: {
    t: number;
    i: string;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
    q: string;
    n: number;
    V: string;
    Q: string;
    x: boolean;
  };
}

interface AggTradeMsg {
  e: "aggTrade";
  s: string;
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

interface PartialBookMsg {
  lastUpdateId: number;
  s?: string;
  bids: [string, string][];
  asks: [string, string][];
}

interface ForceOrderMsg {
  e: "forceOrder";
  o: { s: string; S: "BUY" | "SELL"; p: string; ap: string; q: string; z: string; T: number };
}

function backoff(attempt: number): number {
  const exp = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
