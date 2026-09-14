/**
 * SQLite connection and migration runner.
 *
 * PRAGMA choices, all deliberate for a 24/7 single-writer bot:
 *   journal_mode = WAL   readers (the website) never block the writer (the worker)
 *   synchronous  = NORMAL survives a process crash; only a host power-cut can
 *                         lose the last transaction, which for market data we
 *                         simply refetch
 *   foreign_keys = ON    referential integrity is not optional for an
 *                         append-only audit trail
 *   busy_timeout         wait rather than throw when the writer holds the lock
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "@/shared/logger";
import { MIGRATIONS } from "@/storage/schema";

const log = createLogger("db");

export type Db = Database.Database;

let instance: Db | null = null;
let instancePath: string | null = null;

export function openDb(dbPath: string): Db {
  if (instance && instancePath === dbPath) return instance;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  // 64 MB page cache — candle range scans are the hot path.
  db.pragma("cache_size = -64000");
  db.pragma("temp_store = MEMORY");

  migrate(db);

  instance = db;
  instancePath = dbPath;
  return db;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
  instancePath = null;
}

function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const appliedIds = new Set(
    db.prepare<[], { id: number }>("SELECT id FROM schema_migrations").all().map((r) => r.id),
  );

  for (const m of MIGRATIONS) {
    if (appliedIds.has(m.id)) continue;
    log.info("applying migration", { id: m.id, name: m.name });
    // Each migration is one transaction: it applies fully or not at all.
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        m.id,
        m.name,
        Date.now(),
      );
    });
    run();
  }
}

/** Reclaim space and refresh the query planner's statistics. */
export function maintain(db: Db): void {
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("ANALYZE");
}
