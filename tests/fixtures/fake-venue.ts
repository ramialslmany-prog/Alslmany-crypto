/**
 * A local HTTP server that speaks Binance's wire format.
 *
 * The point is to test the adapter END TO END — URL construction, paging,
 * numeric parsing, rate-limit handling, retries, error mapping — without
 * depending on the real venue being reachable or on it behaving the same way
 * twice. Recorded payload SHAPES come from Binance's documented responses.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeVenue {
  readonly url: string;
  readonly hits: { path: string; query: URLSearchParams }[];
  /** Force the next `n` requests to a path to fail with `status`. */
  failNext(pathPrefix: string, times: number, status: number, headers?: Record<string, string>): void;
  close(): Promise<void>;
}

const H = 3_600_000;

/** Deterministic synthetic klines, ascending, with Binance's -1ms closeTime. */
export function makeKlines(startOpen: number, count: number, stepMs = H): unknown[][] {
  const rows: unknown[][] = [];
  for (let i = 0; i < count; i++) {
    const open = startOpen + i * stepMs;
    const base = 100 + i;
    rows.push([
      open,
      (base).toFixed(8),
      (base + 5).toFixed(8),
      (base - 5).toFixed(8),
      (base + 2).toFixed(8),
      "10.00000000",
      open + stepMs - 1,
      ((base + 2) * 10).toFixed(8),
      50 + i,
      "6.00000000",
      ((base + 2) * 6).toFixed(8),
      "0",
    ]);
  }
  return rows;
}

export async function startFakeVenue(opts: { klineStart: number; klineCount: number }): Promise<FakeVenue> {
  const hits: { path: string; query: URLSearchParams }[] = [];
  const failures = new Map<string, { times: number; status: number; headers: Record<string, string> }>();

  const all = makeKlines(opts.klineStart, opts.klineCount);

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    hits.push({ path: u.pathname, query: u.searchParams });

    for (const [prefix, f] of failures) {
      if (u.pathname.startsWith(prefix) && f.times > 0) {
        f.times--;
        res.writeHead(f.status, { "content-type": "application/json", ...f.headers });
        res.end(JSON.stringify({ code: -1003, msg: "simulated failure" }));
        return;
      }
    }

    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    switch (u.pathname) {
      case "/api/v3/time":
        return json({ serverTime: 1710421200000 });

      case "/api/v3/exchangeInfo":
        return json({
          symbols: [
            {
              symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING",
              baseAssetPrecision: 8, quotePrecision: 8,
              filters: [
                { filterType: "PRICE_FILTER", tickSize: "0.01000000" },
                { filterType: "LOT_SIZE", stepSize: "0.00001000" },
                { filterType: "NOTIONAL", minNotional: "5.00000000" },
              ],
            },
            {
              symbol: "ETHUSDT", baseAsset: "ETH", quoteAsset: "USDT", status: "TRADING",
              filters: [
                { filterType: "PRICE_FILTER", tickSize: "0.01000000" },
                { filterType: "LOT_SIZE", stepSize: "0.00010000" },
              ],
            },
            // Wrong quote asset — the adapter must filter it out.
            { symbol: "BTCEUR", baseAsset: "BTC", quoteAsset: "EUR", status: "TRADING", filters: [] },
            // Halted — kept, but flagged.
            { symbol: "OLDUSDT", baseAsset: "OLD", quoteAsset: "USDT", status: "BREAK", filters: [] },
          ],
        });

      case "/api/v3/klines": {
        const limit = Number(u.searchParams.get("limit") ?? 500);
        const startTime = u.searchParams.get("startTime");
        const endTime = u.searchParams.get("endTime");
        let rows = all;
        if (startTime) rows = rows.filter((r) => Number(r[0]) >= Number(startTime));
        if (endTime) rows = rows.filter((r) => Number(r[0]) <= Number(endTime));
        // Binance returns the OLDEST `limit` rows when startTime is given,
        // and the NEWEST `limit` rows when it is not.
        rows = startTime ? rows.slice(0, limit) : rows.slice(-limit);
        return json(rows);
      }

      case "/api/v3/ticker/24hr": {
        const rows = [
          {
            symbol: "BTCUSDT", lastPrice: "71755.20000000", quoteVolume: "1234567890.12",
            priceChangePercent: "2.35", highPrice: "72000.00", lowPrice: "70500.00",
            bidPrice: "71755.10", askPrice: "71755.30",
          },
          {
            symbol: "ETHUSDT", lastPrice: "3850.55", quoteVolume: "987654321.00",
            priceChangePercent: "-1.10", highPrice: "3900.00", lowPrice: "3800.00",
            bidPrice: "3850.50", askPrice: "3850.60",
          },
        ];
        const sym = u.searchParams.get("symbol");
        return json(sym ? rows.find((r) => r.symbol === sym) : rows);
      }

      case "/api/v3/depth":
        return json({
          lastUpdateId: 99887766,
          bids: [["71755.10", "2.50000000"], ["71755.00", "5.00000000"]],
          asks: [["71755.30", "1.20000000"], ["71755.40", "8.00000000"]],
        });

      case "/api/v3/aggTrades":
        return json([
          { a: 1, p: "71755.10", q: "0.50000000", T: 1710421200123, m: true },
          { a: 2, p: "71755.30", q: "1.25000000", T: 1710421201456, m: false },
        ]);

      case "/fapi/v1/premiumIndex":
        return json({ lastFundingRate: "0.00012500", nextFundingTime: 1710432000000, time: 1710421200000 });

      case "/fapi/v1/fundingRate":
        return json([
          { symbol: "BTCUSDT", fundingRate: "0.00010000", fundingTime: 1710403200000 },
          { symbol: "BTCUSDT", fundingRate: "0.00012500", fundingTime: 1710432000000 },
        ]);

      case "/fapi/v1/openInterest":
        return json({ symbol: "BTCUSDT", openInterest: "78543.210", time: 1710421200000 });

      case "/futures/data/openInterestHist":
        return json([
          { sumOpenInterest: "78000.0", sumOpenInterestValue: "5600000000", timestamp: 1710417600000 },
          { sumOpenInterest: "78543.2", sumOpenInterestValue: "5640000000", timestamp: 1710421200000 },
        ]);

      case "/futures/data/globalLongShortAccountRatio":
        return json([
          { longAccount: "0.6200", shortAccount: "0.3800", longShortRatio: "1.6316", timestamp: 1710421200000 },
        ]);

      default:
        return json({ code: -1121, msg: "Invalid symbol." }, 400);
    }
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    failNext(pathPrefix, times, status, headers = {}) {
      failures.set(pathPrefix, { times, status, headers });
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
