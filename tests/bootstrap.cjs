/**
 * Test entry point.
 *
 * The suite runs against compiled output rather than the sources directly, so
 * the engine is exercised through exactly the module graph TypeScript produces.
 * This shim teaches Node the "@/" alias that Next.js resolves at build time.
 */
const path = require("node:path");
const Module = require("node:module");

const BUILD = path.join(__dirname, "..", ".test-build");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) {
    return originalResolve.call(this, path.join(BUILD, "src", request.slice(2)), ...rest);
  }
  return originalResolve.call(this, request, ...rest);
};

require(path.join(BUILD, "tests", "run.js"));
