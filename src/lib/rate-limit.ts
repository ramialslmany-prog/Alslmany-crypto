import "server-only";

/**
 * Request rate limiting.
 *
 * Every public route here proxies to Binance, OKX or CoinGecko. Those APIs
 * rate-limit by *our* server's IP, not by the visitor's — so a single script
 * hammering this site burns the shared quota and gets the deployment
 * temporarily banned upstream. The site then breaks for everyone, and the bot
 * stops being able to manage open positions.
 *
 * That makes this a correctness concern rather than a nicety: the expensive
 * routes are the ones that fan out to several exchanges at once, and they are
 * exactly the ones worth protecting.
 *
 * In-memory and per-instance, which is the honest scope for a serverless
 * deployment: it blunts casual abuse and accidental loops, and it does not
 * pretend to be a distributed limiter.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/** Bound the map so a flood of distinct keys cannot grow it without limit. */
const MAX_KEYS = 5_000;

function sweep(now: number) {
  if (buckets.size < MAX_KEYS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  // Still full of live buckets: drop the oldest half rather than grow.
  if (buckets.size >= MAX_KEYS) {
    const sorted = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (const [key] of sorted.slice(0, Math.floor(MAX_KEYS / 2))) buckets.delete(key);
  }
}

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms when the window resets. */
  resetAt: number;
  retryAfterSeconds: number;
};

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const bucket = { count: 1, resetAt: now + windowMs };
    buckets.set(key, bucket);
    return {
      allowed: true,
      limit,
      remaining: limit - 1,
      resetAt: bucket.resetAt,
      retryAfterSeconds: 0,
    };
  }

  existing.count++;
  const allowed = existing.count <= limit;
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
    retryAfterSeconds: allowed ? 0 : Math.ceil((existing.resetAt - now) / 1000),
  };
}

/**
 * Identify the caller.
 *
 * Behind Vercel the client address arrives in x-forwarded-for; the first entry
 * is the original client. Falling back to a shared bucket is deliberate — an
 * unidentifiable caller should be limited alongside the others rather than
 * handed an unlimited lane by being anonymous.
 */
export function clientKey(req: Request, scope: string): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const ip =
    forwarded?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    "unknown";
  return `${scope}:${ip}`;
}

/** Per-route budgets, sized by how much upstream work each request causes. */
export const LIMITS = {
  /** Fans out across the whole universe and several timeframes each. */
  scan: { limit: 20, windowMs: 60_000 },
  /** One asset, but a full multi-timeframe stack plus derivatives and depth. */
  analyze: { limit: 40, windowMs: 60_000 },
  /** Walks months of history through the engine. */
  backtest: { limit: 10, windowMs: 60_000 },
  /** Cheap, cached reads. */
  light: { limit: 120, windowMs: 60_000 },
  /** Mutates the ledger. */
  mutate: { limit: 10, windowMs: 60_000 },
} as const;
