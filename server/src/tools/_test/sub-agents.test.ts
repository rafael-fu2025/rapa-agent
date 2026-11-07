// SpawnAgentTool background mode (Item 4) + registry behaviours.
//
// runChildAgent is mocked at the module boundary: the tool must return
// IMMEDIATELY in background mode (fire-and-forget) and block for the
// report in the default synchronous mode.

import { describe, expect, it, vi, afterEach } from "vitest";
import { SpawnAgentTool, GetAgentStatusTool, childAgentRegistry } from "../sub-agents.js";
import type { ToolExecutionContext } from "../../lib/tools.js";

const runChildAgentMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/sub-agent-runner.js", () => ({
  runChildAgent: runChildAgentMock
}));

function makeContext(conversationId: string): ToolExecutionContext {
  return {
    workspaceRoot: "C:/fixture/workspace",
    userId: "user-1",
    conversationId,
    mode: "agent",
    agentDepth: 0
  };
}

const VALID_TASK = "Investigate the workspace layout and report the module structure.";

/**
 * The background path starts the runner fire-and-forget behind a dynamic
 * import, so its first (mocked) call lands a few microtasks AFTER the tool
 * returns. Poll until it does so assertions are deterministic and no call
 * leaks across tests.
 */
async function waitForRunnerStart(maxMs = 2000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (runChildAgentMock.mock.calls.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  runChildAgentMock.mockReset();
  // Clear any handles this test created so registry listings stay isolated.
  for (const [id, handle] of childAgentRegistry["agents"]) {
    if (handle.parentConversationId.startsWith("test-")) {
      childAgentRegistry["agents"].delete(id);
    }
  }
});

describe("SpawnAgentTool — background mode", () => {
  it("returns immediately with a poll handle while the child keeps running", async () => {
    // Deferred outcome: the runner must NOT be awaited by the tool.
    let resolveRun: (value: { status: string; report: string; toolCallCount: number; iterationCount: number }) => void = () => undefined;
    runChildAgentMock.mockImplementationOnce(() => new Promise((resolve) => { resolveRun = resolve; }));

    const tool = new SpawnAgentTool();
    const result = await tool.execute(
      { task: VALID_TASK, background: true },
      makeContext("test-bg-1")
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("background");
    expect(result.data).toMatchObject({
      status: "running",
      pollWith: "get_agent_status",
      agentType: "general",
      breadth: "medium",
      task: VALID_TASK
    });
    expect(typeof (result.data as Record<string, unknown>).agentId).toBe("string");

    // Fire-and-forget: the runner was started with the registered handle.
    await waitForRunnerStart();
    expect(runChildAgentMock).toHaveBeenCalledTimes(1);
    const [contextArg, configArg, handleArg] = runChildAgentMock.mock.calls[0];
    expect((handleArg as { id: string }).id).toBe((result.data as { agentId: string }).agentId);
    expect(contextArg).toMatchObject({ conversationId: "test-bg-1" });
    expect(configArg).toBeUndefined();

    // The tool result existed BEFORE the child finished — resolve now and
    // let the detached promise settle without unhandled-rejection noise.
    resolveRun({ status: "completed", report: "done", toolCallCount: 1, iterationCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("propagates agentType and breadth into the immediate result", async () => {
    runChildAgentMock.mockImplementationOnce(() => new Promise(() => undefined)); // never resolves — must not matter
    const tool = new SpawnAgentTool();
    const result = await tool.execute(
      { task: VALID_TASK, agentType: "explore", breadth: "very_thorough", background: true },
      makeContext("test-bg-2")
    );
    expect(result.data).toMatchObject({ agentType: "explore", breadth: "very_thorough", status: "running" });
    await waitForRunnerStart();
  });
});

describe("SpawnAgentTool — synchronous mode (unchanged)", () => {
  it("blocks for the runner outcome and returns the report", async () => {
    runChildAgentMock.mockResolvedValueOnce({
      status: "completed",
      report: "THE REPORT",
      toolCallCount: 3,
      iterationCount: 2
    });

    const tool = new SpawnAgentTool();
    const result = await tool.execute({ task: VALID_TASK }, makeContext("test-sync-1"));

    expect(runChildAgentMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.output).toBe("THE REPORT");
    expect(result.data).toMatchObject({
      report: "THE REPORT",
      iterationsRun: 2,
      toolCallsRun: 3
    });
  });

  it("marks a failed child as unsuccessful", async () => {
    runChildAgentMock.mockResolvedValueOnce({
      status: "failed",
      report: "Child agent failed: no keys",
      toolCallCount: 0,
      iterationCount: 0
    });
    const tool = new SpawnAgentTool();
    const result = await tool.execute({ task: VALID_TASK }, makeContext("test-sync-2"));
    expect(result.success).toBe(false);
    expect(result.error).toContain("failed");
  });

  it("still validates the task before spawning in either mode", async () => {
    const tool = new SpawnAgentTool();
    const short = await tool.execute({ task: "too short", background: true }, makeContext("test-val-1"));
    expect(short.success).toBe(false);
    expect(short.error).toContain("too short");

    const empty = await tool.execute({ background: true }, makeContext("test-val-2"));
    expect(empty.success).toBe(false);
  });
});

describe("GetAgentStatusTool — background result retrieval", () => {
  it("finds a background child by agentId within the same conversation", async () => {
    runChildAgentMock.mockImplementationOnce(() => new Promise(() => undefined));
    const spawn = new SpawnAgentTool();
    const spawned = await spawn.execute({ task: VALID_TASK, background: true }, makeContext("test-status-1"));
    const agentId = (spawned.data as { agentId: string }).agentId;
    await waitForRunnerStart();

    const status = new GetAgentStatusTool();
    const result = await status.execute({ agentId }, makeContext("test-status-1"));
    expect(result.success).toBe(true);
    expect((result.data as { id: string }).id).toBe(agentId);
    expect((result.data as { status: string }).status).toBe("pending"); // runner mock never started it
  });

  it("refuses to inspect another conversation's child agents", async () => {
    runChildAgentMock.mockImplementationOnce(() => new Promise(() => undefined));
    const spawn = new SpawnAgentTool();
    const spawned = await spawn.execute({ task: VALID_TASK, background: true }, makeContext("test-status-2"));
    const agentId = (spawned.data as { agentId: string }).agentId;
    await waitForRunnerStart();

    const status = new GetAgentStatusTool();
    const result = await status.execute({ agentId }, makeContext("test-status-other"));
    expect(result.success).toBe(false);
  });
});
