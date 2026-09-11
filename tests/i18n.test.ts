import { dictionaries, translate } from "../src/lib/i18n";
import type { Lang } from "../src/lib/i18n/types";
import { classifyMarket, classifyRegime } from "../src/lib/analysis/regime";
import { recommend } from "../src/lib/engine/recommendation";
import { canOpen } from "../src/lib/bot/engine";
import { emptyState } from "../src/lib/bot/types";
import type { Candle, Series, Timeframe } from "../src/lib/market/types";
import type { UniverseEntry } from "../src/lib/market/universe";
import { describe, equal, ok } from "./_harness";

/**
 * Translation coverage.
 *
 * The engine deliberately emits stable keys and never prose, which is what
 * lets one analysis read natively in both languages. The cost of that design
 * is that a key with no dictionary entry degrades into a raw identifier on
 * screen — an Arabic reader shown "below-200ema".
 *
 * Rather than listing keys by hand and hoping the list stays current, this
 * runs the real engines over fixtures, harvests every key they actually
 * produce, and asserts each one resolves in both languages. A new factor added
 * to the engine without a translation fails here.
 */

function ramp(bars: number, start: number, drift: number): Candle[] {
  let p = start;
  const out: Candle[] = [];
  for (let i = 0; i < bars; i++) {
    const wobble = Math.sin(i / 5) * 0.004 + Math.cos(i / 11) * 0.0024;
    const next = p * (1 + drift + wobble);
    out.push({
      t: i * 3600_000, o: p,
      h: Math.max(p, next) * 1.004, l: Math.min(p, next) * 0.996,
      c: next, v: 1000 + Math.abs(Math.sin(i / 3)) * 400,
    });
    p = next;
  }
  return out;
}

const series = (candles: Candle[], timeframe: Timeframe): Series => ({
  symbol: "TEST", timeframe, candles, source: "binance", fetchedAt: 0,
});

const ENTRY: UniverseEntry = {
  symbol: "TEST", id: "test", name: "Test", nameAr: "اختبار",
  sector: "smart-contract", tier: 1,
};

/** Every key the running engines emit across a spread of market conditions. */
function harvestKeys(): Set<string> {
  const keys = new Set<string>();
  const shapes: [string, number, number][] = [
    ["bull", 100, 0.006],
    ["bear", 300, -0.006],
    ["flat", 100, 0.0001],
  ];

  for (const [, start, drift] of shapes) {
    const daily = ramp(300, start, drift);
    for (const e of classifyRegime(daily).evidence) keys.add(e.key);

    for (const breadth of [15, 50, 80]) {
      for (const fear of [10, 50, 90]) {
        const market = classifyMarket({ btcCandles: daily, breadth, fearGreed: fear });
        for (const note of market.notes) keys.add(note);

        for (const [, s2, d2] of shapes) {
          for (const tier of [1, 3] as const) {
            for (const sector of ["smart-contract", "meme"] as const) {
              const rec = recommend({
                entry: { ...ENTRY, tier, sector },
                stack: {
                  "1d": series(ramp(300, s2, d2), "1d"),
                  "4h": series(ramp(300, s2, d2), "4h"),
                  "1h": series(ramp(300, s2, d2), "1h"),
                  "15m": series(ramp(300, s2, d2), "15m"),
                },
                market,
                btcCorrelation: 0.9,
              });
              if (!rec) continue;

              for (const f of [...rec.bullish, ...rec.bearish]) keys.add(f.key);
              for (const w of rec.warnings) keys.add(w);
              for (const s of rec.scenarios) {
                keys.add(s.triggerKey);
                keys.add(s.detailKey);
              }
              if (rec.plan) keys.add(rec.plan.invalidationKey);
              keys.add(`verdict.${rec.verdict}`);
              keys.add(`horizon.${rec.horizon}`);
              keys.add(`regime.${rec.regime.label}`);

              const gate = canOpen(emptyState(0), rec);
              if (!gate.ok) keys.add(`refuse.${gate.reason}`);
            }
          }
        }
      }
    }
  }

  // Exit reasons are emitted by the bot rather than the analysis engines.
  for (const reason of ["target", "stop", "breakeven", "trailing", "time", "regime", "manual"]) {
    keys.add(`exit.${reason}`);
  }
  return keys;
}

export async function run() {
  const keys = [...harvestKeys()].sort();

  await describe("translation coverage — keys the engine actually emits", () => {
    ok(keys.length > 40, "harvested a meaningful set of keys", `${keys.length} keys`);

    for (const lang of ["ar", "en"] as Lang[]) {
      // translate() falls back to the key itself when nothing is found, so a
      // result equal to the key means the entry is missing.
      const missing = keys.filter((k) => translate(lang, k) === k);
      equal(
        missing.length,
        0,
        `every emitted key resolves in ${lang}`,
      );
      if (missing.length > 0) {
        console.log(`      missing in ${lang}: ${missing.slice(0, 12).join(", ")}`);
      }
    }
  });

  await describe("the two dictionaries mirror each other", () => {
    const ar = Object.keys(dictionaries.ar).sort();
    const en = Object.keys(dictionaries.en).sort();
    const onlyAr = ar.filter((k) => !(k in dictionaries.en));
    const onlyEn = en.filter((k) => !(k in dictionaries.ar));
    equal(onlyAr.length, 0, "no key exists only in Arabic");
    if (onlyAr.length) console.log(`      only in ar: ${onlyAr.slice(0, 10).join(", ")}`);
    equal(onlyEn.length, 0, "no key exists only in English");
    if (onlyEn.length) console.log(`      only in en: ${onlyEn.slice(0, 10).join(", ")}`);
    ok(ar.length > 200, "the dictionary is substantial", `${ar.length} keys`);
  });

  await describe("no entry is left blank", () => {
    for (const lang of ["ar", "en"] as Lang[]) {
      const blank = Object.entries(dictionaries[lang])
        .filter(([, v]) => typeof v !== "string" || v.trim().length === 0)
        .map(([k]) => k);
      equal(blank.length, 0, `no empty strings in ${lang}`);
    }
  });

  await describe("interpolation", () => {
    equal(translate("en", "term.signals.count", { count: 7 }), "7 assets", "fills a placeholder");
    ok(
      translate("ar", "term.signals.count", { count: 7 }).includes("7"),
      "fills the Arabic placeholder too",
    );
    equal(
      translate("en", "nonexistent.key.here"),
      "nonexistent.key.here",
      "an unknown key degrades to itself rather than to blank space",
    );
  });
}
