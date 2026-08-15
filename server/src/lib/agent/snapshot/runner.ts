/**
 * Snapshot runner — wires a fixture through the Agent loop in three modes.
 *
 * See `.agents/notes/implemented/testing/2026-08-15-snapshot-harness-for-agent-loop.md`.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Agent } from "../../agent.js";
import { toolRegistry } from "../../tools.js";
import type { ToolExecutionContext } from "../../tools.js";
import type { AgentConfig } from "../types.js";

import { ReplayLLMClient } from "./replay-llm.js";
import { compareEvents, evaluateAssertions } from "./compare.js";
import type {
  SnapshotFixture,
  SnapshotMode,
  SnapshotRunResult
} from "./types.js";

/**
 * The Agent constructor accepts `llmClient?: LLMClient`; the snapshot
 * runner passes a `ReplayLLMClient` which satisfies the structural
 * contract but is not assignable to the concrete type. We cast at the
 * runner boundary so the Agent class itself remains unchanged.
 */
type LLMClientShaped = ConstructorParameters<typeof Agent>[2];

/** Resolve a fixture path relative to `server/src/lib/agent/_snapshots/`. */
export function fixturePath(name: string): string {
  const here = fileURLToPath(import.meta.url);
  const dir = resolve(here, "..", "..", "_snapshots");
  return resolve(dir, `${name}.json`);
}

export async function loadFixture(name: string): Promise<SnapshotFixture> {
  const raw = await readFile(fixturePath(name), "utf-8");
  return JSON.parse(raw) as SnapshotFixture;
}

function resolveMode(): SnapshotMode {
  const raw = (process.env.SNAPSHOT_MODE ?? "replay").toLowerCase();
  if (raw === "replay" || raw === "verify" || raw === "record") return raw;
  throw new Error(`Unknown SNAPSHOT_MODE: ${raw}`);
}

/**
 * Build a minimal Agent context for snapshot runs. Tools execute
 * against a temporary directory so file-system operations do not
 * touch the user's real workspace.
 */
function buildContext(fixture: SnapshotFixture): ToolExecutionContext {
  const workspaceRoot = fixture.input.workspaceRoot || process.cwd();
  return {
    workspaceRoot,
    conversationId: `snapshot-${fixture.name}`,
    mode: fixture.input.mode,
    // Tool approvals are auto-granted during replay — the fixture is
    // the source of truth, not the policy layer.
    autoApproveTools: new Set(toolRegistry.list().map((t) => t.name))
  } as unknown as ToolExecutionContext;
}

function buildConfig(fixture: SnapshotFixture): AgentConfig {
  return {
    model: fixture.recorded_with.model,
    provider: fixture.recorded_with.provider,
    seedHistory: fixture.input.seedHistory ?? [],
    maxIterations: 25,
    isNewConversation: true,
    apiKey: process.env.SNAPSHOT_API_KEY ?? "snapshot-key-not-used",
    primaryApiKeyId: "snapshot",
    primaryApiKeyName: "snapshot"
  } as unknown as AgentConfig;
}

/**
 * Run a fixture through the Agent loop and compare. Returns a result
 * struct suitable for vitest assertions.
 */
export async function runSnapshot(fixture: SnapshotFixture): Promise<SnapshotRunResult> {
  const mode = resolveMode();

  const replayLLM = new ReplayLLMClient({ fixture });
  const context = buildContext(fixture);
  const config = buildConfig(fixture);

  // The Agent constructor expects an `LLMClient`; ReplayLLMClient
  // satisfies the structural contract (`streamChat`/`callNonStreaming`
  // shape). Cast at the boundary.
  const agent = new Agent(context, config, replayLLM as unknown as LLMClientShaped);

  const events: unknown[] = [];
  for await (const ev of agent.stream(fixture.input.userPrompt)) {
    events.push(ev);
  }

  if (mode === "record") {
    const { writeFile } = await import("node:fs/promises");
    const next: SnapshotFixture = {
      ...fixture,
      recorded_at: new Date().toISOString(),
      recorded_with: { provider: fixture.recorded_with.provider, model: fixture.recorded_with.model },
      events: events as unknown as SnapshotFixture["events"]
    };
    await writeFile(fixturePath(fixture.name), JSON.stringify(next, null, 2), "utf-8");
  }

  const comparison = compareEvents(fixture, events);
  const assertionResults = evaluateAssertions(fixture.assertions, events);

  return { fixture, events: events as SnapshotFixture["events"], comparison, assertions: assertionResults };
}

/**
 * Vitest helper — asserts a snapshot run passes. Throws on mismatch.
 */
export function assertSnapshotPass(result: SnapshotRunResult): void {
  const { comparison, assertions, fixture } = result;
  if (!comparison.matched) {
    const summary = comparison.diffs.slice(0, 3).map((d) => `  - ${d.message}`).join("\n");
    const more = comparison.diffs.length > 3 ? `\n  ...and ${comparison.diffs.length - 3} more` : "";
    throw new Error(`Snapshot "${fixture.name}" mismatch:\n${summary}${more}`);
  }
  for (const a of assertions) {
    if (!a.passed) {
      throw new Error(`Snapshot "${fixture.name}" assertion failed: ${a.message ?? "(no message)"}`);
    }
  }
}