/**
 * Venue factory — the single switch the spec asks for.
 *
 * Changing MARKET_EXCHANGE in the config swaps the entire market-data layer.
 * Nothing else in the codebase names a venue.
 */
import type { AppConfig, ExchangeId } from "@/shared/config";
import type { MarketDataSource } from "@/data/market-source";
import { BinanceSource } from "@/data/exchanges/binance";
import { BybitSource } from "@/data/exchanges/bybit";
import { OkxSource } from "@/data/exchanges/okx";

export function createMarketSource(cfg: AppConfig, override?: ExchangeId): MarketDataSource {
  const id = override ?? cfg.MARKET_EXCHANGE;
  switch (id) {
    case "binance":
      return new BinanceSource(cfg);
    case "bybit":
      return new BybitSource(cfg);
    case "okx":
      return new OkxSource(cfg);
  }
}

/** Every venue, for the health page's cross-venue price-integrity check. */
export function createAllMarketSources(cfg: AppConfig): MarketDataSource[] {
  return [new BinanceSource(cfg), new BybitSource(cfg), new OkxSource(cfg)];
}

export { BinanceSource, BybitSource, OkxSource };
