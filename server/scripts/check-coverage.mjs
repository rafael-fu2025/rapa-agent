#!/usr/bin/env node
// Coverage gate runner.
//
// Tries to run `vitest run --coverage`. If `@vitest/coverage-v8` is
// not installed, prints the install command and exits 0 (no gate
// failure — the threshold config in vitest.config.ts is dormant
// until the provider is installed).
//
// See `.agents/notes/implemented/testing/2026-08-15-coverage-gate.md`.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const coverageV8 = resolve(here, "..", "node_modules", "@vitest", "coverage-v8");

if (!existsSync(coverageV8)) {
  // eslint-disable-next-line no-console
  console.log(
    "[coverage-gate] @vitest/coverage-v8 is not installed.\n" +
    "              Run: npm install --save-dev @vitest/coverage-v8\n" +
    "              Until installed, the threshold gate in vitest.config.ts is dormant."
  );
  process.exit(0);
}

const result = spawnSync("npx", ["vitest", "run", "--coverage"], {
  cwd: resolve(here, ".."),
  stdio: "inherit",
  shell: true
});

process.exit(result.status ?? 1);