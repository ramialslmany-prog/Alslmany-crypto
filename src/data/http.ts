/**
 * The only outbound HTTP path in the system.
 *
 * Centralised so that rate limits, retries, timeouts and latency accounting
 * are enforced identically for every provider — and so the health page can
 * report real numbers (consumed quota, p95 latency) instead of guesses.
 *
 * Every call returns an `Availability`, never a throw: a dead provider must
 * degrade the confidence score, not crash the 24/7 worker.
 */
import {
  type Availability,
  available,
  unavailable,
  type UnavailableReason,
} from "@/shared/availability";
import { createLogger } from "@/shared/logger";

const log = createLogger("http");

/** Per-host token bucket. Binance counts weight, not requests, so the budget
 *  is expressed in weight units and each call declares its own cost. */
class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    readonly capacity: number,
    /** tokens restored per second */
    readonly refillRate: number,
  ) {
    this.tokens = capacity;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  /** Milliseconds to wait before `cost` tokens are available. 0 = go now. */
  waitFor(cost: number): number {
    this.refill();
    if (this.tokens >= cost) return 0;
    return Math.ceil(((cost - this.tokens) / this.refillRate) * 1000);
  }

  take(cost: number): void {
    this.refill();
    this.tokens -= cost;
  }

  /** 0..1 — how much of the budget is currently consumed. For the health page. */
  utilization(): number {
    this.refill();
    return 1 - Math.max(0, this.tokens) / this.capacity;
  }
}

const buckets = new Map<string, TokenBucket>();

/**
 * Register a host budget. Defaults are deliberately conservative: getting
 * IP-banned by an exchange takes the whole bot offline for minutes.
 */
export function configureRateLimit(host: string, capacity: number, refillPerSecond: number): void {
  buckets.set(host, new TokenBucket(capacity, refillPerSecond));
}

function bucketFor(host: string): TokenBucket {
  let b = buckets.get(host);
  if (!b) {
    b = new TokenBucket(60, 1); // safe default: 60 burst, 1/s sustained
    buckets.set(host, b);
  }
  return b;
}

export interface HostHealth {
  readonly host: string;
  readonly utilization: number;
  readonly requests: number;
  readonly failures: number;
  readonly lastLatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly lastErrorAt: number | null;
  readonly lastError: string | null;
}

interface HostStats {
  requests: number;
  failures: number;
  latencies: number[];
  lastLatencyMs: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
}

const stats = new Map<string, HostStats>();

function statsFor(host: string): HostStats {
  let s = stats.get(host);
  if (!s) {
    s = { requests: 0, failures: 0, latencies: [], lastLatencyMs: null, lastErrorAt: null, lastError: null };
    stats.set(host, s);
  }
  return s;
}

/** Snapshot for the health page. */
export function httpHealth(): HostHealth[] {
  return [...stats.entries()].map(([host, s]) => {
    const sorted = [...s.latencies].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null;
    return {
      host,
      utilization: bucketFor(host).utilization(),
      requests: s.requests,
      failures: s.failures,
      lastLatencyMs: s.lastLatencyMs,
      p95LatencyMs: p95,
      lastErrorAt: s.lastErrorAt,
      lastError: s.lastError,
    };
  });
}

export function resetHttpStats(): void {
  stats.clear();
  buckets.clear();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FetchOptions {
  /** Rate-limit cost of this call (Binance "weight"). Default 1. */
  weight?: number;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** Label used in logs and in the Availability envelope. */
  source: string;
  signal?: AbortSignal;
  userAgent?: string;
}

/** HTTP statuses worth retrying. 429 is handled separately via Retry-After. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524]);

/**
 * GET JSON with rate limiting, retry/backoff and a hard timeout.
 *
 * Note for self-hosting behind a corporate proxy: Node's built-in fetch does
 * not read HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 (Node >= 22.21).
 */
export async function getJson<T>(url: string, opts: FetchOptions): Promise<Availability<T>> {
  const { source } = opts;
  const weight = opts.weight ?? 1;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRetries = opts.retries ?? 3;
  const host = safeHost(url);
  const bucket = bucketFor(host);
  const st = statsFor(host);

  let lastReason: UnavailableReason = "network_error";
  let lastDetail = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) return unavailable(source, "timeout", "أُلغي الطلب");

    const wait = bucket.waitFor(weight);
    if (wait > 0) {
      log.debug("rate limit wait", { host, ms: wait });
      await sleep(wait);
    }
    bucket.take(weight);

    const started = Date.now();
    st.requests++;

    try {
      const res = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": opts.userAgent ?? "alslmany-crypto/1.0",
          ...opts.headers,
        },
        signal: combineSignals(AbortSignal.timeout(timeoutMs), opts.signal),
      });

      const latency = Date.now() - started;
      st.lastLatencyMs = latency;
      st.latencies.push(latency);
      if (st.latencies.length > 200) st.latencies.shift();

      if (res.ok) {
        try {
          const body = (await res.json()) as T;
          return available(body, source, Date.now());
        } catch (err) {
          st.failures++;
          st.lastError = "JSON parse failed";
          st.lastErrorAt = Date.now();
          return unavailable(source, "bad_response", String(err));
        }
      }

      st.failures++;
      st.lastError = `HTTP ${res.status}`;
      st.lastErrorAt = Date.now();

      if (res.status === 429 || res.status === 418) {
        lastReason = "rate_limited";
        const retryAfter = Number(res.headers.get("retry-after") ?? 0);
        const backoff = retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt, 2000);
        lastDetail = `HTTP ${res.status}، إعادة المحاولة بعد ${Math.round(backoff / 1000)}ث`;
        log.warn("rate limited", { host, status: res.status, backoff });
        if (attempt < maxRetries) {
          await sleep(backoff);
          continue;
        }
        return unavailable(source, lastReason, lastDetail);
      }

      lastReason = "http_error";
      lastDetail = `HTTP ${res.status} ${truncate(await safeText(res), 200)}`;

      if (RETRYABLE.has(res.status) && attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return unavailable(source, lastReason, lastDetail);
    } catch (err) {
      const latency = Date.now() - started;
      st.failures++;
      st.lastLatencyMs = latency;
      st.lastError = errMessage(err);
      st.lastErrorAt = Date.now();

      const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      lastReason = isTimeout ? "timeout" : "network_error";
      lastDetail = errMessage(err);

      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return unavailable(source, lastReason, lastDetail);
    }
  }

  return unavailable(source, lastReason, lastDetail);
}

/** Raw bytes — used by the archive downloader for .zip payloads. */
export async function getBuffer(
  url: string,
  opts: FetchOptions,
): Promise<Availability<Uint8Array>> {
  const host = safeHost(url);
  const bucket = bucketFor(host);
  const st = statsFor(host);
  const maxRetries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const wait = bucket.waitFor(opts.weight ?? 1);
    if (wait > 0) await sleep(wait);
    bucket.take(opts.weight ?? 1);

    const started = Date.now();
    st.requests++;
    try {
      const res = await fetch(url, {
        headers: { "user-agent": opts.userAgent ?? "alslmany-crypto/1.0", ...opts.headers },
        signal: combineSignals(AbortSignal.timeout(timeoutMs), opts.signal),
      });
      st.lastLatencyMs = Date.now() - started;

      if (res.status === 404) {
        return unavailable(opts.source, "http_error", "404 — الملف غير موجود في الأرشيف");
      }
      if (!res.ok) {
        st.failures++;
        st.lastError = `HTTP ${res.status}`;
        st.lastErrorAt = Date.now();
        if (RETRYABLE.has(res.status) && attempt < maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        return unavailable(opts.source, "http_error", `HTTP ${res.status}`);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      return available(buf, opts.source, Date.now());
    } catch (err) {
      st.failures++;
      st.lastError = errMessage(err);
      st.lastErrorAt = Date.now();
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return unavailable(opts.source, isTimeout ? "timeout" : "network_error", errMessage(err));
    }
  }
  return unavailable(opts.source, "network_error", "استُنفدت المحاولات");
}

/** Exponential backoff with full jitter — avoids a thundering herd on recovery. */
function backoffMs(attempt: number, base = 500): number {
  const exp = Math.min(base * 2 ** attempt, 30_000);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

function combineSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  return AbortSignal.any([a, b]);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ? `${err.message} (${cause.code})` : err.message;
  }
  return String(err);
}

/** Build a query string, skipping undefined values. */
export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}
