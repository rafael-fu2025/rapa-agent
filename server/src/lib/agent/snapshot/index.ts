/**
 * Public surface of the snapshot harness.
 * See `.agents/notes/implemented/testing/2026-08-15-snapshot-harness-for-agent-loop.md`.
 */

export { ReplayLLMClient } from "./replay-llm.js";
export type { LLMStreamEvent } from "./replay-llm.js";
export { compareEvents, evaluateAssertions, normalizeEvent } from "./compare.js";
export { runSnapshot, assertSnapshotPass, loadFixture, fixturePath } from "./runner.js";
export type {
  SnapshotAssertion,
  SnapshotComparisonResult,
  SnapshotFixture,
  SnapshotMode,
  SnapshotRunResult
} from "./types.js";
export { REASONING_PREFIX_CHARS, SNAPSHOT_IGNORED_FIELDS } from "./types.js";