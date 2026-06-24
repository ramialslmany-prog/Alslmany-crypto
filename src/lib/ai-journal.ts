"use client";

/**
 * AI trader journal — the self-improvement loop.
 *
 * The AI issues picks → they're recorded here → outcomes are evaluated against
 * live prices (TP/stop/expiry) → the AI reviews its own closed trades and
 * writes lessons → lessons are injected into the next picks' prompt, and a
 * mechanical adaptive confidence bar tightens after poor results. Persisted in
 * localStorage; same store pattern as tracker.ts.
 */
import { useSyncExternalStore } from "react";
import type { Recommendation } from "@/lib/signal-engine";

export interface JTrade {
  id: string;
  symbol: string;
  entry: number;
  stop: number; // live stop — raised to breakeven (after TP1) then to TP1 (after TP2)
  targets: number[];
  confidence: number;
  issuedAt: number;
  status: "open" | "tp1" | "tp2" | "tp3" | "breakeven" | "stopped" | "expired";
  hit?: number; // highest target reached while still open (0–3) — staged take-profit
  closedAt?: number;
  exitPrice?: number;
  retPct?: number;
  warned?: boolean; // a one-time "approaching stop" risk alert was sent
}

/** A position that just reached a new target but stays open (staged TP). */
export interface AdvanceEvent {
  trade: JTrade;
  level: number; // the target number just reached (1 or 2)
  gainPct: number; // unrealized gain at that target
}

const KEY = "quantum.aitrader.v1";
const LESSONS_KEY = "quantum.aitrader.lessons";
const EMPTY: JTrade[] = [];
const EXPIRE_MS = 7 * 24 * 3600 * 1000; // day-style spot picks time out after 7 days

let state: JTrade[] = load();
const listeners = new Set<() => void>();

function load(): JTrade[] {
  if (typeof window === "undefined") return EMPTY;
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]") as JTrade[];
  } catch {
    return [];
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* quota */
  }
  listeners.forEach((l) => l());
}

/** Record new AI picks (LONG only — spot). Skips symbols already open. */
export function issueTrades(recs: Recommendation[]): number {
  const now = Date.now();
  const added: JTrade[] = [];
  for (const r of recs) {
    if (r.signal !== "LONG") continue;
    if (state.some((t) => t.symbol === r.symbol && t.status === "open")) continue;
    added.push({
      id: `${r.symbol}|${now}`,
      symbol: r.symbol,
      entry: r.entry,
      stop: r.stop,
      targets: r.targets,
      confidence: r.confidence,
      issuedAt: now,
      status: "open",
    });
  }
  if (added.length) {
    state = [...added, ...state].slice(0, 100);
    persist();
  }
  return added.length;
}

/**
 * Evaluate open picks against live prices with STAGED take-profit (like a pro
 * signal channel): TP1 reached → stop moves to breakeven; TP2 reached → stop
 * trails up to TP1 (profit locked); TP3 → full exit. Stop/expiry close too.
 * Returns the NEW events of this pass so callers can notify (Telegram):
 *  `closed`   = positions that just closed (tp3 / trailed / breakeven / stop / expiry)
 *  `advanced` = positions that just reached a target but stay open (1 or 2)
 *  `warned`   = positions that just crossed 70% toward the stop (one-time)
 */
export function evaluateOpen(priceOf: (s: string) => number): {
  closed: JTrade[];
  advanced: AdvanceEvent[];
  warned: JTrade[];
} {
  const closedNow: JTrade[] = [];
  const advancedNow: AdvanceEvent[] = [];
  const warnedNow: JTrade[] = [];
  let changed = false;
  const now = Date.now();
  state = state.map((t) => {
    if (t.status !== "open") return t;
    const p = priceOf(t.symbol);
    if (!p) return t;
    const hit = t.hit ?? 0;
    const close = (status: JTrade["status"], exit: number): JTrade => {
      changed = true;
      const u = { ...t, status, closedAt: now, exitPrice: exit, retPct: ((exit - t.entry) / t.entry) * 100 };
      closedNow.push(u);
      return u;
    };
    // Full exit at the final target.
    if (p >= t.targets[2]) return close("tp3", t.targets[2]);
    // Stop / trailed-stop / breakeven exit (t.stop has been raised as targets hit).
    if (p <= t.stop) {
      const status: JTrade["status"] = hit >= 2 ? "tp1" : hit >= 1 ? "breakeven" : "stopped";
      return close(status, t.stop);
    }
    // Stage up: TP2 reached → trail stop to TP1 (lock first-target profit).
    if (p >= t.targets[1] && hit < 2) {
      changed = true;
      const u: JTrade = { ...t, hit: 2, stop: t.targets[0] };
      advancedNow.push({ trade: u, level: 2, gainPct: ((t.targets[1] - t.entry) / t.entry) * 100 });
      return u;
    }
    // Stage up: TP1 reached → move stop to breakeven (trade is now risk-free).
    if (p >= t.targets[0] && hit < 1) {
      changed = true;
      const u: JTrade = { ...t, hit: 1, stop: t.entry };
      advancedNow.push({ trade: u, level: 1, gainPct: ((t.targets[0] - t.entry) / t.entry) * 100 });
      return u;
    }
    if (now - t.issuedAt > EXPIRE_MS) return close("expired", p);
    // Early risk alert: price covered ≥70% of the distance to the stop (pre-TP1 only).
    if (!t.warned && hit < 1) {
      const dist = t.entry - t.stop;
      if (dist > 0 && t.entry - p >= dist * 0.7) {
        changed = true;
        const u = { ...t, warned: true };
        warnedNow.push(u);
        return u;
      }
    }
    return t;
  });
  if (changed) persist();
  return { closed: closedNow, advanced: advancedNow, warned: warnedNow };
}

export function clearJournal() {
  state = [];
  persist();
}

/** Current journal snapshot (for non-React callers like the watcher). */
export function getJournal(): JTrade[] {
  return state;
}

export function journalStats(list: JTrade[]) {
  const closed = list.filter((t) => t.status !== "open");
  // Breakevens (~0%) count as neither a win nor a loss → honest win rate.
  const wins = closed.filter((t) => (t.retPct ?? 0) > 0.05);
  const losses = closed.filter((t) => (t.retPct ?? 0) < -0.05);
  const decided = wins.length + losses.length;
  const total = closed.reduce((a, t) => a + (t.retPct ?? 0), 0);
  const gw = wins.reduce((a, t) => a + (t.retPct ?? 0), 0);
  const gl = Math.abs(losses.reduce((a, t) => a + (t.retPct ?? 0), 0));
  return {
    open: list.length - closed.length,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: decided ? (wins.length / decided) * 100 : 0,
    totalPct: total,
    avgPct: closed.length ? total / closed.length : 0,
    profitFactor: gl > 0 ? Math.min(gw / gl, 99) : gw > 0 ? 99 : 0,
  };
}

/** Lessons the AI wrote about itself — injected into the next picks' prompt. */
export function getLessons(): string {
  try {
    return localStorage.getItem(LESSONS_KEY) || "";
  } catch {
    return "";
  }
}
export function setLessons(s: string) {
  try {
    localStorage.setItem(LESSONS_KEY, s.slice(0, 1200));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

/** Latest AI reasoning, persisted so the autonomous loop's output shows on the page. */
const COMMENT_KEY = "quantum.aitrader.comment";
const REVIEW_KEY = "quantum.aitrader.review";
export function getLastComment(): string {
  try { return localStorage.getItem(COMMENT_KEY) || ""; } catch { return ""; }
}
export function setLastComment(s: string) {
  try { localStorage.setItem(COMMENT_KEY, s.slice(0, 1500)); } catch { /* ignore */ }
}
export function getLastReview(): string {
  try { return localStorage.getItem(REVIEW_KEY) || ""; } catch { return ""; }
}
export function setLastReview(s: string) {
  try { localStorage.setItem(REVIEW_KEY, s.slice(0, 2000)); } catch { /* ignore */ }
}

/**
 * Mechanical self-improvement: the minimum confidence the AI accepts for new
 * picks tightens after poor results and relaxes after strong ones.
 */
export function adaptiveMinConf(stats: { closed: number; winRate: number }): number {
  if (stats.closed >= 5 && stats.winRate < 50) return 75;
  if (stats.closed >= 5 && stats.winRate > 65) return 55;
  return 65;
}

export function useJournal(): JTrade[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => EMPTY
  );
}
