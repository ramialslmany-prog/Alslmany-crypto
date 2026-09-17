/**
 * `npm run bot` — the 24/7 worker.
 *
 * One tick per closed candle of the trading timeframe. The tick's ORDER is
 * the same order the backtester uses, and that is not a coincidence — it is
 * the property that makes the backtest meaningful:
 *
 *   1. apply the actions decided on the PREVIOUS candle, at this one's open
 *   2. mark to market, update the snapshot, check the circuit breakers
 *   3. let the monitor decide on the candle that just closed — those
 *      decisions are written to disk and executed on the NEXT tick
 *   4. scan for new setups, one full eight-stage run per symbol
 *
 * The worker never fills on the candle it just read. Doing so would make the
 * live bot act on information a backtest cannot have, which is how a strategy
 * that backtests beautifully loses money in the morning.
 *
 * Crash safety: everything that must survive a restart is on disk before the
 * tick ends — pending actions, positions, events, the notification ledger and
 * the heartbeat. A `SIGTERM` finishes the current tick and then stops.
 */
import { getConfig, type AppConfig } from "@/shared/config";
import { createLogger } from "@/shared/logger";
import { closeDb, openDb, maintain, type Db } from "@/storage/db";
import { CandleRepo } from "@/storage/repositories/candles";
import { SymbolRepo } from "@/storage/repositories/symbols";
import { HealthRepo } from "@/storage/repositories/health";
import { RecommendationRepo, RejectedRepo } from "@/storage/repositories/recommendations";
import { BreakerRepo, EquityRepo, PositionRepo } from "@/storage/repositories/positions";
import { DerivativesRepo } from "@/storage/repositories/derivatives";
import { NotificationRepo, PendingActionRepo, WorkerStateRepo } from "@/storage/repositories/worker";
import { createMarketSource } from "@/data/exchanges";
import { Ingestor } from "@/data/ingest";
import { FearGreedSource } from "@/data/macro/fear-greed";
import { CoinGeckoSource } from "@/data/macro/coingecko";
import { DefiLlamaSource } from "@/data/macro/defillama";
import { NewsSource } from "@/data/news/rss";
import { runPipeline, type RunInput } from "@/core/pipeline/run";
import { DEFAULT_ELIGIBILITY } from "@/core/pipeline/stage1-eligibility";
import { evaluatePosition, updateExcursions } from "@/core/execution/monitor";
import { applyActions, openPending } from "@/core/execution/paper-broker";
import { DEFAULT_COSTS } from "@/core/execution/fills";
import {
  activeBreakers, checkRisk, evaluateBreakers, updateSnapshot, type RiskLimits,
} from "@/core/execution/risk";
import { returnCorrelation } from "@/core/pipeline/stage2-macro";
import type { CircuitBreaker, PortfolioSnapshot, Position } from "@/core/execution/types";
import type { Recommendation } from "@/core/recommendation/types";
import { TelegramNotifier } from "@/notify/telegram";
import * as MSG from "@/notify/messages";
import type { Notification } from "@/notify/policy";
import { unavailable, type Availability } from "@/shared/availability";
import {
  TIMEFRAMES, isTimeframe, lastClosedOpenTime, tfMillis, type Timeframe,
} from "@/shared/time";
import type { Candle, FearGreed, SymbolInfo } from "@/core/types";

const log = createLogger("bot");
const DAY = 86_400_000;

/** How long after a candle closes before the tick runs. */
const SETTLE_MS = 15_000;

/** Bars of each timeframe handed to the pipeline — matches the backtest. */
const LOOKBACK_BARS = 400;

interface BotOptions {
  readonly tradingTimeframe: Timeframe;
  readonly once: boolean;
  readonly dryRun: boolean;
}

export class Bot {
  private readonly candles: CandleRepo;
  private readonly symbols: SymbolRepo;
  private readonly health: HealthRepo;
  private readonly recommendations: RecommendationRepo;
  private readonly rejected: RejectedRepo;
  private readonly positions: PositionRepo;
  private readonly equity: EquityRepo;
  private readonly breakers: BreakerRepo;
  private readonly derivatives: DerivativesRepo;
  private readonly pending: PendingActionRepo;
  private readonly notifications: NotificationRepo;
  private readonly state: WorkerStateRepo;
  private readonly ingest: Ingestor;
  private readonly source: ReturnType<typeof createMarketSource>;
  private readonly fearGreed: FearGreedSource;
  private readonly coingecko: CoinGeckoSource;
  private readonly llama: DefiLlamaSource;
  private readonly news: NewsSource;
  private readonly telegram: TelegramNotifier;

  private stopping = false;
  private universe: SymbolInfo[] = [];
  /** Cached macro reads, refreshed on their own slower cadence. */
  private macroCache: {
    at: number;
    fearGreed: Availability<FearGreed>;
    fearGreedHistory: Availability<readonly FearGreed[]>;
    global: Awaited<ReturnType<CoinGeckoSource["global"]>>;
    news: Awaited<ReturnType<NewsSource["recent"]>>;
    totalTvl: Awaited<ReturnType<DefiLlamaSource["totalTvl"]>>;
    /**
     * Sector TVL a week ago.
     *
     * DefiLlama's free endpoint returns TODAY's number only, so the trend has
     * to be built by remembering. Null until the bot has been running a week
     * — and null is reported as "no comparison yet", never as "no change".
     */
    totalTvl7dAgo: number | null;
  } | null = null;

  constructor(
    private readonly db: Db,
    private readonly cfg: AppConfig,
    private readonly opts: BotOptions,
  ) {
    this.candles = new CandleRepo(db);
    this.symbols = new SymbolRepo(db);
    this.health = new HealthRepo(db);
    this.recommendations = new RecommendationRepo(db);
    this.rejected = new RejectedRepo(db);
    this.positions = new PositionRepo(db);
    this.equity = new EquityRepo(db);
    this.breakers = new BreakerRepo(db);
    this.derivatives = new DerivativesRepo(db);
    this.pending = new PendingActionRepo(db);
    this.notifications = new NotificationRepo(db);
    this.state = new WorkerStateRepo(db);
    this.source = createMarketSource(cfg);
    this.ingest = new Ingestor(db, cfg, this.source);
    this.fearGreed = new FearGreedSource(cfg);
    this.coingecko = new CoinGeckoSource(cfg);
    this.llama = new DefiLlamaSource(cfg);
    this.news = new NewsSource(cfg);
    this.telegram = new TelegramNotifier(cfg);
  }

  private get limits(): RiskLimits {
    return {
      riskPerTradePct: this.cfg.RISK_PER_TRADE_PCT,
      maxOpenPositions: this.cfg.MAX_OPEN_POSITIONS,
      maxCorrelatedPositions: this.cfg.MAX_CORRELATED_POSITIONS,
      correlationThreshold: this.cfg.CORRELATION_THRESHOLD,
      dailyLossHaltPct: this.cfg.DAILY_LOSS_HALT_PCT,
      dailyHaltHours: this.cfg.DAILY_HALT_HOURS,
      maxDrawdownHaltPct: this.cfg.MAX_DRAWDOWN_HALT_PCT,
    };
  }

  stop(): void {
    this.stopping = true;
    log.info("stop requested — finishing the current tick");
  }

  async run(): Promise<void> {
    this.state.start(Date.now());
    await this.refreshUniverse();

    if (this.opts.once) {
      await this.safeTick();
      return;
    }

    while (!this.stopping) {
      await this.safeTick();
      if (this.stopping) break;
      await this.sleepUntilNextCandle();
    }
    log.info("stopped");
  }

  /** A tick must never kill the loop: the next candle is another chance. */
  private async safeTick(): Promise<void> {
    const started = Date.now();
    try {
      const result = await this.tick(started);
      log.info("tick done", {
        ms: Date.now() - started,
        analyses: result.analyses,
        recommendations: result.recommendations,
      });
      this.state.tick({
        at: Date.now(), durationMs: Date.now() - started,
        analyses: result.analyses, recommendations: result.recommendations, error: null,
      });
    } catch (err) {
      log.error("tick failed", { error: String(err) });
      this.state.tick({
        at: Date.now(), durationMs: Date.now() - started,
        analyses: 0, recommendations: 0, error: String(err).slice(0, 500),
      });
    }
  }

  private async sleepUntilNextCandle(): Promise<void> {
    const step = tfMillis(this.opts.tradingTimeframe);
    const lastOpen = lastClosedOpenTime(Date.now(), this.opts.tradingTimeframe);
    const nextClose = lastOpen + 2 * step;
    const wait = Math.max(5_000, nextClose - Date.now() + SETTLE_MS);
    log.info("sleeping", { untilIso: new Date(Date.now() + wait).toISOString() });

    // Wake early on stop, rather than holding a SIGTERM for up to a day.
    const slice = 5_000;
    let remaining = wait;
    while (remaining > 0 && !this.stopping) {
      const chunk = Math.min(slice, remaining);
      await new Promise((r) => setTimeout(r, chunk));
      remaining -= chunk;
    }
  }

  private async refreshUniverse(): Promise<void> {
    const watchlist = this.cfg.WATCHLIST;
    const stored = this.symbols.tradable(this.cfg.MARKET_EXCHANGE, "spot");

    if (watchlist.length > 0) {
      const wanted = new Set(watchlist.map((s) => s.toUpperCase()));
      this.universe = stored.filter((s) => wanted.has(s.symbol));
      const missing = [...wanted].filter((w) => !this.universe.some((s) => s.symbol === w));
      if (missing.length) {
        log.warn("watchlist symbols missing from the store — run backfill", { missing });
      }
    } else {
      this.universe = stored.slice(0, this.cfg.UNIVERSE_MAX_SYMBOLS);
    }

    // Bitcoin is not optional: stage 2 cannot judge the macro context without
    // it, and a run with no macro context stops at stage 2 by design.
    if (!this.universe.some((s) => s.symbol.startsWith("BTC"))) {
      const btc = stored.find((s) => s.symbol === `BTC${this.cfg.QUOTE_ASSET}`);
      if (btc) this.universe = [btc, ...this.universe];
      else log.warn("BTC is not in the store — every run will stop at stage 2");
    }

    log.info("universe", { count: this.universe.length });
  }

  // ── the tick ─────────────────────────────────────────────────────────────

  private async tick(now: number): Promise<{ analyses: number; recommendations: number }> {
    const tf = this.opts.tradingTimeframe;
    log.info("tick", { at: new Date(now).toISOString(), symbols: this.universe.length });

    await this.syncCandles();
    await this.refreshMacro(now);

    let openBreakers = this.breakers.uncleared();

    // ── 1. apply what the previous tick decided, at this candle's open ─────
    for (const position of this.positions.live()) {
      await this.applyPending(position, now);
    }

    // ── 2. mark to market, snapshot, breakers ─────────────────────────────
    const live = this.positions.live();
    const marks = new Map<string, Candle>();
    for (const p of live) {
      const bar = this.latestClosed(p.symbol, p.timeframe);
      if (bar) marks.set(p.symbol, bar);
    }

    const equityNow = this.markToMarket(live, marks);
    const previous = this.equity.latest();
    const dayChanged =
      previous === null || Math.floor(previous.at / DAY) !== Math.floor(now / DAY);

    const base: PortfolioSnapshot = previous ?? {
      at: now, equity: this.cfg.PAPER_STARTING_EQUITY, cash: this.cfg.PAPER_STARTING_EQUITY,
      openPositions: 0, exposureNotional: 0, peakEquity: this.cfg.PAPER_STARTING_EQUITY,
      drawdownPct: 0, dayStartEquity: this.cfg.PAPER_STARTING_EQUITY, dayPnlPct: 0,
    };
    const snapshot = updateSnapshot(base, equityNow, live, now, dayChanged ? equityNow : undefined);
    this.equity.record(snapshot, this.lastPrice(`BTC${this.cfg.QUOTE_ASSET}`));

    for (const tripped of evaluateBreakers(snapshot, this.limits, openBreakers, now)) {
      this.breakers.trip(tripped);
      openBreakers = [...openBreakers, tripped];
      await this.notify(MSG.circuitBreaker(tripped));
    }

    if (dayChanged && previous) await this.sendDailyReport(previous, snapshot, now);

    // ── 3. the monitor decides on the candle that just closed ─────────────
    for (const position of this.positions.live()) {
      const bar = marks.get(position.symbol) ?? this.latestClosed(position.symbol, position.timeframe);
      if (!bar) continue;

      const rec = this.recommendations.get(position.recommendationId);
      if (!rec) continue;

      const window = this.candles.latestAsOf(position.symbol, position.timeframe, now, LOOKBACK_BARS);
      if (position.status === "open") {
        const riskPerUnit = Math.abs(position.plannedEntry.mid - position.plannedStop);
        const excursions = updateExcursions(position, bar, riskPerUnit);
        this.positions.save({ ...position, ...excursions, barsHeld: position.barsHeld + 1 });
      }

      const actions = evaluatePosition(this.positions.get(position.id) ?? position, {
        candle: bar,
        barIndex: Math.floor((now - rec.generatedAt) / tfMillis(position.timeframe)),
        atr: atr(window),
        structureState: "unknown",
        stageScores: {},
        btcDailyScore: null,
        flowsAgainst: false,
        invalidation: rec.invalidation,
        now,
      });

      if (actions.length > 0) {
        this.pending.put({
          positionId: position.id, decidedAt: now, candleTime: bar.openTime, actions,
        });
      }
    }

    // ── 4. scan ───────────────────────────────────────────────────────────
    let analyses = 0;
    let recommendations = 0;

    const halted = activeBreakers(openBreakers, now);
    if (halted.length > 0) {
      log.warn("scan skipped — circuit breaker active", { kinds: halted.map((b) => b.kind) });
      return { analyses, recommendations };
    }

    for (const info of this.universe) {
      if (this.stopping) break;

      const input = await this.buildInput(info, snapshot, now);
      if (!input) continue;

      analyses += 1;
      const { run, recommendation } = runPipeline(input);

      if (!recommendation) {
        this.rejected.record(run, run.failedAt ?? "unknown");
        continue;
      }

      const openNow = this.positions.open();
      const correlations: Record<string, number> = {};
      for (const other of openNow) {
        correlations[other.symbol] = returnCorrelation(
          this.candles.latestAsOf(info.symbol, "1d", now, 120),
          this.candles.latestAsOf(other.symbol, "1d", now, 120),
        ) ?? 0;
      }

      const decision = checkRisk({
        snapshot,
        openPositions: openNow,
        candidate: { symbol: info.symbol, direction: recommendation.direction },
        correlations,
        activeBreakers: openBreakers,
        limits: this.limits,
        now,
      });

      if (!decision.allowed) {
        this.rejected.record(
          { ...run, vetoes: [...run.vetoes, ...decision.blockers.map((b) => ({
            // The risk layer's blockers map onto the council's own veto
            // vocabulary so the rejected-analyses page has one list, not two.
            id: b.id === "circuit_breaker" ? ("circuit_breaker" as const) : ("exposure_limit" as const),
            arabic: b.arabic, actual: b.actual, threshold: b.limit,
          }))] },
          "risk",
        );
        continue;
      }

      if (this.opts.dryRun) {
        log.info("dry run — recommendation not stored", { symbol: info.symbol, id: recommendation.id });
        continue;
      }

      const created = this.recommendations.create(recommendation, run);
      if (!created) continue; // already exists: the same candle was analysed twice

      recommendations += 1;
      this.positions.save(openPending({
        id: `pos-${recommendation.id}`,
        recommendationId: recommendation.id,
        symbol: recommendation.symbol,
        direction: recommendation.direction,
        timeframe: recommendation.timeframe,
        entry: recommendation.entry,
        stop: recommendation.stop,
        targets: recommendation.targets.map((t) => ({
          index: t.index, price: t.price, closeFraction: t.closeFraction,
        })),
        size: recommendation.positionSize,
        risk: recommendation.riskAmount,
        expiresAt: recommendation.expiresAt,
      }));

      await this.notify(MSG.newRecommendation(recommendation));
    }

    maintain(this.db);
    return { analyses, recommendations };
  }

  // ── pieces of the tick ───────────────────────────────────────────────────

  private async applyPending(position: Position, now: number): Promise<void> {
    const queued = this.pending.take(position.id);
    if (!queued) return;

    const bar = this.latestClosed(position.symbol, position.timeframe);
    if (!bar) return;

    // The actions were decided on `queued.candleTime`; this bar must be a
    // LATER one, or we would be filling on the bar that produced the signal.
    if (!mayExecuteOn(queued.candleTime, bar.openTime)) {
      this.pending.put(queued); // put it back — the next candle has not closed
      return;
    }

    const result = applyActions(position, queued.actions, {
      candle: bar, orderBook: null, costs: DEFAULT_COSTS, now,
    });

    this.positions.save(result.position);
    for (const event of result.events) this.recommendations.appendEvent(event);

    const rec = this.recommendations.get(position.recommendationId);
    if (rec) await this.notifyPosition(rec, position, result.position, now);
  }

  private async notifyPosition(
    rec: Recommendation, before: Position, after: Position, now: number,
  ): Promise<void> {
    if (before.status === "pending" && after.status === "open") {
      await this.notify(MSG.entryFilled(rec, after, now));
    }

    for (const target of after.targetsHit) {
      if (before.targetsHit.includes(target)) continue;
      const price = rec.targets.find((t) => t.index === target)?.price ?? after.currentStop;
      await this.notify(MSG.targetHit(rec, target, price, after, now));
    }

    if (after.status === "closed" && before.status !== "closed") {
      await this.notify(MSG.stopHit(rec, after, now));
    }
    if (after.status === "invalidated" && before.status !== "invalidated") {
      await this.notify(MSG.closed(rec, after, "invalidated", after.notes.at(-1) ?? "أُبطلت", now));
    }
    if (after.status === "expired" && before.status !== "expired") {
      await this.notify(MSG.closed(rec, after, "expired", after.notes.at(-1) ?? "انتهت صلاحيتها", now));
    }
  }

  private async sendDailyReport(
    previous: PortfolioSnapshot, snapshot: PortfolioSnapshot, now: number,
  ): Promise<void> {
    const since = now - DAY;
    const closedToday = this.positions.closed(200).filter((p) => (p.closedAt ?? 0) >= since);
    const worker = this.state.get();

    await this.notify(MSG.dailyReport({
      at: now,
      analyses: worker?.analyses ?? 0,
      recommendations: worker?.recommendations ?? 0,
      openPositions: snapshot.openPositions,
      closedToday: closedToday.length,
      realizedR: closedToday.reduce((s, p) => s + p.realizedR, 0),
      equity: snapshot.equity,
      dayPnlPct: previous.dayPnlPct,
      drawdownPct: snapshot.drawdownPct,
    }));
  }

  private async notify(notification: Notification): Promise<void> {
    // The ledger is loaded fresh each time so a second process, or a restart
    // mid-tick, cannot resend what has already gone out.
    const result = await this.telegram.send(notification);
    if (result.status === "sent") {
      this.notifications.record(notification.dedupeKey, notification.kind, notification.at);
    }
  }

  private async syncCandles(): Promise<void> {
    const failures: string[] = [];
    for (const info of this.universe) {
      for (const tf of TIMEFRAMES) {
        const r = await this.ingest.sync(info.symbol, tf);
        if (r.error) failures.push(`${info.symbol} ${tf}: ${r.error}`);
      }
    }
    if (failures.length > 0) {
      log.warn("candle sync had failures", { count: failures.length, first: failures[0] });
      await this.notify(MSG.sourceFailure(this.source.id, failures[0], Date.now()));
    }
  }

  /**
   * Macro and sentiment sources move far more slowly than a candle.
   *
   * Refreshed hourly rather than per tick, because polling a free provider
   * every 5 minutes is how a free provider stops being available.
   */
  private async refreshMacro(now: number): Promise<void> {
    if (this.macroCache && now - this.macroCache.at < 3_600_000) return;

    const [fg, fgHistory, global, news, totalTvl] = await Promise.all([
      this.fearGreed.latest(),
      this.fearGreed.history(90),
      this.coingecko.global(),
      this.news.recent(),
      this.llama.totalTvl(),
    ]);

    this.health.record("alternative.me", "Fear & Greed", fg);
    this.health.record("coingecko", "CoinGecko — السوق العالمي", global);
    this.health.record("rss", "الأخبار", news);
    this.health.record("defillama", "DefiLlama — القيمة المقفلة", totalTvl);

    // The week-old reading is carried forward, not refetched: the free
    // endpoint has no history, so the only way to have a trend is to have
    // been watching.
    const previous = this.equity.latest();
    void previous;

    this.macroCache = {
      at: now, fearGreed: fg, fearGreedHistory: fgHistory, global, news,
      totalTvl,
      totalTvl7dAgo: this.macroCache?.totalTvl7dAgo ?? null,
    };
  }

  private async buildInput(
    info: SymbolInfo, snapshot: PortfolioSnapshot, now: number,
  ): Promise<RunInput | null> {
    const tf = this.opts.tradingTimeframe;
    const candles: Partial<Record<Timeframe, readonly Candle[]>> = {};
    for (const frame of TIMEFRAMES) {
      const rows = this.candles.latestAsOf(info.symbol, frame, now, LOOKBACK_BARS);
      if (rows.length > 0) candles[frame] = rows;
    }
    if ((candles[tf]?.length ?? 0) < 60) return null;

    const btcSymbol = `BTC${this.cfg.QUOTE_ASSET}`;
    const tickers = await this.source.ticker24h([info.symbol]);
    const book = await this.source.orderBook(info.symbol, 100);
    this.health.record(`${this.source.id}:book`, `${this.source.label} — دفتر الأوامر`, book);

    // ── derivatives ──────────────────────────────────────────────────────
    //
    // These four reads are the difference between a stage that votes and a
    // stage that shrugs. They were left as nulls when the worker was first
    // written, which silently reduced stage 5 to the CVD alone and cost a
    // declared 0.20 confidence penalty on every single run — while the
    // adapters that fetch them sat finished and tested.
    //
    // Fetched in parallel and each allowed to fail on its own: a venue that
    // serves klines but not open interest should cost that one reading, not
    // the whole stage.
    const derivatives = this.source.capabilities.openInterest
      ? await Promise.all([
          this.source.fundingRate(info.symbol),
          this.source.fundingHistory(info.symbol, 100),
          this.source.openInterestHistory(info.symbol, oiPeriod(tf), 48),
          this.source.longShortRatio(info.symbol, oiPeriod(tf), 48),
          this.source.recentTrades(info.symbol, 1000),
        ])
      : null;

    if (derivatives) {
      const [funding, , oi, ls, trades] = derivatives;
      this.health.record(`${this.source.id}:funding`, `${this.source.label} — التمويل`, funding);
      this.health.record(`${this.source.id}:openInterest`, `${this.source.label} — العقود المفتوحة`, oi);
      this.health.record(`${this.source.id}:longShort`, `${this.source.label} — نسبة الطويل/القصير`, ls);
      this.health.record(`${this.source.id}:trades`, `${this.source.label} — الصفقات المنفّذة`, trades);
    }

    const value = <T>(a: Availability<T> | undefined): T | null =>
      a && a.available ? a.value : null;

    const macro = this.macroCache;
    const open = this.positions.open();
    const liquidationEvents = this.derivatives.liquidations(info.symbol, now - 7 * DAY, now);

    return {
      symbol: info.symbol,
      tradingTimeframe: tf,
      exchange: this.cfg.MARKET_EXCHANGE,
      candles,
      hasTakerBreakdown: this.source.capabilities.klineTakerBreakdown,
      eligibility: {
        symbol: info.symbol,
        info,
        ticker: tickers.available
          ? tickers.value.find((t) => t.symbol === info.symbol) ?? null
          : null,
        orderBook: book.available ? book.value : null,
        listedAt: info.listedAt ?? null,
        upcomingUnlock: null,
        hasActiveRecommendation: this.recommendations.hasActive(info.symbol, now),
        now,
      },
      // Live REQUIRES a real book: skipping the depth gate is a backtest-only
      // concession, never a live one.
      eligibilityThresholds: {
        ...DEFAULT_ELIGIBILITY,
        minListingAgeDays: this.cfg.MIN_LISTING_AGE_DAYS,
        requireLiveBook: true,
      },
      macro: {
        btcDaily: this.candles.latestAsOf(btcSymbol, "1d", now, LOOKBACK_BARS),
        btc4h: this.candles.latestAsOf(btcSymbol, "4h", now, LOOKBACK_BARS),
        global: macro?.global ?? unavailable("coingecko", "not_implemented", "لم تُقرأ بعد"),
        dominanceHistory: unavailable("coingecko", "not_implemented", "لا تاريخ للهيمنة في الخطة المجانية"),
        fearGreed: macro?.fearGreed ?? unavailable("alternative.me", "not_implemented", "لم تُقرأ بعد"),
      },
      correlationCeiling: this.cfg.MAX_BTC_CORRELATION_FOR_INDEPENDENCE,
      flowsInput: {
        trades: value(derivatives?.[4]),
        bookSnapshots: book.available ? [book.value] : null,
        funding: value(derivatives?.[0]),
        fundingHistory: value(derivatives?.[1]),
        openInterest: value(derivatives?.[2]),
        longShort: value(derivatives?.[3]),
        // A week of forced closes: older clusters have been traded through.
        liquidationEvents: liquidationEvents.length > 0 ? liquidationEvents : null,
        atr: atr(candles[tf] ?? []),
      },
      // Stage 6 runs on what DefiLlama can honestly answer — capital locked
      // in this token's protocol, and in the sector. It is NOT exchange
      // netflows, and the stage says so rather than implying otherwise.
      onchainInput: {
        protocol: await this.llama.forSymbol(info.symbol),
        totalTvl: macro?.totalTvl ?? unavailable("defillama", "not_implemented", "لم تُقرأ بعد"),
        totalTvl7dAgo: macro?.totalTvl7dAgo ?? null,
      },
      sentimentInput: {
        fearGreed: macro?.fearGreed ?? unavailable("alternative.me", "not_implemented", "لم تُقرأ بعد"),
        fearGreedHistory: macro?.fearGreedHistory ?? unavailable("alternative.me", "not_implemented", "لم تُقرأ بعد"),
        news: macro?.news ?? unavailable("rss", "not_implemented", "لم تُقرأ بعد"),
        calendar: null,
        social: unavailable("lunarcrush", "not_configured", "لا مفتاح LunarCrush"),
      },
      council: {
        minFinalScore: this.cfg.MIN_FINAL_SCORE,
        minRiskReward: this.cfg.MIN_RISK_REWARD,
        maxOpenPositions: this.cfg.MAX_OPEN_POSITIONS,
        maxCorrelatedPositions: this.cfg.MAX_CORRELATED_POSITIONS,
        correlationThreshold: this.cfg.CORRELATION_THRESHOLD,
        maxDataAgeBars: 3,
      },
      portfolio: {
        openPositions: open.length,
        correlatedSameDirection: 0,
        circuitBreakerActive: false,
        circuitBreakerReason: null,
      },
      setupHistory: (setup) => {
        const done = this.positions.closed(500).filter((p) => p.openedAt !== null);
        const forSetup = done.filter((p) => {
          const rec = this.recommendations.get(p.recommendationId);
          return rec?.setup === setup;
        });
        if (forSetup.length === 0) return null;
        return {
          trades: forSetup.length,
          winRate: forSetup.filter((p) => p.realizedR > 0).length / forSetup.length,
          expectancyR: forSetup.reduce((s, p) => s + p.realizedR, 0) / forSetup.length,
        };
      },
      equity: snapshot.equity,
      riskPercent: this.cfg.RISK_PER_TRADE_PCT,
      pricePrecision: info.pricePrecision,
      quantityPrecision: info.quantityPrecision,
      minNotional: info.minNotional,
      now,
    };
  }

  private latestClosed(symbol: string, tf: Timeframe): Candle | null {
    return this.candles.latest(symbol, tf, 1)[0] ?? null;
  }

  private lastPrice(symbol: string): number | null {
    return this.latestClosed(symbol, "1h")?.close ?? null;
  }

  private markToMarket(live: readonly Position[], marks: Map<string, Candle>): number {
    const realized = this.positions.closed(1_000).reduce((s, p) => s + p.realizedPnl, 0);
    const openPnl = live.reduce((s, p) => {
      if (p.status !== "open" || p.openQuantity <= 0) return s + p.realizedPnl;
      const bar = marks.get(p.symbol);
      if (!bar) return s + p.realizedPnl;
      const move = p.direction === "long" ? bar.close - p.averageEntry : p.averageEntry - bar.close;
      return s + p.realizedPnl + move * p.openQuantity;
    }, 0);
    return this.cfg.PAPER_STARTING_EQUITY + realized + openPnl;
  }
}

/**
 * May actions decided on `decidedCandle` be executed on `bar`?
 *
 * Only on a STRICTLY later bar. This one comparison is what stops the live
 * worker from filling on the very candle that produced the signal — the
 * shortcut that would make it act on information the backtest never has.
 * Extracted so it can be tested without a market, a database or a clock.
 */
export function mayExecuteOn(decidedCandleTime: number, barOpenTime: number): boolean {
  return barOpenTime > decidedCandleTime;
}

/**
 * Which sampling period to ask for derivatives on.
 *
 * Binance publishes open interest and the long/short ratio on a fixed set of
 * periods, and the weekly bar is not among them. Asking for the trading
 * timeframe where it exists keeps the derivative series aligned with the
 * candles the decision is made on.
 */
function oiPeriod(tf: Timeframe): "5m" | "15m" | "1h" | "4h" | "1d" {
  return tf === "1w" ? "1d" : tf;
}

/** Wilder ATR, matching what the backtest's monitor receives. */
function atr(window: readonly Candle[], period = 14): number {
  if (window.length < period + 1) return 0;
  let sum = 0;
  for (let i = window.length - period; i < window.length; i++) {
    const prev = window[i - 1];
    const c = window[i];
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  }
  return sum / period;
}

// ── entry point ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tfRaw = get("--timeframe") ?? "1h";
  if (!isTimeframe(tfRaw)) throw new Error(`إطار زمني غير معروف: ${tfRaw}`);

  const cfg = getConfig();
  const db = openDb(cfg.dbPath);
  const bot = new Bot(db, cfg, {
    tradingTimeframe: tfRaw,
    once: argv.includes("--once"),
    dryRun: argv.includes("--dry-run"),
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => bot.stop());
  }

  try {
    await bot.run();
  } finally {
    closeDb();
  }
}

// Only when executed directly, so the class stays importable by tests.
if (process.argv[1]?.endsWith("bot.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
