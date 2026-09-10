import "server-only";

/**
 * Outbound HTTP for upstream market data.
 *
 * Public exchange endpoints rate-limit and occasionally stall, so every call
 * gets a hard timeout and bounded retries. We never let an upstream hang take
 * a route handler down with it.
 */

const DEFAULT_TIMEOUT = 7000;
const UA = "AlslmanyCrypto/1.0 (+market-intelligence)";

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export async function fetchJson<T = unknown>(
  url: string,
  opts: { timeout?: number; retries?: number; revalidate?: number } = {},
): Promise<T> {
  const { timeout = DEFAULT_TIMEOUT, retries = 1, revalidate } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json", "user-agent": UA },
        ...(revalidate !== undefined
          ? { next: { revalidate } }
          : { cache: "no-store" as const }),
      });
      if (!res.ok) {
        throw new UpstreamError(`HTTP ${res.status}`, res.status, url);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      // Back off before the next attempt; the last failure falls straight through.
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new UpstreamError("Unknown upstream failure", undefined, url);
}

export async function fetchText(
  url: string,
  opts: { timeout?: number; revalidate?: number } = {},
): Promise<string> {
  const { timeout = DEFAULT_TIMEOUT, revalidate } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": UA },
      ...(revalidate !== undefined
        ? { next: { revalidate } }
        : { cache: "no-store" as const }),
    });
    if (!res.ok) throw new UpstreamError(`HTTP ${res.status}`, res.status, url);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try providers in order and return the first that succeeds.
 * Every failure is recorded so a route can report *why* it degraded rather
 * than silently serving worse data.
 */
export async function firstSuccess<T>(
  providers: { name: string; run: () => Promise<T> }[],
): Promise<{ value: T; name: string; failures: string[] }> {
  const failures: string[] = [];
  for (const p of providers) {
    try {
      const value = await p.run();
      return { value, name: p.name, failures };
    } catch (err) {
      failures.push(`${p.name}: ${err instanceof Error ? err.message : "failed"}`);
    }
  }
  throw new UpstreamError(`all providers failed — ${failures.join("; ")}`);
}
