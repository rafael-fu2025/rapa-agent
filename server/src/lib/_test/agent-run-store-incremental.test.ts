// Tests for detachable-run persistence in agent-run-store.ts:
//   - persistRunStepIncremental writes one step + its tool calls mid-run,
//     rolls the run-row counters forward, and is idempotent on retry;
//   - persistAgentRun (the final pass) is idempotent over already
//     incrementally-persisted runs — the end state is exactly ONE copy of
//     each step/toolcall/checkpoint/process session.
// The Prisma client is an in-memory fake (hoisted so the vi.mock factory can
// close over it); the tool registry is stubbed so tests never touch dev.db
// or the real 58-tool registry.

import { beforeEach, describe, expect, it, vi } from "vitest";

const testDb = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: string };
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}_${(idCounter += 1)}`;

  /** Prisma update semantics: `undefined` fields leave the row untouched. */
  function applyData(row: Row, data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) row[key] = value;
    }
  }

  const tables = {
    runs: [] as Row[],
    steps: [] as Row[],
    toolCalls: [] as Row[],
    checkpoints: [] as Row[],
    processSessions: [] as Row[],
    messages: [] as Row[]
  };

  type DeleteWhere = { runId: string; stepId?: string };
  function deleteMatching(table: Row[], where: DeleteWhere) {
    const before = table.length;
    const kept = table.filter((row) => {
      if (where.runId !== undefined && row.runId !== where.runId) return true;
      if (where.stepId !== undefined && row.stepId !== where.stepId) return true;
      return false;
    });
    table.length = 0;
    table.push(...kept);
    return { count: before - kept.length };
  }

  const models = {
    conversation: {
      update: async () => ({})
    },

    message: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row: Row = { id: nextId("msg"), ...args.data };
        tables.messages.push(row);
        return row;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = tables.messages.find((candidate) => candidate.id === args.where.id);
        if (!row) throw new Error(`message ${args.where.id} not found`);
        applyData(row, args.data);
        return row;
      }
    },

    agentRun: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row: Row = { id: nextId("run"), iterationCount: 0, ...args.data };
        tables.runs.push(row);
        return row;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = tables.runs.find((candidate) => candidate.id === args.where.id);
        if (!row) throw new Error(`agentRun ${args.where.id} not found`);
        applyData(row, args.data);
        return row;
      },
      updateMany: async () => ({ count: 0 }),
      findUnique: async (args: { where: { id: string }; select?: Record<string, unknown> }) => {
        const row = tables.runs.find((candidate) => candidate.id === args.where.id);
        if (!row || !args.select) return row ?? null;
        const projected: Row = { id: row.id };
        for (const key of Object.keys(args.select)) projected[key] = row[key];
        return projected;
      },
      findMany: async () => []
    },

    agentRunStep: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row: Row = { id: nextId("step"), ...args.data };
        tables.steps.push(row);
        return row;
      },
      upsert: async (args: {
        where: { runId_iteration: { runId: string; iteration: number } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const key = args.where.runId_iteration;
        const existing = tables.steps.find(
          (row) => row.runId === key.runId && row.iteration === key.iteration
        );
        if (existing) {
          applyData(existing, args.update);
          return existing;
        }
        const row: Row = { id: nextId("step"), ...args.create };
        tables.steps.push(row);
        return row;
      },
      deleteMany: async (args: { where: DeleteWhere }) => deleteMatching(tables.steps, args.where)
    },

    agentToolCall: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row: Row = { id: nextId("call"), ...args.data };
        tables.toolCalls.push(row);
        return row;
      },
      deleteMany: async (args: { where: DeleteWhere }) => deleteMatching(tables.toolCalls, args.where)
    },

    agentCheckpoint: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row: Row = { id: nextId("ckpt"), ...args.data };
        tables.checkpoints.push(row);
        return row;
      },
      deleteMany: async (args: { where: DeleteWhere }) => deleteMatching(tables.checkpoints, args.where)
    },

    agentProcessSession: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row: Row = { id: nextId("proc"), ...args.data };
        tables.processSessions.push(row);
        return row;
      },
      deleteMany: async (args: { where: DeleteWhere }) => deleteMatching(tables.processSessions, args.where)
    }
  };

  // Composed after `models` so the tx parameter type does not reference the
  // object it is declared in (avoids TS7022 self-reference).
  const prisma = {
    ...models,
    $transaction: async <T,>(fn: (tx: typeof models) => Promise<T>) => fn(models)
  };

  return { prisma, tables };
});

vi.mock("../db.js", () => ({ prisma: testDb.prisma }));
vi.mock("../../tools/index.js", () => ({
  toolRegistry: {
    // Mirrors the real ToolRegistry.get shape: a tool whose `.definition`
    // carries the category/requiresApproval metadata the store reads.
    get: (name: string) => {
      if (name === "write_file") {
        return { definition: { name: "write_file", category: "filesystem", requiresApproval: true } };
      }
      if (name === "execute_command") {
        return { definition: { name: "execute_command", category: "shell", requiresApproval: true } };
      }
      return undefined;
    },
    list: () => []
  }
}));

import type { AgentStep, ToolCall } from "../agent.js";
import type { ToolResult } from "../tools.js";
import { persistAgentRun, persistRunStepIncremental } from "../agent-run-store.js";

type Row = Record<string, unknown> & { id: string };
const tables = testDb.tables as {
  runs: Row[];
  steps: Row[];
  toolCalls: Row[];
  checkpoints: Row[];
  processSessions: Row[];
  messages: Row[];
};

// -- helpers -----------------------------------------------------------------

let runCounter = 0;

function seedRun(overrides: Record<string, unknown> = {}): string {
  runCounter += 1;
  const runId = `seed_run_${runCounter}`;
  tables.runs.push({
    id: runId,
    conversationId: "conv-1",
    status: "running",
    iterationCount: 0,
    ...overrides
  });
  return runId;
}

function makeCall(name: string, id: string, parameters: Record<string, unknown> = {}): ToolCall {
  return { id, name, parameters };
}

function makeResult(overrides: Partial<ToolResult> = {}): ToolResult {
  return { success: true, ...overrides };
}

function makeStep(iteration: number, overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    iteration,
    reasoning: `reasoning ${iteration}`,
    toolCalls: [],
    toolResults: [],
    timestamp: new Date(`2026-01-01T00:00:0${iteration % 10}Z`),
    ...overrides
  };
}

function counts() {
  return {
    runs: tables.runs.length,
    steps: tables.steps.length,
    toolCalls: tables.toolCalls.length,
    checkpoints: tables.checkpoints.length,
    processSessions: tables.processSessions.length,
    messages: tables.messages.length
  };
}

beforeEach(() => {
  for (const table of Object.values(tables)) table.length = 0;
});

// -- tests -------------------------------------------------------------------

describe("persistRunStepIncremental", () => {
  it("writes one step with its tool calls and rolls run counters forward", async () => {
    const runId = seedRun();

    await persistRunStepIncremental({
      runId,
      conversationId: "conv-1",
      step: {
        iteration: 1,
        reasoning: "reasoning 1",
        response: "working on it",
        timestamp: new Date("2026-01-01T00:00:01Z")
      },
      toolCalls: [
        { call: makeCall("read_file", "c1"), result: makeResult({ output: "file body" }) },
        {
          call: makeCall("write_file", "c2", { path: "/ws/a.txt" }),
          result: makeResult({ success: false, error: "denied", data: { rejected: true } })
        }
      ]
    });

    expect(tables.steps.length).toBe(1);
    expect(tables.steps[0]).toMatchObject({
      runId,
      iteration: 1,
      reasoning: "reasoning 1",
      response: "working on it",
      toolCallCount: 2,
      toolFailureCount: 1
    });
    expect(tables.toolCalls.length).toBe(2);
    expect(tables.toolCalls.map((row) => row.status)).toEqual(["completed", "failed"]);
    // Approval metadata mirrors the final persist's format exactly.
    expect(tables.toolCalls[1]).toMatchObject({
      requiresApproval: true,
      approvedByUser: false,
      approvalId: "conv-1:c2",
      riskLevel: "requires_approval"
    });
    const run = tables.runs[0];
    expect(run.iterationCount).toBe(1);
    expect(run.responsePreview).toBe("working on it");
    expect(run.status).toBe("running"); // mid-run write does not flip the status
  });

  it("is idempotent on retry — the same iteration is upserted, tool calls replaced", async () => {
    const runId = seedRun();
    const payload = {
      runId,
      conversationId: "conv-1",
      step: { iteration: 2, reasoning: "second", response: "still going" },
      toolCalls: [{ call: makeCall("read_file", "c1") }, { call: makeCall("read_file", "c2") }]
    };

    await persistRunStepIncremental(payload);
    await persistRunStepIncremental(payload);

    expect(tables.steps.length).toBe(1);
    expect(tables.toolCalls.length).toBe(2);
    expect(tables.runs[0].iterationCount).toBe(2);
  });

  it("replacing a step's tool calls removes only that iteration's previous rows", async () => {
    const runId = seedRun();
    const base = {
      runId,
      conversationId: "conv-1",
      step: { iteration: 1, reasoning: "r" }
    };
    await persistRunStepIncremental({
      ...base,
      toolCalls: [{ call: makeCall("read_file", "old-1") }, { call: makeCall("read_file", "old-2") }, { call: makeCall("read_file", "old-3") }]
    });
    await persistRunStepIncremental({
      ...base,
      toolCalls: [{ call: makeCall("read_file", "new-1") }]
    });

    expect(tables.steps.length).toBe(1);
    expect(tables.toolCalls.length).toBe(1);
    expect(tables.toolCalls[0].externalCallId).toBe("new-1");
    expect(tables.steps[0].toolCallCount).toBe(1);
  });

  it("keeps iterationCount monotonic and leaves responsePreview untouched without a response", async () => {
    const runId = seedRun();
    await persistRunStepIncremental({
      runId,
      conversationId: "conv-1",
      step: { iteration: 1, response: "first response" },
      toolCalls: []
    });
    await persistRunStepIncremental({
      runId,
      conversationId: "conv-1",
      step: { iteration: 3 }, // jump ahead; no response
      toolCalls: []
    });

    const run = tables.runs[0];
    expect(run.iterationCount).toBe(3);
    expect(run.responsePreview).toBe("first response");
  });

  it("sanitizes parameters with the same 12k string cap as the final persist", async () => {
    const runId = seedRun();
    const huge = "x".repeat(20_000);
    await persistRunStepIncremental({
      runId,
      conversationId: "conv-1",
      step: { iteration: 1 },
      toolCalls: [{ call: makeCall("read_file", "c1", { content: huge }) }]
    });

    const serialized = JSON.stringify(tables.toolCalls[0].parameters);
    expect(serialized.length).toBeLessThanOrEqual(12_100);
    expect(serialized).toContain("…");
  });
});

describe("persistAgentRun — idempotent final pass", () => {
  it("final persist over incremental rows yields exactly one copy of everything", async () => {
    const runId = seedRun();
    // Mid-run: iterations 1 and 2 land incrementally.
    await persistRunStepIncremental({
      runId,
      conversationId: "conv-1",
      step: { iteration: 1, reasoning: "r1", response: "partial" },
      toolCalls: [
        { call: makeCall("write_file", "c1", { path: "/ws/a.txt" }), result: makeResult({ data: { path: "/ws/a.txt" } }) },
        { call: makeCall("read_file", "c2"), result: makeResult({ output: "body" }) }
      ]
    });
    await persistRunStepIncremental({
      runId,
      conversationId: "conv-1",
      step: { iteration: 2, reasoning: "r2" },
      toolCalls: [
        {
          call: makeCall("execute_command", "c3", { command: "npm test" }),
          result: makeResult({ output: "ok", data: { exitCode: 0, cwd: "/ws" } })
        }
      ]
    });
    expect(counts()).toMatchObject({ steps: 2, toolCalls: 3 });

    // Final pass with the authoritative full history (same 2 steps).
    const steps: AgentStep[] = [
      makeStep(1, {
        toolCalls: [makeCall("write_file", "c1", { path: "/ws/a.txt" }), makeCall("read_file", "c2")],
        toolResults: [
          makeResult({ data: { path: "/ws/a.txt" } }),
          makeResult({ output: "body" })
        ],
        response: "partial"
      }),
      makeStep(2, {
        toolCalls: [makeCall("execute_command", "c3", { command: "npm test" })],
        toolResults: [makeResult({ output: "ok", data: { exitCode: 0, cwd: "/ws" } })]
      })
    ];
    await persistAgentRun({
      conversationId: "conv-1",
      workspaceId: "ws-1",
      workspacePath: "/ws",
      triggerMessageId: "msg-trigger",
      provider: "gemini",
      model: "gemini-pro",
      prompt: "do the thing",
      content: "all done",
      steps,
      status: "completed",
      existingRunId: runId
    });

    expect(counts()).toMatchObject({
      steps: 2,
      toolCalls: 3,
      checkpoints: 1, // write_file with a path
      processSessions: 1, // execute_command
      messages: 1 // assistant message
    });

    const run = tables.runs.find((row) => row.id === runId);
    expect(run).toMatchObject({ status: "completed", iterationCount: 2 });

    // Checkpoints/process sessions link to the FINAL tool call rows (the
    // deleted incremental rows' ids are gone).
    const finalCallIds = new Set(tables.toolCalls.map((row) => row.id as string));
    expect(tables.checkpoints.every((row) => finalCallIds.has(row.toolCallId as string))).toBe(true);
    expect(tables.processSessions.every((row) => finalCallIds.has(row.toolCallId as string))).toBe(true);
  });

  it("running the final persist twice keeps steps/toolcalls/checkpoints deduped", async () => {
    const runId = seedRun();
    await persistRunStepIncremental({
      runId,
      conversationId: "conv-1",
      step: { iteration: 1, reasoning: "r1" },
      toolCalls: [
        { call: makeCall("write_file", "c1", { path: "/ws/a.txt" }), result: makeResult({ data: { path: "/ws/a.txt" } }) },
        { call: makeCall("execute_command", "c2", { command: "ls" }), result: makeResult({ data: { cwd: "/ws" } }) }
      ]
    });

    const params = {
      conversationId: "conv-1",
      workspaceId: "ws-1",
      workspacePath: "/ws",
      triggerMessageId: "msg-trigger",
      provider: "gemini",
      model: "gemini-pro",
      prompt: "do the thing",
      content: "done",
      status: "completed" as const,
      existingRunId: runId,
      steps: [
        makeStep(1, {
          toolCalls: [makeCall("write_file", "c1", { path: "/ws/a.txt" }), makeCall("execute_command", "c2", { command: "ls" })],
          toolResults: [
            makeResult({ data: { path: "/ws/a.txt" } }),
            makeResult({ data: { cwd: "/ws" } })
          ]
        })
      ]
    };

    await persistAgentRun(params);
    await persistAgentRun(params);

    // Child rows are deduped by the delete-first cleanup...
    expect(counts()).toMatchObject({
      steps: 1,
      toolCalls: 2,
      checkpoints: 1,
      processSessions: 1
    });
    // ...but the header transaction creates one assistant message per
    // persist CALL (pre-existing behavior — the route persists the final
    // result exactly once; a double call is a test-only worst case).
    expect(counts().messages).toBe(2);
  });

  it("create path (no existingRunId) still produces a single consistent copy", async () => {
    const steps: AgentStep[] = [
      makeStep(1, {
        toolCalls: [makeCall("write_file", "c1", { path: "/ws/b.txt" })],
        toolResults: [makeResult({ data: { path: "/ws/b.txt" } })]
      })
    ];
    await persistAgentRun({
      conversationId: "conv-1",
      workspaceId: "ws-1",
      workspacePath: "/ws",
      provider: "gemini",
      model: "gemini-pro",
      prompt: "p",
      content: "c",
      steps,
      status: "completed"
    });

    expect(counts()).toMatchObject({
      runs: 1,
      steps: 1,
      toolCalls: 1,
      checkpoints: 1,
      messages: 1
    });
  });
});
