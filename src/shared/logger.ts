/**
 * Tiny structured logger. Deliberately dependency-free: the worker runs 24/7
 * and log output is part of the operator surface, so we control the format.
 *
 * Levels honour LOG_LEVEL (debug|info|warn|error). Output is one JSON object
 * per line when LOG_FORMAT=json (for a log shipper), human-readable otherwise.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLOR: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

function envLevel(): LogLevel {
  const v = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return v in LEVEL_RANK ? (v as LogLevel) : "info";
}

const asJson = () => process.env.LOG_FORMAT === "json";
const useColor = () => !asJson() && process.stdout.isTTY === true;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

function emit(scope: string, level: LogLevel, msg: string, fields?: Record<string, unknown>) {
  if (LEVEL_RANK[level] < LEVEL_RANK[envLevel()]) return;
  const ts = new Date().toISOString();
  if (asJson()) {
    process.stdout.write(JSON.stringify({ ts, level, scope, msg, ...fields }) + "\n");
    return;
  }
  const c = useColor() ? COLOR[level] : "";
  const r = useColor() ? RESET : "";
  const extra = fields && Object.keys(fields).length ? ` ${fmtFields(fields)}` : "";
  process.stdout.write(`${ts} ${c}${level.toUpperCase().padEnd(5)}${r} [${scope}] ${msg}${extra}\n`);
}

function fmtFields(f: Record<string, unknown>): string {
  return Object.entries(f)
    .map(([k, v]) => {
      if (v instanceof Error) return `${k}=${v.message}`;
      if (typeof v === "object" && v !== null) return `${k}=${JSON.stringify(v)}`;
      return `${k}=${String(v)}`;
    })
    .join(" ");
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit(scope, "debug", m, f),
    info: (m, f) => emit(scope, "info", m, f),
    warn: (m, f) => emit(scope, "warn", m, f),
    error: (m, f) => emit(scope, "error", m, f),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const log = createLogger("app");
