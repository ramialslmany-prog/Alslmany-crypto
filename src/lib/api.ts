import { NextResponse } from "next/server";

/**
 * One response envelope for every route handler.
 *
 * Clients always receive `{ ok, data, meta }` or `{ ok:false, error }`, and
 * `meta` carries provenance — which venue answered, when, and whether we are
 * serving a stale copy. Showing that honestly is part of the product.
 */

export type Meta = {
  source?: string;
  fetchedAt: number;
  degraded: boolean;
  note?: string;
};

export type ApiOk<T> = { ok: true; data: T; meta: Meta };
export type ApiErr = { ok: false; error: string; meta: Meta };
export type ApiResponse<T> = ApiOk<T> | ApiErr;

export function ok<T>(
  data: T,
  meta: Partial<Meta> = {},
  cacheSeconds = 0,
): NextResponse<ApiOk<T>> {
  const res = NextResponse.json<ApiOk<T>>({
    ok: true,
    data,
    meta: { fetchedAt: Date.now(), degraded: false, ...meta },
  });
  res.headers.set(
    "cache-control",
    cacheSeconds > 0
      ? `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 4}`
      : "no-store",
  );
  return res;
}

export function fail(error: unknown, status = 502): NextResponse<ApiErr> {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
  const res = NextResponse.json<ApiErr>(
    { ok: false, error: message, meta: { fetchedAt: Date.now(), degraded: true } },
    { status },
  );
  res.headers.set("cache-control", "no-store");
  return res;
}

export function badRequest(message: string) {
  return fail(message, 400);
}

/**
 * Refuse an over-quota caller.
 *
 * Carries the standard headers so a well-behaved client can back off on its
 * own rather than retrying into the wall.
 */
export function tooManyRequests(result: {
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}): NextResponse<ApiErr> {
  const res = NextResponse.json<ApiErr>(
    {
      ok: false,
      error: `rate limit exceeded — retry in ${result.retryAfterSeconds}s`,
      meta: { fetchedAt: Date.now(), degraded: true },
    },
    { status: 429 },
  );
  res.headers.set("retry-after", String(result.retryAfterSeconds));
  res.headers.set("x-ratelimit-limit", String(result.limit));
  res.headers.set("x-ratelimit-remaining", "0");
  res.headers.set("x-ratelimit-reset", String(Math.floor(result.resetAt / 1000)));
  res.headers.set("cache-control", "no-store");
  return res;
}

/** Read and validate a query parameter against an allow-list. */
export function enumParam<T extends string>(
  url: URL,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = url.searchParams.get(key);
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

export function intParam(url: URL, key: string, fallback: number, min: number, max: number) {
  const raw = Number(url.searchParams.get(key));
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

/** Symbols come from user input — keep them to a safe alphabet. */
export function symbolParam(url: URL, key = "symbol", fallback = "BTC"): string {
  const raw = (url.searchParams.get(key) ?? fallback).toUpperCase();
  return /^[A-Z0-9]{2,12}$/.test(raw) ? raw : fallback;
}
