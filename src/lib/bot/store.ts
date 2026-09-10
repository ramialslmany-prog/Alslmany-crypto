import "server-only";
import { emptyState, type BotState } from "./types";

/**
 * Bot state persistence.
 *
 * Serverless instances are ephemeral, so an in-memory ledger would reset
 * whenever the platform recycled a container — and a track record that resets
 * is not a track record. When an Upstash Redis REST endpoint is configured the
 * state is durable; without one we fall back to process memory and say so
 * plainly, so nobody mistakes a fresh instance for a fresh strategy.
 */

const KEY = "alslmany:bot:state:v1";

let memory: BotState = emptyState();

function credentials(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

export function isDurable(): boolean {
  return credentials() !== null;
}

export async function loadState(): Promise<BotState> {
  const creds = credentials();
  if (!creds) return memory;

  try {
    const res = await fetch(`${creds.url}/get/${encodeURIComponent(KEY)}`, {
      headers: { authorization: `Bearer ${creds.token}` },
      cache: "no-store",
    });
    if (!res.ok) return memory;
    const body = (await res.json()) as { result?: string | null };
    if (!body.result) return memory;
    const parsed = JSON.parse(body.result) as BotState;
    // Trust but verify: a malformed blob must not take the bot down.
    if (!Array.isArray(parsed.positions) || !Array.isArray(parsed.closed)) return memory;
    return parsed;
  } catch {
    return memory;
  }
}

export async function saveState(state: BotState): Promise<boolean> {
  memory = state;
  const creds = credentials();
  if (!creds) return false;

  try {
    const res = await fetch(`${creds.url}/set/${encodeURIComponent(KEY)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${creds.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(state),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function resetState(): Promise<void> {
  memory = emptyState();
  await saveState(memory);
}
