/**
 * Rule #3 of the spec — never invent a value for a missing source — is a type
 * and a set of behaviours, not a convention. Both are pinned here.
 */
import { describe, expect, it } from "vitest";
import {
  available,
  describeUnavailable,
  isAvailable,
  mapAvailability,
  requireFresh,
  unavailable,
  valueOrUndefined,
} from "@/shared/availability";
import { getConfig } from "@/shared/config";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("Availability", () => {
  it("narrows to the value only on the available branch", () => {
    const a = available(42, "test", 1000);
    expect(isAvailable(a)).toBe(true);
    if (isAvailable(a)) expect(a.value).toBe(42);
  });

  it("carries a machine reason AND Arabic copy for the site", () => {
    const u = unavailable("cryptoquant", "not_configured", "no key");
    expect(u.reason).toBe("not_configured");
    expect(describeUnavailable(u)).toContain("غير مُفعَّل");
  });

  it("map leaves the unavailable branch untouched", () => {
    const u = unavailable("x", "network_error");
    const mapped = mapAvailability(u, () => 1);
    expect(mapped.available).toBe(false);
    if (!mapped.available) expect(mapped.reason).toBe("network_error");
  });

  it("valueOrUndefined never fabricates a zero", () => {
    expect(valueOrUndefined(unavailable("x", "stale"))).toBeUndefined();
    expect(valueOrUndefined(available(0, "x", 1))).toBe(0);
  });

  it("requireFresh demotes data that is too old, with the ages in the reason", () => {
    const now = 1_000_000;
    const fresh = requireFresh(available(1, "x", now - 5_000), 10_000, now);
    expect(fresh.available).toBe(true);

    const stale = requireFresh(available(1, "x", now - 60_000), 10_000, now);
    expect(stale.available).toBe(false);
    if (!stale.available) {
      expect(stale.reason).toBe("stale");
      expect(stale.detail).toContain("60");
    }
  });
});

describe("config", () => {
  it("defaults to Binance and a sane risk profile", () => {
    const c = getConfig(env({}));
    expect(c.MARKET_EXCHANGE).toBe("binance");
    expect(c.RISK_PER_TRADE_PCT).toBe(1);
    expect(c.MAX_OPEN_POSITIONS).toBe(6);
    expect(c.MAX_CORRELATED_POSITIONS).toBe(3);
    expect(c.DAILY_LOSS_HALT_PCT).toBe(3);
    expect(c.MAX_DRAWDOWN_HALT_PCT).toBe(15);
    expect(c.MIN_FINAL_SCORE).toBe(60);
    expect(c.MIN_RISK_REWARD).toBe(1.8);
  });

  it("switches the whole market layer from one key", () => {
    expect(getConfig(env({ MARKET_EXCHANGE: "okx" })).MARKET_EXCHANGE).toBe("okx");
  });

  it("rejects an unknown venue instead of silently falling back", () => {
    expect(() => getConfig(env({ MARKET_EXCHANGE: "ftx" }))).toThrow(/إعدادات غير صالحة/);
  });

  it("rejects an out-of-range risk setting", () => {
    expect(() => getConfig(env({ RISK_PER_TRADE_PCT: "50" }))).toThrow(/إعدادات غير صالحة/);
  });

  it("leaves every paid provider OFF when no key is present", () => {
    const p = getConfig(env({})).providers;
    expect(p.cryptoquant.enabled).toBe(false);
    expect(p.coinglass.enabled).toBe(false);
    expect(p.lunarcrush.enabled).toBe(false);
    expect(p.cryptoquant.note).toContain("CRYPTOQUANT_API_KEY");
  });

  it("turns a provider on from the key alone", () => {
    const p = getConfig(env({ CRYPTOQUANT_API_KEY: "real-key-123" })).providers;
    expect(p.cryptoquant.enabled).toBe(true);
    expect(p.cryptoquant.note).toBe("مُفعَّل");
  });

  it("treats placeholder keys from .env.example as absent", () => {
    for (const placeholder of ["", "your_key_here", "changeme", "CHANGE_ME", "none"]) {
      expect(getConfig(env({ COINGLASS_API_KEY: placeholder })).providers.coinglass.enabled).toBe(false);
    }
  });

  it("keeps live trading off even when a key exists, until explicitly enabled", () => {
    const withKey = getConfig(env({ LIVE_EXCHANGE_API_KEY: "k" }));
    expect(withKey.providers.liveTrading.enabled).toBe(false);

    const enabled = getConfig(env({ LIVE_TRADING_ENABLED: "true", LIVE_EXCHANGE_API_KEY: "k" }));
    expect(enabled.providers.liveTrading.enabled).toBe(true);
  });

  it("parses the watchlist as uppercase symbols", () => {
    expect(getConfig(env({ WATCHLIST: "btcusdt, ethusdt ,solusdt" })).WATCHLIST)
      .toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    expect(getConfig(env({ WATCHLIST: "" })).WATCHLIST).toEqual([]);
  });
});
