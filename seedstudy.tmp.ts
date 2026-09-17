import { openDb, closeDb } from "@/storage/db";
import { CandleRepo } from "@/storage/repositories/candles";
import { SymbolRepo } from "@/storage/repositories/symbols";
import { backtestSymbol } from "./tests/fixtures/market";
import { TIMEFRAMES } from "@/shared/time";
const db = openDb("data/study.db");
const c = new CandleRepo(db), s = new SymbolRepo(db);
for (const [name, seed, price] of [["BTCUSDT",99,30000],["ETHUSDT",31,3000],["ALTUSDT",7,100]] as const) {
  const sym = backtestSymbol(name, 700, seed, price);
  s.upsertMany("binance", [sym.info]);
  s.setListedAt("binance","spot",name,sym.listedAt!);
  for (const tf of TIMEFRAMES) { const r = sym.candles[tf]; if (r?.length) c.upsertMany(name, tf, r, "archive"); }
}
closeDb();
