/**
 * The closed/forming candle boundary is rule #1 of the whole system, so it is
 * tested against hand-computed UTC instants rather than against itself.
 */
import { describe, expect, it } from "vitest";
import {
  candleCloseTime,
  candleOpenTime,
  candleGap,
  dayKeysBetween,
  dropUnclosed,
  isCandleClosed,
  lastClosedOpenTime,
  monthKeysBetween,
  stalenessInBars,
  tfDistance,
  tfMillis,
} from "@/shared/time";

const ts = (iso: string) => Date.parse(iso);

describe("candleOpenTime", () => {
  it("floors intraday bars onto the UTC grid", () => {
    expect(candleOpenTime(ts("2024-03-14T13:47:23.500Z"), "5m")).toBe(ts("2024-03-14T13:45:00Z"));
    expect(candleOpenTime(ts("2024-03-14T13:47:23.500Z"), "15m")).toBe(ts("2024-03-14T13:45:00Z"));
    expect(candleOpenTime(ts("2024-03-14T13:47:23.500Z"), "1h")).toBe(ts("2024-03-14T13:00:00Z"));
    expect(candleOpenTime(ts("2024-03-14T13:47:23.500Z"), "4h")).toBe(ts("2024-03-14T12:00:00Z"));
    expect(candleOpenTime(ts("2024-03-14T13:47:23.500Z"), "1d")).toBe(ts("2024-03-14T00:00:00Z"));
  });

  it("is idempotent on an exact boundary", () => {
    const open = ts("2024-03-14T12:00:00Z");
    expect(candleOpenTime(open, "4h")).toBe(open);
  });

  it("anchors weekly bars to MONDAY, not to the Thursday epoch", () => {
    // 2024-03-14 is a Thursday; its week opened Monday 2024-03-11.
    expect(candleOpenTime(ts("2024-03-14T13:47:00Z"), "1w")).toBe(ts("2024-03-11T00:00:00Z"));
    // Sunday belongs to the week that began the previous Monday.
    expect(candleOpenTime(ts("2024-03-17T23:59:59Z"), "1w")).toBe(ts("2024-03-11T00:00:00Z"));
    // One second later is a new week.
    expect(candleOpenTime(ts("2024-03-18T00:00:00Z"), "1w")).toBe(ts("2024-03-18T00:00:00Z"));
  });

  it("handles pre-epoch weeks without drifting off Monday", () => {
    // Guards the negative-division branch of the Monday offset.
    const open = candleOpenTime(ts("1970-01-01T00:00:00Z"), "1w");
    expect(new Date(open).getUTCDay()).toBe(1); // Monday
    expect(open).toBe(ts("1969-12-29T00:00:00Z"));
  });

  it("keeps every weekly open on a Monday across a long span", () => {
    for (let i = 0; i < 500; i++) {
      const probe = ts("2020-01-01T00:00:00Z") + i * 86_400_000 * 3.7;
      expect(new Date(candleOpenTime(probe, "1w")).getUTCDay()).toBe(1);
    }
  });
});

describe("closed vs forming", () => {
  it("treats a bar as closed exactly at its close instant", () => {
    const open = ts("2024-03-14T13:00:00Z");
    const close = open + tfMillis("1h");
    expect(isCandleClosed(open, "1h", close - 1)).toBe(false);
    expect(isCandleClosed(open, "1h", close)).toBe(true);
  });

  it("lastClosedOpenTime steps back exactly one bar from the forming one", () => {
    const now = ts("2024-03-14T13:47:00Z");
    expect(lastClosedOpenTime(now, "1h")).toBe(ts("2024-03-14T12:00:00Z"));
    expect(lastClosedOpenTime(now, "4h")).toBe(ts("2024-03-14T08:00:00Z"));
    expect(lastClosedOpenTime(now, "1d")).toBe(ts("2024-03-13T00:00:00Z"));
  });

  it("lastClosedOpenTime on an exact boundary returns the bar that just closed", () => {
    const now = ts("2024-03-14T13:00:00.000Z");
    // 12:00 has closed; 13:00 has only just opened.
    expect(lastClosedOpenTime(now, "1h")).toBe(ts("2024-03-14T12:00:00Z"));
  });

  it("dropUnclosed removes the forming bar and nothing else", () => {
    const base = ts("2024-03-14T10:00:00Z");
    const series = [0, 1, 2, 3].map((i) => ({ openTime: base + i * tfMillis("1h") }));
    const now = ts("2024-03-14T13:30:00Z"); // the 13:00 bar is still forming
    const out = dropUnclosed(series, "1h", now);
    expect(out).toHaveLength(3);
    expect(out[out.length - 1].openTime).toBe(ts("2024-03-14T12:00:00Z"));
  });

  it("dropUnclosed returns the same array when nothing is forming", () => {
    const base = ts("2024-03-14T10:00:00Z");
    const series = [0, 1].map((i) => ({ openTime: base + i * tfMillis("1h") }));
    const out = dropUnclosed(series, "1h", ts("2024-03-14T15:00:00Z"));
    expect(out).toBe(series); // identity: no needless copy
  });

  it("dropUnclosed can empty a series that is entirely in the future", () => {
    const series = [{ openTime: ts("2030-01-01T00:00:00Z") }];
    expect(dropUnclosed(series, "1h", ts("2024-01-01T00:00:00Z"))).toHaveLength(0);
  });
});

describe("gaps and staleness", () => {
  it("reports zero for contiguous bars and the exact count for a hole", () => {
    const a = ts("2024-03-14T10:00:00Z");
    expect(candleGap(a, a + tfMillis("1h"), "1h")).toBe(0);
    expect(candleGap(a, a + 4 * tfMillis("1h"), "1h")).toBe(3);
  });

  it("measures staleness in whole bars behind the last closed one", () => {
    const now = ts("2024-03-14T13:30:00Z"); // last closed 1h bar opened 12:00
    expect(stalenessInBars(ts("2024-03-14T12:00:00Z"), "1h", now)).toBe(0);
    expect(stalenessInBars(ts("2024-03-14T09:00:00Z"), "1h", now)).toBe(3);
  });
});

describe("timeframe ladder", () => {
  it("measures distance for the two-step conflict rule", () => {
    expect(tfDistance("15m", "4h")).toBe(2);
    expect(tfDistance("1h", "1h")).toBe(0);
    expect(tfDistance("5m", "1w")).toBe(5);
  });
});

describe("archive period keys", () => {
  it("enumerates inclusive month keys across a year boundary", () => {
    const keys = monthKeysBetween(ts("2023-11-15T00:00:00Z"), ts("2024-02-03T00:00:00Z"));
    expect(keys).toEqual(["2023-11", "2023-12", "2024-01", "2024-02"]);
  });

  it("enumerates inclusive day keys", () => {
    const keys = dayKeysBetween(ts("2024-02-27T13:00:00Z"), ts("2024-03-01T05:00:00Z"));
    expect(keys).toEqual(["2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01"]);
  });
});
