import "server-only";

/**
 * Process-local TTL cache with stale-while-error semantics.
 *
 * Three jobs:
 *  1. keep us inside public exchange rate limits,
 *  2. collapse concurrent identical requests into one upstream call,
 *  3. keep serving the last good value when an upstream goes down, clearly
 *     marked as degraded rather than pretending it is fresh.
 */

type Entry<T> = { value: T; storedAt: number };

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

/** Hard ceiling so a long-lived server process cannot grow without bound. */
const MAX_ENTRIES = 600;

function remember<T>(key: string, value: T) {
  if (store.size >= MAX_ENTRIES) {
    // Evict the oldest quarter — cheap and good enough for this access pattern.
    const victims = [...store.entries()]
      .sort((a, b) => a[1].storedAt - b[1].storedAt)
      .slice(0, Math.floor(MAX_ENTRIES / 4));
    for (const [k] of victims) store.delete(k);
  }
  store.set(key, { value, storedAt: Date.now() });
}

export type CacheResult<T> = {
  value: T;
  fetchedAt: number;
  /** True when we are serving a stale value because the refresh failed. */
  degraded: boolean;
  note?: string;
};

export async function cached<T>(
  key: string,
  ttlMs: number,
  producer: () => Promise<T>,
): Promise<CacheResult<T>> {
  const hit = store.get(key) as Entry<T> | undefined;
  const now = Date.now();

  if (hit && now - hit.storedAt < ttlMs) {
    return { value: hit.value, fetchedAt: hit.storedAt, degraded: false };
  }

  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) {
    try {
      const value = await existing;
      return { value, fetchedAt: Date.now(), degraded: false };
    } catch {
      // Fall through to our own attempt / stale handling below.
    }
  }

  const task = producer();
  inflight.set(key, task);

  try {
    const value = await task;
    remember(key, value);
    return { value, fetchedAt: Date.now(), degraded: false };
  } catch (err) {
    if (hit) {
      return {
        value: hit.value,
        fetchedAt: hit.storedAt,
        degraded: true,
        note: err instanceof Error ? err.message : "refresh failed",
      };
    }
    throw err;
  } finally {
    inflight.delete(key);
  }
}

/** Read the last stored value regardless of age. */
export function peek<T>(key: string): CacheResult<T> | null {
  const hit = store.get(key) as Entry<T> | undefined;
  if (!hit) return null;
  return {
    value: hit.value,
    fetchedAt: hit.storedAt,
    degraded: Date.now() - hit.storedAt > 60_000,
  };
}

export function invalidate(prefix: string) {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}
