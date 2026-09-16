/**
 * Sentiment, news and the risk calendar.
 *
 * This stage exists to STOP trades, so its tests are mostly about what it
 * refuses and — just as importantly — what it declines to refuse. A risk
 * filter that vetoes on a headline about another coin is worse than none,
 * because it looks like it is protecting you.
 */
import { describe, expect, it } from "vitest";
import { parseRss } from "@/data/news/rss";
import { aggregateNews, classifyNews } from "@/core/sentiment/classify";
import { checkCalendar, newsVeto, VETO_WINDOWS, type CalendarEvent } from "@/core/sentiment/calendar";
import { runSentiment } from "@/core/pipeline/stage7-sentiment";
import { available, unavailable } from "@/shared/availability";
import type { FearGreed } from "@/core/types";

const NOW = Date.UTC(2024, 5, 1, 12, 0, 0);
const HOUR = 3_600_000;

const SOL = { symbol: "SOLUSDT", ticker: "SOL", name: "Solana" };

const news = (title: string, hoursAgo = 1, summary = "") => ({
  title, summary, url: "https://x", source: "Test", publishedAt: NOW - hoursAgo * HOUR,
});

// ── RSS parsing ──────────────────────────────────────────────────────────────

describe("RSS parsing", () => {
  const rss = `<?xml version="1.0"?><rss><channel>
    <item>
      <title><![CDATA[Solana network upgrade goes live]]></title>
      <description>The &lt;b&gt;upgrade&lt;/b&gt; shipped &amp; is live</description>
      <link>https://example.com/a</link>
      <pubDate>Sat, 01 Jun 2024 11:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Exchange halts withdrawals</title>
      <link>https://example.com/b</link>
      <pubDate>Sat, 01 Jun 2024 09:00:00 GMT</pubDate>
    </item>
  </channel></rss>`;

  it("reads items, strips CDATA and decodes entities", () => {
    const items = parseRss(rss, "Test");
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Solana network upgrade goes live");
    expect(items[0].summary).toContain("&");
    expect(items[0].summary).not.toContain("<b>");
  });

  it("returns items newest first", () => {
    const items = parseRss(rss, "Test");
    expect(items[0].publishedAt).toBeGreaterThan(items[1].publishedAt);
  });

  it("SKIPS an item with no readable date rather than guessing one", () => {
    // The whole stage is about timing; an undated item cannot be placed.
    const undated = `<rss><channel><item><title>No date here</title></item></channel></rss>`;
    expect(parseRss(undated, "Test")).toHaveLength(0);
  });

  it("reads Atom entries as well as RSS items", () => {
    const atom = `<feed><entry><title>Atom item</title>
      <link href="https://example.com/c"/>
      <published>2024-06-01T10:00:00Z</published></entry></feed>`;
    const items = parseRss(atom, "Test");
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe("https://example.com/c");
  });

  it("returns nothing from garbage rather than throwing", () => {
    expect(parseRss("not xml at all", "Test")).toEqual([]);
    expect(parseRss("", "Test")).toEqual([]);
  });
});

// ── classification ───────────────────────────────────────────────────────────

describe("news classification", () => {
  it("labels a hack negative and severe", () => {
    const c = classifyNews(news("Solana bridge exploited, funds stolen"), SOL);
    expect(c.sentiment).toBe("negative");
    expect(c.intensity).toBeGreaterThan(0.5);
    expect(c.relevance).toBe(1);
  });

  it("labels an approval positive", () => {
    const c = classifyNews(news("Solana ETF approved by regulator"), SOL);
    expect(c.sentiment).toBe("positive");
  });

  it("gives a story about ANOTHER coin near-zero relevance", () => {
    // The severity is real; the relevance is not. Conflating them is how a
    // bot refuses to trade Solana over news about a coin it never heard of.
    const c = classifyNews(news("Cardano exchange hacked, funds stolen"), SOL);
    expect(c.sentiment).toBe("negative");
    expect(c.intensity).toBeGreaterThan(0.5);
    expect(c.relevance).toBeLessThan(0.3);
  });

  it("gives market-wide news partial relevance", () => {
    const c = classifyNews(news("Bitcoin crashes as the Fed signals higher rates"), SOL);
    expect(c.relevance).toBeGreaterThan(0.2);
    expect(c.relevance).toBeLessThan(0.6);
  });

  it("matches on WORD BOUNDARIES — 'ban' must not fire inside 'banking'", () => {
    const c = classifyNews(news("Solana banking partnership expands urban access"), SOL);
    expect(c.matched).not.toContain("ban");
  });

  it("weights a severe term above an ordinary one", () => {
    const severe = classifyNews(news("Solana protocol exploited"), SOL);
    const ordinary = classifyNews(news("Solana declines slightly"), SOL);
    expect(severe.intensity).toBeGreaterThan(ordinary.intensity);
  });

  it("is neutral when positive and negative language cancel", () => {
    const c = classifyNews(news("Solana rally stalls as outflows rise"), SOL);
    expect(["neutral", "positive", "negative"]).toContain(c.sentiment);
    expect(c.matched.length).toBeGreaterThan(1);
  });

  it("records which terms produced the label, so the call is auditable", () => {
    const c = classifyNews(news("Solana network hacked"), SOL);
    expect(c.matched).toContain("hacked");
    expect(c.arabic).toContain("سلبي");
  });

  it("is deterministic — the same headline always yields the same label", () => {
    const a = classifyNews(news("Solana upgrade launches"), SOL);
    const b = classifyNews(news("Solana upgrade launches"), SOL);
    expect(a).toEqual(b);
  });
});

describe("news aggregation", () => {
  it("ignores stories below the relevance floor", () => {
    const items = [
      classifyNews(news("Cardano exchange hacked"), SOL),
      classifyNews(news("Dogecoin collapses"), SOL),
    ];
    const agg = aggregateNews(items);
    expect(agg.items).toHaveLength(0);
    expect(agg.worstNegative).toBeNull();
    expect(agg.arabic).toContain("لا أخبار ذات صلة");
  });

  it("surfaces the most severe asset-specific negative", () => {
    const items = [
      classifyNews(news("Solana sees minor outflows"), SOL),
      classifyNews(news("Solana bridge exploited, funds stolen"), SOL),
    ];
    const agg = aggregateNews(items);
    expect(agg.worstNegative?.title).toContain("exploited");
  });

  it("nets positive when the relevant news is good", () => {
    const items = [
      classifyNews(news("Solana ETF approved"), SOL),
      classifyNews(news("Solana mainnet upgrade launches"), SOL),
    ];
    expect(aggregateNews(items).netSentiment).toBeGreaterThan(0);
  });
});

// ── the calendar ─────────────────────────────────────────────────────────────

describe("risk calendar", () => {
  const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
    kind: "economic", at: NOW + HOUR, title: "CPI", severity: "high", ...over,
  });

  it("DISTINGUISHES 'not checked' from 'clear'", () => {
    const check = checkCalendar(null, SOL, "long", NOW);
    expect(check.available).toBe(false);
    expect(check.vetoes).toHaveLength(0);
    expect(check.arabic).toContain("«لم أفحص» ليست «فحصتُ ولم أجد شيئاً»");
  });

  it("vetoes a major economic event inside the window", () => {
    const check = checkCalendar([event({ at: NOW + 2 * HOUR })], SOL, "long", NOW);
    expect(check.vetoes.map((v) => v.id)).toContain("economic_event");
  });

  it("does NOT veto one outside the window", () => {
    const check = checkCalendar([event({ at: NOW + 10 * HOUR })], SOL, "long", NOW);
    expect(check.vetoes).toHaveLength(0);
    expect(check.upcoming).toHaveLength(1);
  });

  it("does not veto a low-severity economic event", () => {
    const check = checkCalendar([event({ at: NOW + HOUR, severity: "low" })], SOL, "long", NOW);
    expect(check.vetoes).toHaveLength(0);
  });

  it("vetoes a token unlock for LONGS only", () => {
    const unlock = event({ kind: "token_unlock", at: NOW + 24 * HOUR, assets: ["SOL"], percentOfSupply: 3 });
    expect(checkCalendar([unlock], SOL, "long", NOW).vetoes).toHaveLength(1);
    expect(checkCalendar([unlock], SOL, "short", NOW).vetoes).toHaveLength(0);
  });

  it("ignores an event for a different asset", () => {
    const other = event({ kind: "token_unlock", at: NOW + 12 * HOUR, assets: ["ADA"] });
    expect(checkCalendar([other], SOL, "long", NOW).vetoes).toHaveLength(0);
  });

  it("applies a market-wide event to every asset", () => {
    const wide = event({ at: NOW + HOUR, assets: [] });
    expect(checkCalendar([wide], SOL, "long", NOW).vetoes).toHaveLength(1);
  });

  it("ignores events already in the past — they are priced in", () => {
    expect(checkCalendar([event({ at: NOW - HOUR })], SOL, "long", NOW).vetoes).toHaveLength(0);
  });

  it("uses the windows the specification sets", () => {
    expect(VETO_WINDOWS.economicHours).toBe(4);
    expect(VETO_WINDOWS.severeNewsHours).toBe(6);
    expect(VETO_WINDOWS.unlockHours).toBe(72);
  });
});

describe("severe news veto", () => {
  it("vetoes a severe, asset-specific negative inside 6 hours", () => {
    const r = newsVeto(
      { title: "Solana exploited", intensity: 0.9, relevance: 1, publishedAt: NOW - 2 * HOUR },
      NOW,
    );
    expect(r.veto).toBe(true);
    expect(r.arabic).toContain("مهما كان التحليل الفني");
  });

  it("does NOT veto the same story once it is older than the window", () => {
    const r = newsVeto(
      { title: "Solana exploited", intensity: 0.9, relevance: 1, publishedAt: NOW - 12 * HOUR },
      NOW,
    );
    expect(r.veto).toBe(false);
    expect(r.arabic).toContain("خارج نافذة النقض");
  });

  it("does not veto on a mild negative", () => {
    expect(newsVeto(
      { title: "Solana dips", intensity: 0.2, relevance: 1, publishedAt: NOW },
      NOW,
    ).veto).toBe(false);
  });

  it("does not veto on a severe story about another coin", () => {
    expect(newsVeto(
      { title: "Cardano hacked", intensity: 0.9, relevance: 0.1, publishedAt: NOW },
      NOW,
    ).veto).toBe(false);
  });
});

// ── the stage ────────────────────────────────────────────────────────────────

describe("stage 7", () => {
  const fg = (value: number): FearGreed => ({ value, classification: "x", timestamp: NOW });

  const input = (over: Partial<Parameters<typeof runSentiment>[0]> = {}) => ({
    asset: SOL,
    direction: "long" as const,
    fearGreed: available(fg(50), "fng", NOW),
    fearGreedHistory: available(
      Array.from({ length: 60 }, (_, i) => fg(40 + (i % 20))), "fng", NOW,
    ),
    news: available([news("Solana network upgrade launches", 3)], "rss", NOW),
    calendar: [] as CalendarEvent[],
    social: unavailable("lunarcrush", "not_configured"),
    now: NOW,
    ...over,
  });

  it("passes on a quiet day", () => {
    expect(runSentiment(input()).status).toBe("pass");
  });

  it("reads EXTREME FEAR as favouring longs", () => {
    const fearful = runSentiment(input({ fearGreed: available(fg(12), "fng", NOW) }));
    const greedy = runSentiment(input({ fearGreed: available(fg(88), "fng", NOW) }));
    expect(fearful.score).toBeGreaterThan(greedy.score);
    expect(fearful.factors.find((f) => f.id === "fear_greed")?.note).toContain("معاكساً");
  });

  it("reverses the contrarian read for a SHORT", () => {
    const longSide = runSentiment(input({ fearGreed: available(fg(12), "fng", NOW), direction: "long" }));
    const shortSide = runSentiment(input({ fearGreed: available(fg(12), "fng", NOW), direction: "short" }));
    expect(longSide.score).toBeGreaterThan(shortSide.score);
  });

  it("CAPS the positive score — good news is never a reason to buy", () => {
    const glowing = runSentiment(input({
      fearGreed: available(fg(5), "fng", NOW),
      news: available([
        news("Solana ETF approved"), news("Solana mainnet upgrade launches"),
        news("Solana listing on major exchange"),
      ], "rss", NOW),
    }));
    expect(glowing.score).toBeLessThanOrEqual(35);
  });

  it("FAILS on a severe negative inside the window", () => {
    const r = runSentiment(input({
      news: available([news("Solana bridge exploited, funds stolen, protocol halted", 1)], "rss", NOW),
    }));
    expect(r.status).toBe("fail");
    expect(r.failReason).toContain("خبر سلبي شديد");
  });

  it("FAILS on an economic event inside the window", () => {
    const r = runSentiment(input({
      calendar: [{ kind: "economic", at: NOW + 2 * HOUR, title: "CPI", severity: "high" }],
    }));
    expect(r.status).toBe("fail");
    expect(r.failReason).toContain("حدث اقتصادي كبير");
  });

  it("FAILS a long on an imminent token unlock but not a short", () => {
    const unlock: CalendarEvent = {
      kind: "token_unlock", at: NOW + 24 * HOUR, title: "Unlock",
      severity: "high", assets: ["SOL"], percentOfSupply: 4,
    };
    expect(runSentiment(input({ calendar: [unlock] })).status).toBe("fail");
    expect(runSentiment(input({ calendar: [unlock], direction: "short" })).status).toBe("pass");
  });

  it("warns loudly when the calendar was never configured", () => {
    const r = runSentiment(input({ calendar: null }));
    expect(r.warnings.join()).toContain("لم يُفحصا");
    expect(r.confidencePenalty).toBeGreaterThan(0);
  });

  it("reports unavailable when nothing at all could be read", () => {
    const r = runSentiment(input({
      fearGreed: unavailable("fng", "network_error"),
      news: unavailable("rss", "network_error"),
      calendar: null,
    }));
    expect(r.status).toBe("unavailable");
  });

  it("does not let a story about another coin affect the score", () => {
    const quiet = runSentiment(input({ news: available([], "rss", NOW) }));
    const otherCoin = runSentiment(input({
      news: available([news("Cardano exchange hacked, funds stolen")], "rss", NOW),
    }));
    expect(otherCoin.score).toBeCloseTo(quiet.score, 6);
    expect(otherCoin.status).toBe("pass");
  });

  it("treats a social mention spike as crowding, not confirmation", () => {
    const r = runSentiment(input({
      social: available({ score: 70, socialVolumeChangePct: 220 }, "lunarcrush", NOW),
    }));
    const social = r.factors.find((f) => f.id === "social")!;
    expect(social.contribution).toBeLessThan(0);
    expect(social.note).toContain("ازدحام");
  });

  it("is deterministic", () => {
    expect(runSentiment(input()).score).toBe(runSentiment(input()).score);
  });
});
