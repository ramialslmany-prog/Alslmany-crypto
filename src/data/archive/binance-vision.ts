/**
 * data.binance.vision — the bulk historical archive.
 *
 * This is the backbone of any honest backtest: the REST kline endpoint pages
 * 1000 bars at a time and is rate-limited, so building years of 5m history
 * through it is impractical. The archive ships the same bars as monthly and
 * daily zips.
 *
 * Three correctness concerns are handled explicitly:
 *
 *  1. CHECKSUM VERIFICATION. Every file has a .CHECKSUM sibling. A truncated
 *     download is still valid gzip and still parses — it just silently
 *     contains less history than you think. We verify SHA-256 before import
 *     and record the result, so "I have 2019-2024" is a claim the manifest
 *     can prove.
 *
 *  2. MICROSECOND TIMESTAMPS. Files published from 2025 onward switched some
 *     datasets from millisecond to microsecond open times. Parsed naively,
 *     those bars land in the year 57000 and sort to the end of the series.
 *     We detect the magnitude and normalize.
 *
 *  3. HEADER ROWS. Newer files carry a CSV header; older ones do not. We
 *     detect and skip it rather than parsing "open_time" as NaN.
 *
 * The parse path deliberately reuses the SAME normalizer as the live REST
 * adapter, so archived history and live data can never diverge in shape.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { getBuffer } from "@/data/http";
import { binanceKlineRow, dedupeSorted } from "@/data/kline-row";
import { type Availability, available, unavailable } from "@/shared/availability";
import type { AppConfig } from "@/shared/config";
import { createLogger } from "@/shared/logger";
import {
  type Timeframe,
  dayKeysBetween,
  monthKeysBetween,
  tfMillis,
} from "@/shared/time";
import type { Candle, Trade } from "@/core/types";

const log = createLogger("archive");

const ARCHIVE_HOST = "https://data.binance.vision";

export type ArchivePeriod = "monthly" | "daily";
/**
 * `liquidationSnapshot` is every forced close the venue executed — the only
 * free record of where leverage actually died, as opposed to where a model
 * says it might.
 *
 * `metrics` is the derivatives history: open interest and the long/short
 * ratios, published daily for USD-M futures. It is the only free archive of
 * what stage 5 reads live, and without it the backtest and the live bot
 * disagree about which stages exist — which makes the backtest unable to
 * validate the thing it is supposed to validate.
 */
export type ArchiveDataType = "klines" | "aggTrades" | "metrics" | "liquidationSnapshot";
export type ArchiveMarket = "spot" | "um"; // um = USD-M futures

export interface ArchiveTarget {
  readonly symbol: string;
  readonly dataType: ArchiveDataType;
  readonly timeframe?: Timeframe;
  readonly period: ArchivePeriod;
  readonly periodKey: string; // "YYYY-MM" or "YYYY-MM-DD"
  readonly market: ArchiveMarket;
}

export interface ArchiveFetchResult {
  readonly target: ArchiveTarget;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly checksumOk: boolean | null;
  readonly csv: string;
}

/**
 * Timestamps above this are microseconds, not milliseconds.
 * 1e14 ms is the year 5138; 1e14 µs is 1973 — no real market data sits
 * between those, so the split is unambiguous.
 */
const MICROSECOND_THRESHOLD = 1e14;

function normalizeEpoch(raw: number): number {
  return raw > MICROSECOND_THRESHOLD ? Math.floor(raw / 1000) : raw;
}

export function archiveUrl(t: ArchiveTarget): string {
  const root = t.market === "um" ? "data/futures/um" : "data/spot";
  const name = fileBase(t);
  const dir =
    t.dataType === "klines"
      ? `${root}/${t.period}/klines/${t.symbol}/${t.timeframe}`
      : `${root}/${t.period}/${t.dataType}/${t.symbol}`;
  return `${ARCHIVE_HOST}/${dir}/${name}.zip`;
}

function fileBase(t: ArchiveTarget): string {
  return t.dataType === "klines"
    ? `${t.symbol}-${t.timeframe}-${t.periodKey}`
    : `${t.symbol}-${t.dataType}-${t.periodKey}`;
}

/** One row of the derivatives metrics archive. */
export interface MetricRow {
  readonly timestamp: number;
  readonly openInterest: number;
  readonly openInterestValue: number;
  /** Ratio of long to short ACCOUNTS among top traders. */
  readonly topTraderAccountRatio: number | null;
  /** Ratio of long to short POSITION SIZE among top traders. */
  readonly topTraderPositionRatio: number | null;
  /** Ratio across all accounts. */
  readonly accountRatio: number | null;
  /** Taker buy volume over taker sell volume. */
  readonly takerVolumeRatio: number | null;
}

const num = (v: string | undefined): number => {
  // Same rule as the kline parser: an empty column is NOT zero. Binance
  // leaves these blank for illiquid symbols, and a real zero open interest
  // would be a very different claim from "not published".
  if (v === undefined) return NaN;
  const t = v.trim();
  return t === "" ? NaN : Number(t);
};

/**
 * Parse the metrics CSV.
 *
 * `create_time` is a formatted UTC string ("2024-06-01 00:05:00"), not an
 * epoch — the one place in this archive where that is true, and the reason
 * this parser exists rather than reusing the kline row normalizer.
 */
export function parseMetrics(csv: string): MetricRow[] {
  const out: MetricRow[] = [];

  for (const line of csv.split(/\r?\n/)) {
    if (!line || line.startsWith("create_time")) continue;
    const c = line.split(",");
    if (c.length < 8) continue;

    // Treat the naive timestamp as UTC; Binance publishes it that way.
    const timestamp = Date.parse(`${c[0].trim().replace(" ", "T")}Z`);
    const openInterest = num(c[2]);
    if (!Number.isFinite(timestamp) || !Number.isFinite(openInterest)) continue;

    const optional = (v: string | undefined): number | null => {
      const n = num(v);
      return Number.isFinite(n) ? n : null;
    };

    out.push({
      timestamp,
      openInterest,
      openInterestValue: Number.isFinite(num(c[3])) ? num(c[3]) : 0,
      topTraderAccountRatio: optional(c[4]),
      topTraderPositionRatio: optional(c[5]),
      accountRatio: optional(c[6]),
      takerVolumeRatio: optional(c[7]),
    });
  }

  return out.sort((a, b) => a.timestamp - b.timestamp);
}

export class BinanceVisionArchive {
  constructor(private readonly cfg: AppConfig) {}

  private cacheFile(t: ArchiveTarget): string {
    const sub =
      t.dataType === "klines"
        ? path.join(t.market, t.dataType, t.symbol, String(t.timeframe))
        : path.join(t.market, t.dataType, t.symbol);
    return path.join(this.cfg.archivePath, sub, `${fileBase(t)}.zip`);
  }

  /**
   * Download (or read from the local cache), verify the checksum, unzip, and
   * return the raw CSV text.
   */
  async fetch(t: ArchiveTarget, opts: { useCache?: boolean } = {}): Promise<Availability<ArchiveFetchResult>> {
    const url = archiveUrl(t);
    const cachePath = this.cacheFile(t);
    const useCache = opts.useCache ?? true;

    let zipBytes: Uint8Array | null = null;

    if (useCache && fs.existsSync(cachePath)) {
      zipBytes = new Uint8Array(fs.readFileSync(cachePath));
      log.debug("archive cache hit", { file: path.basename(cachePath), bytes: zipBytes.length });
    } else {
      const dl = await getBuffer(url, {
        source: `binance-vision:${t.dataType}`,
        timeoutMs: 180_000,
        retries: this.cfg.HTTP_RETRIES,
        userAgent: this.cfg.HTTP_USER_AGENT,
      });
      if (!dl.available) return dl;
      zipBytes = dl.value;
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, zipBytes);
    }

    const sha256 = crypto.createHash("sha256").update(zipBytes).digest("hex");
    const checksumOk = await this.verifyChecksum(url, sha256);

    if (checksumOk === false) {
      // A mismatched file is worse than a missing one: it looks like history.
      try {
        fs.unlinkSync(cachePath);
      } catch {
        /* the retry re-downloads regardless */
      }
      return unavailable(
        `binance-vision:${t.dataType}`,
        "bad_response",
        `بصمة SHA-256 غير مطابقة لـ ${fileBase(t)} — حُذف الملف`,
      );
    }

    let csv: string;
    try {
      const files = unzipSync(zipBytes);
      const entry = Object.keys(files).find((k) => k.toLowerCase().endsWith(".csv"));
      if (!entry) {
        return unavailable(`binance-vision:${t.dataType}`, "bad_response", "لا يوجد CSV داخل الأرشيف");
      }
      csv = new TextDecoder().decode(files[entry]);
    } catch (err) {
      return unavailable(`binance-vision:${t.dataType}`, "bad_response", `فشل فك الضغط: ${String(err)}`);
    }

    return available(
      { target: t, url, bytes: zipBytes.length, sha256, checksumOk, csv },
      `binance-vision:${t.dataType}`,
      Date.now(),
    );
  }

  /**
   * Compare against the published .CHECKSUM.
   * Returns null when the checksum file itself is unreachable — we do not
   * treat "could not verify" as "verified".
   */
  private async verifyChecksum(zipUrl: string, sha256: string): Promise<boolean | null> {
    const r = await getBuffer(`${zipUrl}.CHECKSUM`, {
      source: "binance-vision:checksum",
      timeoutMs: 30_000,
      retries: 1,
      userAgent: this.cfg.HTTP_USER_AGENT,
    });
    if (!r.available) {
      log.warn("checksum unavailable — import proceeds unverified", { url: zipUrl });
      return null;
    }
    // Format: "<sha256>  <filename>"
    const published = new TextDecoder().decode(r.value).trim().split(/\s+/)[0]?.toLowerCase();
    if (!published) return null;
    const ok = published === sha256.toLowerCase();
    if (!ok) log.error("checksum mismatch", { url: zipUrl, published, computed: sha256 });
    return ok;
  }

  /** Parse an archived kline CSV into candles. */
  parseKlineCsv(csv: string, tf: Timeframe): Candle[] {
    const out: Candle[] = [];
    const step = tfMillis(tf);

    for (const line of iterateLines(csv)) {
      const cols = line.split(",");
      if (cols.length < 11) continue;
      // Skip the header row present in newer files.
      if (!isNumericStart(cols[0])) continue;

      const rawOpen = Number(cols[0]);
      if (!Number.isFinite(rawOpen)) continue;
      const openTime = normalizeEpoch(rawOpen);

      // Rebuild the row with a normalized open time, then hand it to the SAME
      // normalizer the live REST adapter uses.
      const candle = binanceKlineRow(
        [openTime, cols[1], cols[2], cols[3], cols[4], cols[5], openTime + step - 1, cols[7], cols[8], cols[9], cols[10]],
        tf,
      );
      if (candle) out.push(candle);
    }
    return dedupeSorted(out);
  }

  /** Parse an archived aggTrades CSV. Columns: id, price, qty, firstId, lastId, ts, isBuyerMaker, isBestMatch */
  parseAggTradeCsv(csv: string): Trade[] {
    const out: Trade[] = [];
    for (const line of iterateLines(csv)) {
      const c = line.split(",");
      if (c.length < 7) continue;
      if (!isNumericStart(c[0])) continue;
      const price = Number(c[1]);
      const qty = Number(c[2]);
      const ts = normalizeEpoch(Number(c[5]));
      if (!Number.isFinite(price) || !Number.isFinite(qty) || !Number.isFinite(ts)) continue;
      out.push({
        id: Number(c[0]),
        price,
        quantity: qty,
        quoteQuantity: price * qty,
        timestamp: ts,
        buyerIsMaker: c[6] === "true" || c[6] === "True" || c[6] === "1",
      });
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
  }

  /**
   * Plan the file list covering [from, to].
   *
   * Monthly files for whole months, daily files for the trailing partial
   * month — Binance publishes a month's zip only after the month ends, so
   * asking for the current month always 404s.
   */
  planKlineTargets(
    symbol: string,
    tf: Timeframe,
    from: number,
    to: number,
    market: ArchiveMarket = "spot",
  ): ArchiveTarget[] {
    const targets: ArchiveTarget[] = [];
    const now = Date.now();
    const currentMonth = new Date(now).toISOString().slice(0, 7);

    for (const key of monthKeysBetween(from, Math.min(to, now))) {
      if (key >= currentMonth) continue; // not published yet
      targets.push({ symbol, dataType: "klines", timeframe: tf, period: "monthly", periodKey: key, market });
    }

    // Daily files for the part of the range inside the current month.
    const monthStart = Date.parse(`${currentMonth}-01T00:00:00.000Z`);
    const dailyFrom = Math.max(from, monthStart);
    if (dailyFrom <= Math.min(to, now)) {
      const yesterday = now - 86_400_000;
      for (const key of dayKeysBetween(dailyFrom, Math.min(to, yesterday))) {
        targets.push({ symbol, dataType: "klines", timeframe: tf, period: "daily", periodKey: key, market });
      }
    }
    return targets;
  }
}

/** Split on newlines without allocating the whole array of lines at once. */
function* iterateLines(text: string): Generator<string> {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end).trim();
    if (line.length > 0) yield line;
    start = end + 1;
  }
}

function isNumericStart(s: string): boolean {
  const c = s.trim().charCodeAt(0);
  return c >= 48 && c <= 57; // '0'..'9'
}


/** One forced liquidation, as the archive records it. */
export interface LiquidationRow {
  readonly timestamp: number;
  /** Side of the ORDER the venue submitted, not of the dead position. */
  readonly orderSide: "buy" | "sell";
  /** Side of the POSITION that was liquidated — what a trader cares about. */
  readonly positionSide: "long" | "short";
  readonly price: number;
  readonly quantity: number;
  readonly notional: number;
}

/**
 * Parse the liquidation snapshot CSV.
 *
 * The side needs care and is the one thing easy to get backwards: the venue
 * publishes the side of the ORDER IT SENT, and to close a long it must SELL.
 * Reading the column literally labels every long liquidation a "sell" and
 * inverts the entire signal — a cluster of dead longs would be read as
 * sellers arriving rather than as longs being forced out.
 */
export function parseLiquidations(csv: string): LiquidationRow[] {
  const out: LiquidationRow[] = [];

  for (const line of csv.split(/\r?\n/)) {
    if (!line || line.startsWith("time,") || line.startsWith("time\t")) continue;
    const c = line.split(",");
    if (c.length < 6) continue;

    const timestamp = Number(c[0]);
    const side = c[1]?.trim().toUpperCase();
    // `average_price` is what actually filled; `price` is the order's limit.
    const price = Number(c[6] ?? c[5]);
    const quantity = Number(c[8] ?? c[4]);

    if (!Number.isFinite(timestamp) || !(price > 0) || !(quantity > 0)) continue;
    if (side !== "BUY" && side !== "SELL") continue;

    out.push({
      timestamp,
      orderSide: side === "BUY" ? "buy" : "sell",
      positionSide: side === "SELL" ? "long" : "short",
      price,
      quantity,
      notional: price * quantity,
    });
  }

  return out.sort((a, b) => a.timestamp - b.timestamp);
}
