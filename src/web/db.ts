/**
 * The site's read path.
 *
 * The site READS the same SQLite file the worker WRITES. That is the whole
 * architecture: no API layer between them, no cache to go stale, no second
 * source of truth to disagree with the first. WAL mode is what makes it safe —
 * readers never block the writer.
 *
 * Every function here is read-only and every one tolerates a database that
 * does not exist yet. A fresh clone with no worker run should render a site
 * that explains itself, not a stack trace.
 */
import fs from "node:fs";
import type Database from "better-sqlite3";
import { getConfig } from "@/shared/config";

let cached: Database.Database | null = null;
let checked = false;

/**
 * Open the database read-only, or return null when it is not there.
 *
 * `readonly` is deliberate: the site must never be able to write. A bug in a
 * page handler should not be able to corrupt the bot's state.
 */
export function readDb(): Database.Database | null {
  if (checked) return cached;
  checked = true;

  const cfg = getConfig();
  if (!fs.existsSync(cfg.dbPath)) return null;

  try {
    // Imported lazily so a missing native module degrades to "no data"
    // rather than crashing the whole render.
     
    const DatabaseCtor = require("better-sqlite3") as typeof Database;
    cached = new DatabaseCtor(cfg.dbPath, { readonly: true, fileMustExist: true });
    cached.pragma("busy_timeout = 4000");
    return cached;
  } catch {
    return null;
  }
}

/** True when the worker has produced a database at all. */
export function hasDatabase(): boolean {
  return readDb() !== null;
}

/**
 * Run a query, returning a fallback when there is no database or the table
 * does not exist yet. Pages stay renderable through every migration state.
 */
export function query<T>(fn: (db: Database.Database) => T, fallback: T): T {
  const db = readDb();
  if (!db) return fallback;
  try {
    return fn(db);
  } catch {
    return fallback;
  }
}
