import { report } from "./_harness";
import { run as indicators } from "./indicators.test";
import { run as structure } from "./structure.test";
import { run as engine } from "./engine.test";
import { run as bot } from "./bot.test";

/**
 * Suites run in sequence so their output stays readable, and every one is
 * awaited — an async assertion that lands after the report is an assertion
 * that never ran.
 */
async function main() {
  await indicators();
  await structure();
  await engine();
  await bot();
  report();
}

main().catch((err) => {
  console.error("\nTest runner crashed:", err);
  process.exit(1);
});
