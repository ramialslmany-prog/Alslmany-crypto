/**
 * Stage 6 tests.
 *
 * The rules worth pinning here are all about honesty, not arithmetic. This
 * stage runs on a source that answers a NARROWER question than the spec asks,
 * and every test below exists to stop it from quietly answering the wider one.
 */
import { describe, expect, it } from "vitest";
import { runOnchain, type OnchainInput } from "@/core/pipeline/stage6-onchain";
import { available, unavailable } from "@/shared/availability";
import type { ProtocolTvl } from "@/core/types";

const NOW = Date.UTC(2024, 5, 10, 12, 0, 0);

const protocol = (over: Partial<ProtocolTvl> = {}): ProtocolTvl => ({
  name: "Test Protocol", symbol: "TEST", tvl: 500_000_000,
  change1d: 0.5, change7d: 8, revenue24h: null, ...over,
});

const input = (over: Partial<OnchainInput> = {}): OnchainInput => ({
  symbol: "TESTUSDT",
  ticker: "TEST",
  protocol: available(protocol(), "defillama", NOW),
  totalTvl: available(100_000_000_000, "defillama", NOW),
  totalTvl7dAgo: 95_000_000_000,
  direction: "long",
  now: NOW,
  ...over,
});

describe("what the stage refuses to claim", () => {
  it("calls Bitcoin's protocol TVL NOT APPLICABLE, not missing", () => {
    // The difference matters: a missing value is a gap to be penalised, and
    // "Bitcoin has no protocol" is a category error that deserves no penalty
    // at all. Scoring it as a gap would punish BTC on every single run.
    const r = runOnchain(input({ ticker: "BTC", symbol: "BTCUSDT" }));
    const f = r.factors.find((x) => x.id === "protocol_tvl");
    expect(f?.display).toBe("لا ينطبق");
    expect(f?.contribution).toBe(0);
    expect(r.status).toBe("pass"); // the sector reading still carries it
  });

  it("says plainly that this is NOT exchange netflows", () => {
    expect(runOnchain(input()).arabic).toContain("ليست تدفّقات المنصّات");
  });

  it("reports unavailable rather than scoring zero when nothing is readable", () => {
    const r = runOnchain(input({
      ticker: "BTC",
      protocol: unavailable("defillama", "no_data" as never, "none"),
      totalTvl: unavailable("defillama", "network_error", "down"),
      totalTvl7dAgo: null,
    }));
    expect(r.status).toBe("unavailable");
    expect(r.confidencePenalty).toBeCloseTo(0.15, 9);
  });

  it("does NOT invent a sector trend from a single reading", () => {
    // One TVL number is a level, not a trend. Treating "no prior reading" as
    // "no change" would score every fresh install as a flat sector.
    const r = runOnchain(input({ totalTvl7dAgo: null, ticker: "BTC" }));
    expect(r.status).toBe("unavailable");
    expect(r.warnings.join(" ")).toContain("قراءة سابقة");
  });

  it("marks the sector reading as identical for every symbol", () => {
    const f = runOnchain(input()).factors.find((x) => x.id === "sector_tvl");
    expect(f?.note).toContain("لا تستطيع التمييز بين عملة وأخرى");
  });
});

describe("what the stage does say", () => {
  it("scores rising locked capital positively and falling negatively", () => {
    const rising = runOnchain(input({
      protocol: available(protocol({ change7d: 20 }), "defillama", NOW),
    }));
    const falling = runOnchain(input({
      protocol: available(protocol({ change7d: -20 }), "defillama", NOW),
    }));
    expect(rising.score).toBeGreaterThan(0);
    expect(falling.score).toBeLessThan(0);
    expect(rising.score).toBeGreaterThan(falling.score);
  });

  it("keeps the score inside 0..±100 on an extreme move", () => {
    const r = runOnchain(input({
      protocol: available(protocol({ change7d: 500 }), "defillama", NOW),
      totalTvl7dAgo: 10_000_000_000,
    }));
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(-100);
  });

  it("treats revenue as a quality signal that never turns the score negative", () => {
    const withRevenue = runOnchain(input({
      protocol: available(protocol({ change7d: 0, revenue24h: 200_000 }), "defillama", NOW),
    }));
    const without = runOnchain(input({
      protocol: available(protocol({ change7d: 0, revenue24h: null }), "defillama", NOW),
    }));
    expect(withRevenue.score).toBeGreaterThanOrEqual(without.score);
  });

  it("renormalizes, so one missing sub-reading does not drag the score to zero", () => {
    // Protocol TVL strongly positive, sector unavailable: the score should
    // stay strongly positive rather than being halved by the absence.
    const r = runOnchain(input({
      protocol: available(protocol({ change7d: 20 }), "defillama", NOW),
      totalTvl: unavailable("defillama", "network_error", "down"),
      totalTvl7dAgo: null,
    }));
    expect(r.score).toBeGreaterThan(80);
  });
});
