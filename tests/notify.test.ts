/**
 * Notification policy tests.
 *
 * The rules that matter are the ones that decide NOT to send: a dedupe key
 * that swallows a second target, a quiet-hours window that hides a circuit
 * breaker, or a rate cap that silences the message saying the bot stopped.
 */
import { describe, expect, it } from "vitest";
import {
  afterSend, decide, emptyPolicyState, inQuietHours, parseQuietHours,
  type Notification, type PolicyConfig,
} from "@/notify/policy";
import { escapeMarkdown } from "@/notify/telegram";
import * as M from "@/notify/messages";
import type { CircuitBreaker, Position } from "@/core/execution/types";

const HOUR = 3_600_000;
const NOON = Date.UTC(2024, 5, 10, 12, 0, 0);

const cfg = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({
  quietHours: parseQuietHours("23:00-07:00"),
  maxPerHour: 6,
  dedupeWindowMs: 86_400_000,
  ...over,
});

const note = (over: Partial<Notification> = {}): Notification => ({
  kind: "new_recommendation", dedupeKey: "k1", text: "x", at: NOON, ...over,
});

describe("quiet hours parsing", () => {
  it("reads a wrapping window", () => {
    expect(parseQuietHours("23:00-07:00")).toEqual({ startMinute: 1_380, endMinute: 420 });
  });

  it("treats a MALFORMED value as no quiet hours, never as silence-everything", () => {
    // Getting this backwards means a typo in the env file silently disables
    // every alert, including the ones about a halted bot.
    for (const bad of ["", "23:00", "nonsense", "25:00-07:00", "23:70-07:00"]) {
      expect(parseQuietHours(bad)).toBeNull();
    }
  });

  it("treats an identical start and end as no window, not a full day", () => {
    expect(parseQuietHours("07:00-07:00")).toBeNull();
  });

  it("knows midnight is inside a wrapping window and noon is not", () => {
    const q = parseQuietHours("23:00-07:00")!;
    expect(inQuietHours(Date.UTC(2024, 5, 10, 0, 30), q)).toBe(true);
    expect(inQuietHours(Date.UTC(2024, 5, 10, 23, 30), q)).toBe(true);
    expect(inQuietHours(Date.UTC(2024, 5, 10, 12, 0), q)).toBe(false);
    // The end is exclusive: 07:00 sharp is already awake.
    expect(inQuietHours(Date.UTC(2024, 5, 10, 7, 0), q)).toBe(false);
  });

  it("handles a same-day window", () => {
    const q = parseQuietHours("01:00-05:00")!;
    expect(inQuietHours(Date.UTC(2024, 5, 10, 3, 0), q)).toBe(true);
    expect(inQuietHours(Date.UTC(2024, 5, 10, 6, 0), q)).toBe(false);
  });
});

describe("the policy", () => {
  it("sends a fresh notification", () => {
    expect(decide(note(), emptyPolicyState(), cfg()).send).toBe(true);
  });

  it("suppresses an exact repeat inside the window", () => {
    const state = afterSend(note(), emptyPolicyState());
    const again = decide(note({ at: NOON + HOUR }), state, cfg());
    expect(again.send).toBe(false);
    expect(again.send === false && again.reason).toBe("duplicate");
  });

  it("allows the same key again once the dedupe window has passed", () => {
    const state = afterSend(note(), emptyPolicyState());
    expect(decide(note({ at: NOON + 2 * 86_400_000 }), state, cfg()).send).toBe(true);
  });

  it("DROPS a non-critical message during quiet hours", () => {
    const d = decide(note({ at: Date.UTC(2024, 5, 10, 2, 0) }), emptyPolicyState(), cfg());
    expect(d.send).toBe(false);
    expect(d.send === false && d.reason).toBe("quiet_hours");
  });

  it("lets a CIRCUIT BREAKER through at 3am", () => {
    // The one message that must never be silenced is the one saying the bot
    // has stopped trading.
    const d = decide(
      note({ kind: "circuit_breaker", at: Date.UTC(2024, 5, 10, 3, 0) }),
      emptyPolicyState(), cfg(),
    );
    expect(d.send).toBe(true);
  });

  it("lets a STOP HIT through at 3am", () => {
    const d = decide(
      note({ kind: "stop_hit", at: Date.UTC(2024, 5, 10, 3, 0) }),
      emptyPolicyState(), cfg(),
    );
    expect(d.send).toBe(true);
  });

  it("caps non-critical messages at six an hour", () => {
    let state = emptyPolicyState();
    for (let i = 0; i < 6; i++) {
      state = afterSend(note({ dedupeKey: `k${i}`, at: NOON + i * 60_000 }), state);
    }
    const seventh = decide(note({ dedupeKey: "k9", at: NOON + 7 * 60_000 }), state, cfg());
    expect(seventh.send).toBe(false);
    expect(seventh.send === false && seventh.reason).toBe("rate_capped");
  });

  it("does not let a full cap silence a circuit breaker", () => {
    let state = emptyPolicyState();
    for (let i = 0; i < 6; i++) {
      state = afterSend(note({ dedupeKey: `k${i}`, at: NOON + i * 60_000 }), state);
    }
    expect(decide(note({ kind: "circuit_breaker", dedupeKey: "b", at: NOON }), state, cfg()).send).toBe(true);
  });

  it("does not count critical sends against the cap", () => {
    let state = emptyPolicyState();
    for (let i = 0; i < 6; i++) {
      state = afterSend(note({ kind: "stop_hit", dedupeKey: `s${i}`, at: NOON + i * 60_000 }), state);
    }
    expect(decide(note({ dedupeKey: "new", at: NOON + 7 * 60_000 }), state, cfg()).send).toBe(true);
  });

  it("forgets rate-cap entries older than an hour", () => {
    let state = emptyPolicyState();
    for (let i = 0; i < 6; i++) {
      state = afterSend(note({ dedupeKey: `k${i}`, at: NOON + i * 60_000 }), state);
    }
    expect(decide(note({ dedupeKey: "later", at: NOON + 2 * HOUR }), state, cfg()).send).toBe(true);
  });
});

describe("markdown escaping", () => {
  it("escapes every character that would make Telegram reject the message", () => {
    // An unescaped dot in a price used to kill the whole alert.
    expect(escapeMarkdown("BTCUSDT 65,432.10 (-1.2%)")).toBe("BTCUSDT 65,432\\.10 \\(\\-1\\.2%\\)");
  });

  it("escapes a backslash so it cannot escape the next character itself", () => {
    expect(escapeMarkdown("a\\b")).toBe("a\\\\b");
  });
});

// ── keys ─────────────────────────────────────────────────────────────────────

const rec = {
  id: "REC1", symbol: "BTCUSDT", direction: "long" as const, setup: "trend_continuation" as const,
  regime: "trending_up" as const, timeframe: "1h" as const, generatedAt: NOON, asOfCandle: NOON,
  exchange: "binance", entry: { low: 100, high: 102, mid: 101 }, stop: 98, stopBasis: "خلف القاع",
  targets: [
    { index: 1 as const, price: 105, closeFraction: 0.5, basis: "مقاومة", rewardR: 2 },
    { index: 2 as const, price: 110, closeFraction: 0.3, basis: "مقاومة", rewardR: 3 },
    { index: 3 as const, price: 115, closeFraction: 0.2, basis: "مقاومة", rewardR: 4 },
  ] as never,
  riskReward: 2.4, positionSize: 3, positionNotional: 303, riskAmount: 100, riskPercent: 1,
  confidence: 72, confidenceComponents: [], finalScore: 68, invalidation: [], expiresAt: NOON + HOUR,
  report: "", integrityHash: "h",
};

const position = {
  averageEntry: 101, openQuantity: 1.5, currentStop: 101, realizedPnl: 50, realizedR: 0.5,
  stopMovedToBreakeven: true, trailingActive: false, openedAt: NOON,
} as Position;

describe("message keys", () => {
  it("keys each target separately, so target 2 is not eaten as a repeat of target 1", () => {
    const one = M.targetHit(rec as never, 1, 105, position, NOON);
    const two = M.targetHit(rec as never, 2, 110, position, NOON + HOUR);
    expect(one.dedupeKey).not.toBe(two.dedupeKey);

    const state = afterSend(one, emptyPolicyState());
    expect(decide(two, state, cfg()).send).toBe(true);
  });

  it("keys a breaker by its trip time, so next week's trip is a new event", () => {
    const b = (at: number): CircuitBreaker => ({
      kind: "daily_loss", trippedAt: at, resumesAt: at + 24 * HOUR,
      requiresManualReset: false, reason: "r", arabic: "خسارة اليوم",
    });
    expect(M.circuitBreaker(b(NOON)).dedupeKey).not.toBe(M.circuitBreaker(b(NOON + 7 * 86_400_000)).dedupeKey);
  });

  it("keys a source failure by the hour, so an outage is not its own outage", () => {
    expect(M.sourceFailure("binance", "d", NOON).dedupeKey)
      .toBe(M.sourceFailure("binance", "d", NOON + 59 * 60_000).dedupeKey);
    expect(M.sourceFailure("binance", "d", NOON).dedupeKey)
      .not.toBe(M.sourceFailure("binance", "d", NOON + 2 * HOUR).dedupeKey);
  });

  it("says plainly when a recommendation expired without ever filling", () => {
    const unfilled = { ...position, openedAt: null } as Position;
    const msg = M.closed(rec as never, unfilled, "expired", "لم يصل السعر", NOON);
    expect(msg.text).toContain("لم تُنفَّذ أصلاً");
  });

  it("puts the entry zone, stop and all three targets in the new-recommendation alert", () => {
    const msg = M.newRecommendation(rec as never);
    for (const fragment of ["100", "102", "98", "105", "110", "115"]) {
      expect(msg.text).toContain(fragment);
    }
  });
});
