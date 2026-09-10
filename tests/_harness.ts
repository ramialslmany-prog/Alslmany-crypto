/**
 * A dependency-free assertion harness.
 *
 * The analysis and trading engines are the part of this product where a quiet
 * numerical mistake is most expensive, so they are checked against hand-computed
 * and textbook values rather than trusted by eye. Run with `npm test`.
 */

let failures = 0;
let checks = 0;
let suite = "";

export async function describe(name: string, body: () => void | Promise<void>) {
  suite = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
  // Awaited, so an async block's assertions land before the report is written.
  await body();
}

function pass(label: string, detail = "") {
  checks++;
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}

function fail(label: string, detail: string) {
  checks++;
  failures++;
  console.log(`  \x1b[31m✗ ${label}\x1b[0m — ${detail}`);
}

export function ok(condition: boolean, label: string, detail = "") {
  condition ? pass(label, detail) : fail(label, detail || "expected true");
}

export function near(
  actual: number | null | undefined,
  expected: number,
  tolerance: number,
  label: string,
) {
  if (actual === null || actual === undefined || !Number.isFinite(actual)) {
    fail(label, `got ${actual}, expected ~${expected}`);
    return;
  }
  const delta = Math.abs(actual - expected);
  delta <= tolerance
    ? pass(label, `${actual.toFixed(4)}`)
    : fail(label, `got ${actual}, expected ${expected} ±${tolerance}`);
}

export function equal<T>(actual: T, expected: T, label: string) {
  actual === expected
    ? pass(label, String(actual))
    : fail(label, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

export function isNull(actual: unknown, label: string) {
  actual === null ? pass(label) : fail(label, `expected null, got ${JSON.stringify(actual)}`);
}

export function report(): never {
  const line = `${checks - failures}/${checks} checks passed`;
  if (failures === 0) {
    console.log(`\n\x1b[32m\x1b[1m✓ ${line}\x1b[0m\n`);
    process.exit(0);
  }
  console.log(`\n\x1b[31m\x1b[1m✗ ${failures} failed — ${line}\x1b[0m\n`);
  process.exit(1);
}

export { suite };
