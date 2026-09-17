/**
 * Single source of truth for configuration.
 *
 * Two design rules enforced here:
 *  1. The market-data venue is ONE setting (`MARKET_EXCHANGE`). Every adapter
 *     implements the same interface, so a Binance block or outage is a config
 *     change, not a code change.
 *  2. Paid providers are OFF unless a key is present. There is no "demo mode"
 *     that fabricates values — a keyless provider reports `not_configured`
 *     and the confidence score takes a declared, visible penalty.
 */
import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { z } from "zod";

// .env.local first (Next.js convention, gitignored), then .env.
loadDotenv({ path: ".env.local", quiet: true });
loadDotenv({ quiet: true });

const ExchangeId = z.enum(["binance", "bybit", "okx"]);
export type ExchangeId = z.infer<typeof ExchangeId>;

/** "" and "changeme" placeholders count as absent, not as a key. */
const optionalKey = z
  .string()
  .trim()
  .optional()
  .transform((v) => {
    if (!v) return undefined;
    const lowered = v.toLowerCase();
    if (lowered.startsWith("your_") || lowered.startsWith("change") || lowered === "none") {
      return undefined;
    }
    return v;
  });

const num = (fallback: number, min?: number, max?: number) =>
  z.coerce.number().pipe(z.number().min(min ?? -Infinity).max(max ?? Infinity)).default(fallback);

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? fallback : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const csv = (fallback: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ""
        ? fallback
        : v.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    );

const Schema = z.object({
  // ── market data ──────────────────────────────────────────────────────────
  MARKET_EXCHANGE: ExchangeId.default("binance"),
  /** Override the REST base (mirrors: data-api.binance.vision avoids some geo blocks). */
  BINANCE_SPOT_BASE: z.string().url().default("https://api.binance.com"),
  BINANCE_FUTURES_BASE: z.string().url().default("https://fapi.binance.com"),
  BINANCE_SPOT_WS: z.string().default("wss://stream.binance.com:9443/ws"),
  BINANCE_FUTURES_WS: z.string().default("wss://fstream.binance.com/ws"),
  BYBIT_BASE: z.string().url().default("https://api.bybit.com"),
  BYBIT_WS: z.string().default("wss://stream.bybit.com/v5/public/spot"),
  OKX_BASE: z.string().url().default("https://www.okx.com"),
  OKX_WS: z.string().default("wss://ws.okx.com:8443/ws/v5/public"),

  // ── free macro providers ─────────────────────────────────────────────────
  COINGECKO_BASE: z.string().url().default("https://api.coingecko.com/api/v3"),
  COINGECKO_API_KEY: optionalKey, // optional demo key raises the rate limit
  DEFILLAMA_BASE: z.string().url().default("https://api.llama.fi"),
  FEARGREED_BASE: z.string().url().default("https://api.alternative.me"),

  // ── paid providers: interfaces exist, disabled until a key appears ───────
  CRYPTOQUANT_API_KEY: optionalKey,
  CRYPTOQUANT_BASE: z.string().url().default("https://api.cryptoquant.com/v1"),
  COINGLASS_API_KEY: optionalKey,
  COINGLASS_BASE: z.string().url().default("https://open-api-v4.coinglass.com/api"),
  LUNARCRUSH_API_KEY: optionalKey,
  LUNARCRUSH_BASE: z.string().url().default("https://lunarcrush.com/api4/public"),

  // ── storage ──────────────────────────────────────────────────────────────
  DATA_DIR: z.string().default("./data"),
  DB_FILE: z.string().default("alslmany.db"),
  ARCHIVE_DIR: z.string().default("archive"),

  // ── http behaviour ───────────────────────────────────────────────────────
  HTTP_TIMEOUT_MS: num(15_000, 1_000, 120_000),
  HTTP_RETRIES: num(3, 0, 8),
  HTTP_USER_AGENT: z.string().default("alslmany-crypto/1.0 (+research bot)"),

  // ── risk (Section 4 of the spec — hard limits, not suggestions) ──────────
  RISK_PER_TRADE_PCT: num(1, 0.05, 5),
  MAX_OPEN_POSITIONS: num(6, 1, 20),
  MAX_CORRELATED_POSITIONS: num(3, 1, 10),
  CORRELATION_THRESHOLD: num(0.8, 0.1, 1),
  DAILY_LOSS_HALT_PCT: num(3, 0.5, 20),
  DAILY_HALT_HOURS: num(24, 1, 168),
  MAX_DRAWDOWN_HALT_PCT: num(15, 2, 60),
  PAPER_STARTING_EQUITY: num(10_000, 100),

  // ── decision thresholds (Stage 8 veto filters) ──────────────────────────
  /**
   * Spot only: BUY or nothing, never a short.
   *
   * Not a filter applied at the end — it narrows what the macro stage is
   * allowed to permit, so a bearish market produces NO TRADE rather than a
   * short that something downstream then has to catch. A spot account cannot
   * sell what it does not hold, and a system that reasons about shorts it can
   * never take is reasoning about a different account than yours.
   */
  SPOT_ONLY: bool(true),

  MIN_FINAL_SCORE: num(60, 0, 100),
  MIN_RISK_REWARD: num(1.8, 0.5, 10),
  MAX_BTC_CORRELATION_FOR_INDEPENDENCE: num(0.85, 0.5, 1),

  // ── universe ─────────────────────────────────────────────────────────────
  QUOTE_ASSET: z.string().default("USDT"),
  WATCHLIST: csv([]), // empty = auto-discover from the venue by volume
  UNIVERSE_MAX_SYMBOLS: num(120, 1, 1000),
  MIN_LISTING_AGE_DAYS: num(90, 0, 3650),

  // ── real trading: present from day one, hard-off ─────────────────────────
  LIVE_TRADING_ENABLED: bool(false),
  LIVE_EXCHANGE_API_KEY: optionalKey,
  LIVE_EXCHANGE_API_SECRET: optionalKey,

  // ── notifications ────────────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: optionalKey,
  TELEGRAM_CHAT_ID: optionalKey,
  TELEGRAM_QUIET_HOURS: z.string().default(""), // e.g. "23:00-07:00" UTC
  TELEGRAM_MAX_PER_HOUR: num(6, 1, 100),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type RawConfig = z.infer<typeof Schema>;

export interface ProviderFlag {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  /** Arabic explanation shown on the health page when disabled. */
  readonly note: string;
}

export interface AppConfig extends RawConfig {
  readonly dbPath: string;
  readonly archivePath: string;
  /** Which optional providers are live this run. */
  readonly providers: {
    readonly cryptoquant: ProviderFlag;
    readonly coinglass: ProviderFlag;
    readonly lunarcrush: ProviderFlag;
    readonly telegram: ProviderFlag;
    readonly liveTrading: ProviderFlag;
  };
}

function flag(id: string, label: string, enabled: boolean, disabledNote: string): ProviderFlag {
  return { id, label, enabled, note: enabled ? "مُفعَّل" : disabledNote };
}

let cached: AppConfig | null = null;

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached && env === process.env) return cached;

  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`إعدادات غير صالحة في ملف البيئة:\n${issues}`);
  }
  const raw = parsed.data;

  const cfg: AppConfig = {
    ...raw,
    dbPath: path.resolve(raw.DATA_DIR, raw.DB_FILE),
    archivePath: path.resolve(raw.DATA_DIR, raw.ARCHIVE_DIR),
    providers: {
      cryptoquant: flag(
        "cryptoquant",
        "CryptoQuant — بيانات السلسلة",
        Boolean(raw.CRYPTOQUANT_API_KEY),
        "ضع CRYPTOQUANT_API_KEY ليعمل. حتى ذلك الحين تُسجَّل بيانات السلسلة «غير متاحة».",
      ),
      coinglass: flag(
        "coinglass",
        "Coinglass — مشتقّات مجمّعة",
        Boolean(raw.COINGLASS_API_KEY),
        "ضع COINGLASS_API_KEY ليعمل. المشتقّات ستُقرأ من منصّة واحدة فقط بدونه.",
      ),
      lunarcrush: flag(
        "lunarcrush",
        "LunarCrush — المشاعر الاجتماعية",
        Boolean(raw.LUNARCRUSH_API_KEY),
        "ضع LUNARCRUSH_API_KEY ليعمل. تبقى المشاعر معتمدة على الخوف والطمع فقط.",
      ),
      telegram: flag(
        "telegram",
        "إشعارات تيليجرام",
        Boolean(raw.TELEGRAM_BOT_TOKEN),
        "ضع TELEGRAM_BOT_TOKEN ليعمل.",
      ),
      liveTrading: flag(
        "live_trading",
        "التداول الحقيقي",
        raw.LIVE_TRADING_ENABLED && Boolean(raw.LIVE_EXCHANGE_API_KEY),
        "معطّل عمداً. التنفيذ ورقي بالكامل.",
      ),
    },
  };

  if (env === process.env) cached = cfg;
  return cfg;
}

/** Test seam — drop the memoized config. */
export function resetConfigCache(): void {
  cached = null;
}
