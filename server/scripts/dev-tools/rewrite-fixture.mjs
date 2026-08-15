#!/usr/bin/env node
// One-shot fixture rewriter: captures fresh agent events and writes the fixture.
// Usage: node rewrite-fixture.mjs <fixture-name>
// Default: chat-greeter

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureName = process.argv[2] ?? "chat-greeter";
const capturedPath = resolve(here, ".tmp-snapshot-debug", "agent-events.json");
const fixturePath = resolve(here, "src/lib/agent/_snapshots", `${fixtureName}.json`);

if (!existsSync(fixturePath)) {
  console.error(`Fixture not found: ${fixturePath}`);
  process.exit(1);
}

console.log(`Re-recording fixture: ${fixtureName}`);
console.log("Running debug test to capture fresh events...");

// Patch the debug test to use the requested fixture
const debugTestPath = resolve(here, "src/lib/agent/_test/_debug-snapshot.test.ts");
if (!existsSync(debugTestPath)) {
  console.error(`Missing debug test: ${debugTestPath}`);
  process.exit(1);
}

const result = spawnSync("npx", ["vitest", "run", "src/lib/agent/_test/_debug-snapshot.test.ts"], {
  cwd: here,
  stdio: "inherit",
  shell: true
});
if (result.status !== 0) {
  console.error("Debug test failed");
  process.exit(result.status ?? 1);
}

const captured = JSON.parse(readFileSync(capturedPath, "utf-8"));
const existing = JSON.parse(readFileSync(fixturePath, "utf-8"));

const updated = {
  ...existing,
  recorded_at: new Date().toISOString(),
  events: captured
};

writeFileSync(fixturePath, JSON.stringify(updated, null, 2), "utf-8");
console.log(`Wrote ${captured.length} events to ${fixturePath}`);