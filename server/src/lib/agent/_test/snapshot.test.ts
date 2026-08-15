/**
 * Snapshot harness smoke test — runs the `plan-mode-basic` fixture
 * through the Agent loop in `replay` mode (default) and asserts
 * (a) the event sequence matches the fixture, and (b) the structural
 * assertions in the fixture pass.
 *
 * See `.agents/notes/implemented/testing/2026-08-15-snapshot-harness-for-agent-loop.md`.
 */

import { describe, expect, it } from "vitest";

import { assertSnapshotPass, loadFixture, runSnapshot } from "../snapshot/index.js";

describe("snapshot harness — chat-greeter", () => {
  it("replays a single-step chat response against the recorded fixture", async () => {
    const fixture = await loadFixture("chat-greeter");
    const result = await runSnapshot(fixture);

    if (!result.comparison.matched) {
      // Surface the first 5 diffs so a failure tells the contributor
      // exactly where the agent's actual stream diverges from the fixture.
      const sample = result.comparison.diffs.slice(0, 5).map((d) => `  [${d.index}] ${d.message}`).join("\n");
      const more = result.comparison.diffs.length > 5 ? `\n  ...and ${result.comparison.diffs.length - 5} more` : "";
      throw new Error(`Snapshot diff:\n${sample}${more}`);
    }

    expect(result.comparison.matched).toBe(true);

    for (const a of result.assertions) {
      expect(a.passed, `assertion failed: ${a.message ?? "(no message)"}`).toBe(true);
    }

    assertSnapshotPass(result);
  }, 30_000);
});