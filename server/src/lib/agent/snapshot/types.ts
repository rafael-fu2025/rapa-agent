/**
 * Snapshot harness types — see
 * `.agents/notes/implemented/testing/2026-08-15-snapshot-harness-for-agent-loop.md`
 *
 * Mode is selected via env var `SNAPSHOT_MODE`:
 *   - "replay"  (default): load fixture, mock LLM, diff events. Keyless.
 *   - "verify":             run against real LLM, diff events. Skips without API key.
 *   - "record":             run against real LLM, overwrite fixture. Never run in CI.
 */

import type { AgentExecutionEvent } from "../types.js";

export type SnapshotMode = "replay" | "verify" | "record";

export type SnapshotAssertion =
  | { kind: "tool_called"; name: string; min?: number; max?: number }
  | { kind: "no_tool_called"; name: string }
  | { kind: "iteration_count"; min?: number; max?: number }
  | { kind: "contains_text"; text: string; caseSensitive?: boolean };

export interface SnapshotFixture {
  /** Stable name; matches the filename in `_snapshots/`. */
  name: string;
  /** Format version. Bumped on breaking fixture-schema changes. */
  version: 1;
  /** ISO timestamp at which the fixture was recorded. Informational. */
  recorded_at: string;
  /** Provider+model used to record. The `verify` mode may self-skip on mismatch. */
  recorded_with: {
    provider: string;
    model: string;
  };
  /** Inputs that drive the agent run. */
  input: {
    mode: "chat" | "plan" | "agent";
    userPrompt: string;
    seedHistory?: Array<{ role: "user" | "assistant" | "system" | "tool"; content: string }>;
    /** Workspace root for tool execution. Empty string = no workspace. */
    workspaceRoot: string;
  };
  /** Expected event sequence. */
  events: AgentExecutionEvent[];
  /** Optional structural assertions evaluated after event diff passes. */
  assertions?: SnapshotAssertion[];
}

export interface SnapshotComparisonResult {
  matched: boolean;
  diffs: Array<{
    index: number;
    field: string;
    expected: unknown;
    actual: unknown;
    message: string;
  }>;
}

export interface SnapshotRunResult {
  fixture: SnapshotFixture;
  events: AgentExecutionEvent[];
  comparison: SnapshotComparisonResult;
  assertions: Array<{ assertion: SnapshotAssertion; passed: boolean; message?: string }>;
}

/**
 * Fields that are excluded from deep-equal comparison.
 * - Timestamps: noisy, recorded_at is informational
 * - tokenUsage: provider-dependent, brittle
 * - conversationId: replaced with a constant during replay
 * - agentRunId / assistantMessageId: server-assigned, opaque
 */
export const SNAPSHOT_IGNORED_FIELDS = new Set([
  "recorded_at",
  "elapsedMs",
  "conversationId",
  "agentRunId",
  "assistantMessageId",
  "tokenUsage",
]);

/**
 * Reasoning strings are compared as prefix-only to absorb minor
 * temperature drift. See ADR §"Comparison rules".
 */
export const REASONING_PREFIX_CHARS = 200;