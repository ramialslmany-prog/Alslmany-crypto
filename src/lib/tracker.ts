"use client";

/**
 * Auto-tracking store for fired recommendations.
 *
 * Records every actionable setup with the moment it started, persists to
 * localStorage, and evaluates live status (active / target hit / stopped) +
 * P&L against the current price. Dependency-free: a module-level store wired
 * to React via useSyncExternalStore.
 */
import { useSyncExternalStore } from "react";
import type { Recommendation } from "@/lib/signal-engine";

export interface TrackedSignal {
  id: string; // symbol|style|market|direction — stable so the same setup isn't double-added
  symbol: string;
  style: string;
  market: "spot" | "futures";
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  targets: number[];
  confidence: number;
  startedAt: number;
  amount?: number; // capital committed once the user "enters" the trade
  openedAt?: number; // when the user entered
  peak?: number; // best favorable price seen since the position opened
}

export type TrackStatus = "active" | "tp1" | "tp2" | "tp3" | "stopped";
/** Whether the position is still worth holding. */
export type Health = "hold" | "watch" | "takeProfit" | "exit";

const KEY = "quantum.tracked.v1";
const EMPTY: TrackedSignal[] = [];

let state: TrackedSignal[] = load();
const listeners = new Set<() => void>();

function load(): TrackedSignal[] {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as TrackedSignal[]) : [];
  } catch {
    return [];
  }
}

function persist() {
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* ignore quota */
    }
  }
  listeners.forEach((l) => l());
}

/** Stable id for a recommendation (so the same setup isn't double-tracked). */
export function trackId(rec: { symbol: string; style: string; market: string; signal: string }) {
  return `${rec.symbol}|${rec.style}|${rec.market}|${rec.signal}`;
}

export function trackSignal(rec: Recommendation) {
  if (rec.signal !== "LONG" && rec.signal !== "SHORT") return;
  const id = trackId(rec);
  if (state.some((s) => s.id === id)) return; // already tracking this exact setup
  const entry: TrackedSignal = {
    id,
    symbol: rec.symbol,
    style: rec.style,
    market: rec.market,
    direction: rec.signal,
    entry: rec.entry,
    stop: rec.stop,
    targets: rec.targets,
    confidence: rec.confidence,
    startedAt: Date.now(),
  };
  state = [entry, ...state].slice(0, 40);
  persist();
}

export function untrack(id: string) {
  state = state.filter((s) => s.id !== id);
  persist();
}

/** Enter (or update) a position with a capital amount; pass undefined to close. */
export function setPositionAmount(id: string, amount: number | undefined) {
  state = state.map((s) =>
    s.id === id ? { ...s, amount: amount && amount > 0 ? amount : undefined, openedAt: amount && amount > 0 ? (s.openedAt ?? Date.now()) : undefined } : s
  );
  persist();
}

export function clearTracked() {
  state = [];
  persist();
}

/** Live status + P&L of a tracked signal against the current price. */
export function evaluate(t: TrackedSignal, price: number): { status: TrackStatus; pnlPct: number } {
  const long = t.direction === "LONG";
  const pnlPct = ((price - t.entry) / t.entry) * 100 * (long ? 1 : -1);
  let status: TrackStatus = "active";
  if (long) {
    if (price <= t.stop) status = "stopped";
    else if (price >= t.targets[2]) status = "tp3";
    else if (price >= t.targets[1]) status = "tp2";
    else if (price >= t.targets[0]) status = "tp1";
  } else {
    if (price >= t.stop) status = "stopped";
    else if (price <= t.targets[2]) status = "tp3";
    else if (price <= t.targets[1]) status = "tp2";
    else if (price <= t.targets[0]) status = "tp1";
  }
  return { status, pnlPct };
}

/**
 * Is the trade still worth holding? Price-action based (no extra fetch):
 * stopped → exit, target hit → take profit, moving >60% toward stop → exit,
 * in profit → hold, otherwise → watch.
 */
export function assessHealth(t: TrackedSignal, price: number): Health {
  const { status, pnlPct } = evaluate(t, price);
  if (status === "stopped") return "exit";
  if (status === "tp1" || status === "tp2" || status === "tp3") return "takeProfit";
  const long = t.direction === "LONG";
  const stopDist = Math.abs(t.entry - t.stop) || t.entry * 0.01;
  const adverse = long ? t.entry - price : price - t.entry; // >0 = drifting toward stop
  if (adverse > 0 && adverse >= stopDist * 0.6) return "exit";
  if (pnlPct > 0) return "hold";
  return "watch";
}

/** P&L in dollars for an entered position. */
export function pnlUsd(t: TrackedSignal, price: number): number {
  if (!t.amount) return 0;
  const { pnlPct } = evaluate(t, price);
  return t.amount * (pnlPct / 100);
}

/** Coins held = capital / entry price. */
export function units(t: TrackedSignal): number {
  return t.amount && t.entry > 0 ? t.amount / t.entry : 0;
}

/** Best favorable % since the position opened (uses tracked peak). */
export function peakPnlPct(t: TrackedSignal): number {
  if (!t.peak) return 0;
  const long = t.direction === "LONG";
  return ((long ? t.peak - t.entry : t.entry - t.peak) / t.entry) * 100;
}

/** Update peak prices for open positions; only persists when something improved. */
export function updatePeaks(priceBySymbol: Record<string, number>) {
  let changed = false;
  state = state.map((s) => {
    if (!s.amount) return s;
    const price = priceBySymbol[s.symbol];
    if (!price) return s;
    const cur = s.peak ?? s.entry;
    const better = s.direction === "LONG" ? price > cur : price < cur;
    if (better) {
      changed = true;
      return { ...s, peak: price };
    }
    return s;
  });
  if (changed) persist();
}

export function useTracker(): TrackedSignal[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => EMPTY
  );
}
