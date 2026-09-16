/**
 * News classification.
 *
 * DELIBERATELY RULE-BASED, not an LLM. Three reasons, and the third is the
 * one that settles it:
 *   1. It is free and needs no key.
 *   2. It is testable: the same headline always yields the same label.
 *   3. THE BACKTESTER MUST REPRODUCE IT. A model whose output drifts between
 *      runs — or that no longer exists in a year — makes a historical result
 *      unrepeatable, and an unrepeatable backtest is not evidence.
 *
 * The cost is real: it will miss sarcasm, novel phrasing, and anything the
 * keyword lists do not know. So its output is used DEFENSIVELY — to veto a
 * trade whose timing looks wrong — and never as a reason to enter.
 */

export type NewsSentiment = "positive" | "negative" | "neutral";

export interface ClassifiedNews {
  readonly title: string;
  readonly url: string;
  readonly source: string;
  readonly publishedAt: number;
  readonly sentiment: NewsSentiment;
  /** 0..1 — how strong the language is. */
  readonly intensity: number;
  /** 0..1 — how specifically this is about THE asset, not the market. */
  readonly relevance: number;
  /** The terms that produced the label, so the call is auditable. */
  readonly matched: readonly string[];
  readonly arabic: string;
}

/**
 * Severe terms carry weight 2, ordinary ones weight 1.
 *
 * "Hack" and "rally" are not the same magnitude of event and must not score
 * the same, or a routine price story outvotes an exchange being drained.
 */
const NEGATIVE: Record<string, number> = {
  hack: 2, hacked: 2, exploit: 2, exploited: 2, breach: 2, stolen: 2, drained: 2,
  rug: 2, rugpull: 2, scam: 2, fraud: 2, ponzi: 2,
  bankruptcy: 2, bankrupt: 2, insolvent: 2, insolvency: 2, collapse: 2, collapsed: 2,
  delist: 2, delisted: 2, delisting: 2, halted: 2, suspended: 2, frozen: 2,
  lawsuit: 2, sued: 2, charged: 2, indicted: 2, subpoena: 2, "class action": 2,
  ban: 2, banned: 2, crackdown: 2, seized: 2, "cease and desist": 2,
  liquidated: 1, liquidation: 1, plunge: 1, plunged: 1, crash: 1, crashed: 1,
  slump: 1, tumble: 1, tumbled: 1, selloff: 1, "sell-off": 1, dump: 1, dumped: 1,
  warning: 1, warns: 1, probe: 1, investigation: 1, investigating: 1,
  outflow: 1, outflows: 1, downgrade: 1, bearish: 1, decline: 1, falls: 1, drops: 1,
  vulnerability: 1, bug: 1, downtime: 1, outage: 1, unlock: 1, dilution: 1,
};

const POSITIVE: Record<string, number> = {
  approval: 2, approved: 2, approves: 2, greenlight: 2, "green light": 2,
  partnership: 1, partners: 1, integration: 1, integrates: 1, adoption: 1,
  listing: 2, listed: 2, lists: 2, launch: 1, launches: 1, launched: 1,
  upgrade: 1, upgraded: 1, mainnet: 1, "burn": 1, buyback: 1, staking: 1,
  inflow: 1, inflows: 1, accumulation: 1, accumulating: 1, whale: 1,
  rally: 1, rallies: 1, surge: 1, surges: 1, soars: 1, jumps: 1, breakout: 1,
  bullish: 1, record: 1, "all-time high": 2, ath: 1, milestone: 1,
  funding: 1, raise: 1, raised: 1, investment: 1, institutional: 1, etf: 1,
};

/** Terms that make an item market-wide rather than asset-specific. */
const MARKET_WIDE = [
  "crypto market", "bitcoin", "btc", "market cap", "fed", "cpi", "inflation",
  "interest rate", "fomc", "regulation", "sec", "macro",
];

export interface AssetIdentity {
  /** "BTCUSDT" */
  readonly symbol: string;
  /** "BTC" */
  readonly ticker: string;
  /** "Bitcoin" — improves matching considerably when known. */
  readonly name?: string;
}

/**
 * Classify one headline.
 *
 * Relevance and sentiment are independent: a catastrophic story about another
 * coin is high intensity and near-zero relevance, and must not veto this
 * trade. Conflating them is how a bot refuses to trade Solana because
 * something happened to a coin it has never heard of.
 */
export function classifyNews(
  item: { title: string; summary?: string; url: string; source: string; publishedAt: number },
  asset: AssetIdentity,
): ClassifiedNews {
  const haystack = `${item.title} ${item.summary ?? ""}`.toLowerCase();
  const matched: string[] = [];

  let negative = 0;
  for (const [term, weight] of Object.entries(NEGATIVE)) {
    if (containsTerm(haystack, term)) {
      negative += weight;
      matched.push(term);
    }
  }

  let positive = 0;
  for (const [term, weight] of Object.entries(POSITIVE)) {
    if (containsTerm(haystack, term)) {
      positive += weight;
      matched.push(term);
    }
  }

  const net = positive - negative;
  const sentiment: NewsSentiment = net > 0 ? "positive" : net < 0 ? "negative" : "neutral";
  // Saturating: six weighted hits is as strong as this measure gets.
  const intensity = Math.min(1, Math.abs(net) / 6);

  const relevance = relevanceOf(haystack, asset);

  return {
    title: item.title,
    url: item.url,
    source: item.source,
    publishedAt: item.publishedAt,
    sentiment,
    intensity,
    relevance,
    matched,
    arabic: describe(sentiment, intensity, relevance, matched, asset),
  };
}

/**
 * Word-boundary matching.
 *
 * Substring matching would fire "ban" inside "banking" and "urban", which is
 * exactly the kind of false veto that makes a risk filter useless.
 */
function containsTerm(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(haystack);
}

function relevanceOf(haystack: string, asset: AssetIdentity): number {
  const ticker = asset.ticker.toLowerCase();
  const name = asset.name?.toLowerCase();

  // The ticker or the project name in the text is the strongest signal.
  if (name && containsTerm(haystack, name)) return 1;
  if (containsTerm(haystack, ticker)) return 0.9;

  // Market-wide stories affect everything, but weakly and indirectly.
  for (const term of MARKET_WIDE) {
    if (haystack.includes(term)) return 0.35;
  }
  return 0.05;
}

function describe(
  sentiment: NewsSentiment,
  intensity: number,
  relevance: number,
  matched: readonly string[],
  asset: AssetIdentity,
): string {
  const label = sentiment === "positive" ? "إيجابي" : sentiment === "negative" ? "سلبي" : "محايد";
  const strength = intensity > 0.6 ? "شديد" : intensity > 0.3 ? "متوسط" : "خفيف";
  const scope =
    relevance >= 0.9 ? `يخصّ ${asset.ticker} تحديداً` :
    relevance >= 0.3 ? "خبر سوق عام، أثره غير مباشر" :
    "لا علاقة واضحة له بهذه العملة";

  return `${label} ${strength} · ${scope}${matched.length > 0 ? ` (${matched.slice(0, 4).join("، ")})` : ""}.`;
}

export interface NewsAggregate {
  readonly items: readonly ClassifiedNews[];
  /** −1..1, weighted by relevance and intensity. */
  readonly netSentiment: number;
  /** The most severe asset-specific negative story, if any. */
  readonly worstNegative: ClassifiedNews | null;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly arabic: string;
}

/** Only stories about THIS asset can carry real weight. */
const RELEVANCE_FLOOR = 0.3;

export function aggregateNews(items: readonly ClassifiedNews[]): NewsAggregate {
  const relevant = items.filter((i) => i.relevance >= RELEVANCE_FLOOR);

  let weighted = 0;
  let weightSum = 0;
  for (const i of relevant) {
    const sign = i.sentiment === "positive" ? 1 : i.sentiment === "negative" ? -1 : 0;
    const weight = i.relevance;
    weighted += sign * i.intensity * weight;
    weightSum += weight;
  }

  const negatives = relevant
    .filter((i) => i.sentiment === "negative")
    .sort((a, b) => b.intensity * b.relevance - a.intensity * a.relevance);

  const positiveCount = relevant.filter((i) => i.sentiment === "positive").length;
  const negativeCount = negatives.length;

  return {
    items: relevant,
    netSentiment: weightSum > 0 ? weighted / weightSum : 0,
    worstNegative: negatives[0] ?? null,
    positiveCount,
    negativeCount,
    arabic:
      relevant.length === 0
        ? `لا أخبار ذات صلة بهذه العملة في النافذة (فُحص ${items.length} خبراً).`
        : `${relevant.length} خبراً ذا صلة: ${positiveCount} إيجابي و${negativeCount} سلبي` +
          (negatives[0]
            ? `. أشدّها سلبية: «${negatives[0].title.slice(0, 90)}» — ${negatives[0].arabic}`
            : "."),
  };
}
