import { NextResponse } from "next/server";

// Real crypto news via free public RSS feeds (no key). Cached 10 min.
export const revalidate = 600;

type Item = { title: string; link: string; pubDate: string; source: string };

function strip(s: string): string {
  return s
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function parseRss(xml: string, source: string): Item[] {
  const out: Item[] = [];
  const blocks = xml.split("<item>").slice(1);
  for (const b of blocks.slice(0, 25)) {
    const get = (tag: string) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? strip(m[1]) : "";
    };
    const title = get("title");
    const link = get("link");
    const pubDate = get("pubDate");
    if (title && link.startsWith("http")) out.push({ title, link, pubDate, source });
  }
  return out;
}

export async function GET() {
  const sources = [
    { url: "https://cointelegraph.com/rss", name: "Cointelegraph" },
    { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", name: "CoinDesk" },
  ];
  const all: Item[] = [];
  await Promise.all(
    sources.map(async (s) => {
      try {
        const r = await fetch(s.url, { next: { revalidate: 600 }, headers: { "user-agent": "Mozilla/5.0" } });
        if (r.ok) all.push(...parseRss(await r.text(), s.name));
      } catch {
        /* skip source */
      }
    })
  );
  all.sort((a, b) => (new Date(b.pubDate).getTime() || 0) - (new Date(a.pubDate).getTime() || 0));
  return NextResponse.json({ items: all.slice(0, 18), updatedAt: Date.now() });
}
