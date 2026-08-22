#!/usr/bin/env node
// Coverage gate runner.
//
// Runs `vitest run --coverage`. @vitest/coverage-v8 is a committed
// devDependency, so a missing provider means the install is broken — the
// gate FAILS LOUDLY rather than silently passing. Thresholds live in
// vitest.config.ts.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const coverageV8 = resolve(here, "..", "node_modules", "@vitest", "coverage-v8");

if (!existsSync(coverageV8)) {
  // eslint-disable-next-line no-console
  console.error(
    "[coverage-gate] @vitest/coverage-v8 is not installed — the gate will not run.\n" +
    "                Fix your install: npm install\n" +
    "                (it is a committed devDependency of this package.)"
  );
  process.exit(1);
}

const result = spawnSync("npx", ["vitest", "run", "--coverage"], {
  cwd: resolve(here, ".."),
  stdio: "inherit",
  shell: true
});

process.exit(result.status ?? 1);