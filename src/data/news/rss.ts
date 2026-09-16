/**
 * News via RSS.
 *
 * RSS rather than a paid news API because it is free, needs no key, and the
 * major crypto outlets all publish it. The parser is deliberately small and
 * forgiving: a malformed feed returns the items it could read rather than
 * failing the whole stage, because one broken outlet must not blind the bot
 * to the other four.
 */
import { type Availability, available, unavailable } from "@/shared/availability";
import type { AppConfig } from "@/shared/config";

export interface NewsItem {
  readonly title: string;
  readonly summary: string;
  readonly url: string;
  readonly source: string;
  readonly publishedAt: number;
}

/** Outlets that publish a usable RSS feed without a key. */
export const DEFAULT_FEEDS: { name: string; url: string }[] = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "The Block", url: "https://www.theblock.co/rss.xml" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
];

/**
 * Pull one value out of an XML element.
 *
 * A real XML parser would be correct in more cases, but RSS items are flat and
 * the dependency is not worth it. What matters is that a tag this misses
 * yields an empty string rather than a crash.
 */
function tag(xml: string, name: string): string {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  if (!match) return "";
  return decodeEntities(stripCdata(match[1])).trim();
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function decodeEntities(s: string): string {
  // Order matters twice over. Entities are decoded BEFORE tags are stripped,
  // because feeds escape their markup (`&lt;b&gt;`) and stripping first would
  // leave that markup behind as literal tags in the summary. And `&amp;` is
  // decoded LAST, so that `&amp;lt;` becomes the visible text `&lt;` rather
  // than a tag that the stripper would then eat.
  const decoded = s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

  return decoded
    .replace(/<[^>]+>/g, " ") // strip HTML, however it arrived
    .replace(/\s+/g, " ");
}

export function parseRss(xml: string, sourceName: string): NewsItem[] {
  const out: NewsItem[] = [];
  // Both RSS (<item>) and Atom (<entry>) appear among the crypto outlets.
  const blocks = [
    ...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi),
  ];

  for (const block of blocks) {
    const raw = block[0];
    const title = tag(raw, "title");
    if (!title) continue;

    const dateText =
      tag(raw, "pubDate") || tag(raw, "published") || tag(raw, "updated") || tag(raw, "dc:date");
    const publishedAt = Date.parse(dateText);

    // An item with no readable date cannot be placed in a time window, and
    // the whole stage is about timing — so it is skipped rather than guessed.
    if (!Number.isFinite(publishedAt)) continue;

    const linkMatch = /<link[^>]*href=["']([^"']+)["']/i.exec(raw);
    const url = linkMatch ? linkMatch[1] : tag(raw, "link");

    out.push({
      title,
      summary: (tag(raw, "description") || tag(raw, "summary") || tag(raw, "content")).slice(0, 400),
      url,
      source: sourceName,
      publishedAt,
    });
  }

  return out.sort((a, b) => b.publishedAt - a.publishedAt);
}

export class NewsSource {
  readonly id = "rss";

  constructor(
    private readonly cfg: AppConfig,
    private readonly feeds: { name: string; url: string }[] = DEFAULT_FEEDS,
  ) {}

  /**
   * Fetch every feed and merge.
   *
   * Partial success is success: if three of four outlets answer, the stage
   * runs on three and records which one failed, rather than reporting the
   * whole world unavailable because one server was slow.
   */
  async recent(withinMs = 48 * 3_600_000, now = Date.now()): Promise<Availability<NewsItem[]>> {
    // Fetched with `fetch` directly rather than through the shared JSON helper:
    // RSS is XML, and a JSON parser would reject every feed.
    const responses = await Promise.all(
      this.feeds.map(async (feed) => {
        try {
          const res = await fetch(feed.url, {
            headers: {
              "user-agent": this.cfg.HTTP_USER_AGENT,
              accept: "application/rss+xml, application/xml, text/xml, */*",
            },
            signal: AbortSignal.timeout(this.cfg.HTTP_TIMEOUT_MS),
          });
          return { feed, xml: res.ok ? await res.text() : null };
        } catch {
          return { feed, xml: null };
        }
      }),
    );

    const items: NewsItem[] = [];
    const failed: string[] = [];

    for (const { feed, xml } of responses) {
      if (!xml) {
        failed.push(feed.name);
        continue;
      }
      items.push(...parseRss(xml, feed.name));
    }

    if (items.length === 0) {
      return unavailable(
        "rss",
        "network_error",
        `تعذّر قراءة أي مصدر أخبار (${failed.join("، ") || "الكل"})`,
      );
    }

    const cutoff = now - withinMs;
    const recent = items
      .filter((i) => i.publishedAt >= cutoff && i.publishedAt <= now + 3_600_000)
      .sort((a, b) => b.publishedAt - a.publishedAt);

    // The source label records HOW MANY outlets answered, so a reading built
    // on one feed out of four is visibly narrower than one built on all four.
    return available(recent, `rss:${this.feeds.length - failed.length}/${this.feeds.length}`, now);
  }
}
