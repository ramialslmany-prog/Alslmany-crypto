/**
 * `npm start` — the bot and the site, together, from one command.
 *
 * This exists because the alternative is two terminals, two commands and a
 * remembered order, and the person running this should not have to hold that.
 * The bot writes the database; the site reads it; neither is useful alone.
 *
 * Both children inherit this process's lifetime. Ctrl+C stops both, and if
 * either dies the other is stopped too — a site serving a database nobody is
 * updating looks healthy while being hours stale, which is worse than being
 * plainly down.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { getConfig } from "@/shared/config";

const BOLD = "\x1b[1m";
const DIM = "\x1b[90m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

const cfg = getConfig();
const argv = process.argv.slice(2);
const timeframe = argv[argv.indexOf("--timeframe") + 1] ?? "1h";
const port = argv[argv.indexOf("--port") + 1] ?? "3000";

// ── refuse to start on an empty database ────────────────────────────────────
//
// Starting anyway would show a site full of empty panels and a bot analysing
// nothing, and the reason would be three screens up in a log. Better to say it
// once, here, with the exact command that fixes it.
if (!fs.existsSync(cfg.dbPath)) {
  console.error(
    `${YELLOW}لا توجد قاعدة بيانات بعد (${cfg.dbPath}).${RESET}\n\n` +
    `حمّل التاريخ أولاً — مرة واحدة:\n` +
    `  ${BOLD}npm run backfill -- --top 100 --timeframes 15m,1h,4h,1d --years 1${RESET}\n\n` +
    `${DIM}أو للتجربة السريعة ببيانات وهمية: npm run seed && npm run dev:demo${RESET}`,
  );
  process.exit(1);
}

const children: ChildProcess[] = [];
let stopping = false;

function launch(name: string, colour: string, command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    shell: process.platform === "win32",
  });
  children.push(child);

  const prefix = `${colour}[${name}]${RESET} `;
  const relay = (chunk: Buffer, toErr = false): void => {
    // Prefixed line by line, so two interleaved streams stay readable.
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) (toErr ? process.stderr : process.stdout).write(`${prefix}${line}\n`);
    }
  };
  child.stdout?.on("data", (c: Buffer) => relay(c));
  child.stderr?.on("data", (c: Buffer) => relay(c, true));

  child.on("exit", (code) => {
    if (stopping) return;
    console.error(`\n${YELLOW}توقّف «${name}» (رمز ${code}). يُوقَف الباقي أيضاً.${RESET}`);
    console.error(
      `${DIM}موقع يقرأ قاعدة لا يحدّثها أحد يبدو سليماً وهو متأخّر ساعات — ` +
      `والتوقّف الظاهر أصدق من ذلك.${RESET}`,
    );
    stopAll(code ?? 1);
  });

  return child;
}

function stopAll(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (!c.killed) c.kill("SIGTERM");
  }
  // The bot finishes its current tick on SIGTERM; give it room before exiting.
  setTimeout(() => process.exit(code), 3_000);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n${DIM}إيقاف… (البوت يُنهي دورته الحالية أولاً)${RESET}`);
    stopAll(0);
  });
}

console.log(
  `${BOLD}منصّة السلماني${RESET}\n` +
  `${DIM}البوت على إطار ${timeframe} · الموقع على المنفذ ${port} · ` +
  `${cfg.SPOT_ONLY ? "سبوت فقط (شراء أو لا شيء)" : "شراء وبيع"}${RESET}\n`,
);

launch("bot", GREEN, "npx", ["tsx", "src/worker/bot.ts", "--timeframe", timeframe]);
launch("site", "\x1b[36m", "npx", ["next", "start", "-p", port]);

console.log(
  `\n${BOLD}افتح المتصفّح على http://localhost:${port}${RESET}\n` +
  `${DIM}للإيقاف: Ctrl+C — يوقف الاثنين معاً.${RESET}\n`,
);
