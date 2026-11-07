import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireLiveRunConsumer,
  finalizeLiveRun,
  foldLiveStep,
  getLiveRunState,
  hasLiveRun,
  hasLiveRunConsumer,
  LIVE_MESSAGE_ID_PREFIX,
  pushLiveToolCall,
  reattachLiveRun,
  resetAllLiveRuns,
  resetLiveRun,
  setLiveActiveRun,
  setLiveEventSeq,
  setLivePending,
  setLiveQueuedPrompt,
  setLiveReasoning,
  setLiveReconnecting,
  setLiveStreamingText,
  subscribeLiveRun,
} from "../live-run-store";

// Module-level spies wired through the vi.mock factory — the store imports
// these from agent-api.
const listAgentRunsMock = vi.hoisted(() => vi.fn());
const getAgentRunMock = vi.hoisted(() => vi.fn());
const getAgentRunStreamMock = vi.hoisted(() => vi.fn());

vi.mock("../agent-api", () => ({
  listAgentRuns: (...args: unknown[]) => listAgentRunsMock(...args),
  getAgentRun: (...args: unknown[]) => getAgentRunMock(...args),
  getAgentRunStream: (...args: unknown[]) => getAgentRunStreamMock(...args),
}));

beforeEach(() => {
  resetAllLiveRuns();
  listAgentRunsMock.mockReset();
  getAgentRunMock.mockReset();
  getAgentRunStreamMock.mockReset();
});

describe("live-run-store state semantics", () => {
  it("returns a referentially stable empty snapshot per conversation", () => {
    const first = getLiveRunState("c-stable");
    const second = getLiveRunState("c-stable");
    expect(first).toBe(second);
    expect(first.pending).toBe(false);
    expect(first.liveToolCalls).toEqual([]);
  });

  it("replaces the state object immutably on mutation", () => {
    const before = getLiveRunState("c-immutable");
    setLivePending("c-immutable", true);
    const after = getLiveRunState("c-immutable");
    expect(after).not.toBe(before);
    expect(after.pending).toBe(true);
    // The previous snapshot is untouched.
    expect(before.pending).toBe(false);
  });

  it("notifies subscribers only on actual changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLiveRun("c-listen", listener);
    setLivePending("c-listen", false); // already false — no emission
    setLiveReconnecting("c-listen", null); // already null — no emission
    expect(listener).not.toHaveBeenCalled();

    setLivePending("c-listen", true);
    expect(listener).toHaveBeenCalledTimes(1);

    setLiveStreamingText("c-listen", "hello", "append");
    expect(listener).toHaveBeenCalledTimes(2);
    setLiveStreamingText("c-listen", "", "append"); // empty append — no change
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setLivePending("c-listen", false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("upserts live tool calls by call id", () => {
    pushLiveToolCall("c-tools", {
      iteration: 1,
      status: "running",
      call: { id: "t1", name: "read_file", parameters: {} },
    });
    pushLiveToolCall("c-tools", {
      iteration: 1,
      status: "completed",
      call: { id: "t1", name: "read_file", parameters: {} },
    });
    const state = getLiveRunState("c-tools");
    expect(state.liveToolCalls).toHaveLength(1);
    expect(state.liveToolCalls[0].status).toBe("completed");
  });

  it("foldLiveStep replaces the same iteration and clears live state", () => {
    setLiveReasoning("c-fold", "thinking");
    pushLiveToolCall("c-fold", {
      iteration: 1,
      status: "running",
      call: { id: "t1", name: "read_file", parameters: {} },
    });
    const step = { iteration: 1, toolCalls: [], toolResults: [], timestamp: "t1" };
    foldLiveStep("c-fold", step);
    let state = getLiveRunState("c-fold");
    expect(state.agentSteps).toEqual([step]);
    expect(state.liveToolCalls).toEqual([]);
    expect(state.liveReasoning).toBeNull();

    // A late duplicate for the same iteration replaces, not appends.
    const revised = { ...step, reasoning: "refined" };
    foldLiveStep("c-fold", revised);
    state = getLiveRunState("c-fold");
    expect(state.agentSteps).toEqual([revised]);
  });

  it("finalizeLiveRun clears transient fields, keeps lastEventSeq, and stores the final text", () => {
    setLivePending("c-final", true);
    setLiveActiveRun("c-final", "run-1", { source: "attached", mode: "agent" });
    setLiveEventSeq("c-final", 42);
    setLiveReconnecting("c-final", "Reconnecting...");
    pushLiveToolCall("c-final", {
      iteration: 1,
      status: "running",
      call: { id: "t1", name: "read_file", parameters: {} },
    });

    finalizeLiveRun("c-final", "final response");
    const state = getLiveRunState("c-final");
    expect(state.pending).toBe(false);
    expect(state.reconnecting).toBeNull();
    expect(state.liveToolCalls).toEqual([]);
    expect(state.liveReasoning).toBeNull();
    expect(state.lastEventSeq).toBe(42);
    expect(state.streamingText).toBe("final response");
    expect(state.activeRunId).toBe("run-1");
    expect(hasLiveRun("c-final")).toBe(false);
  });

  it("finalizeLiveRun without a final keeps the streamed partial (chat abort)", () => {
    setLivePending("c-partial", true);
    setLiveActiveRun("c-partial", null, { source: "chat", mode: "chat" });
    setLiveStreamingText("c-partial", "aborted partial", "replace");
    finalizeLiveRun("c-partial");
    const state = getLiveRunState("c-partial");
    expect(state.pending).toBe(false);
    expect(state.streamingText).toBe("aborted partial");
  });

  it("hasLiveRun tracks pending only and resetLiveRun clears everything", () => {
    expect(hasLiveRun("c-reset")).toBe(false);
    setLivePending("c-reset", true);
    setLiveQueuedPrompt("c-reset", "queued");
    expect(hasLiveRun("c-reset")).toBe(true);

    const listener = vi.fn();
    const unsubscribe = subscribeLiveRun("c-reset", listener);
    resetLiveRun("c-reset");
    expect(listener).toHaveBeenCalledTimes(1);
    const state = getLiveRunState("c-reset");
    expect(state.pending).toBe(false);
    expect(state.queuedPrompt).toBeNull();
    expect(state.activeRunId).toBeNull();
    expect(state.streamingText).toBeNull();
    expect(state.lastEventSeq).toBeNull();
    unsubscribe();
  });

  it("resetLiveRun is a no-op (no emission) when there is nothing to reset", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLiveRun("c-empty", listener);
    resetLiveRun("c-empty");
    resetLiveRun("c-empty");
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("acquire/release tracks mounted consumers, double-release is a no-op", () => {
    expect(hasLiveRunConsumer("c-consumer")).toBe(false);
    const release1 = acquireLiveRunConsumer("c-consumer");
    expect(hasLiveRunConsumer("c-consumer")).toBe(true);
    const release2 = acquireLiveRunConsumer("c-consumer");
    release1();
    expect(hasLiveRunConsumer("c-consumer")).toBe(true);
    release2();
    expect(hasLiveRunConsumer("c-consumer")).toBe(false);
    release1(); // double release must not resurrect the count
    expect(hasLiveRunConsumer("c-consumer")).toBe(false);
  });

  it("exposes the synthesized-message id prefix", () => {
    expect(LIVE_MESSAGE_ID_PREFIX).toBe("live-run-");
  });
});

describe("reattachLiveRun (cold-entry seeding + stream replay)", () => {
  it("seeds the store from the persisted run and replays the stream through the mutators", async () => {
    listAgentRunsMock.mockResolvedValue({ runs: [{ id: "run-1", status: "running" }] });
    getAgentRunMock.mockResolvedValue({
      run: {
        id: "run-1",
        steps: [
          {
            iteration: 1,
            reasoning: "step one reasoning",
            toolCalls: [{ id: "call-1", name: "read_file", parameters: {} }],
            toolResults: [{ success: true, output: "contents" }],
            timestamp: "t1",
          },
        ],
        toolCalls: [
          {
            id: "row-1",
            externalCallId: "call-1",
            name: "read_file",
            status: "completed",
            parameters: {},
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "row-2",
            externalCallId: "call-2",
            name: "write_file",
            status: "running",
            parameters: { path: "a.ts" },
            createdAt: "2026-01-01T00:00:01Z",
          },
        ],
      },
    });
    getAgentRunStreamMock.mockImplementation(async (_runId: string, opts: { onEvent: (event: unknown) => void }) => {
      // Seeding happened before the stream opened: history folded, only the
      // step-uncovered in-flight call is a live card.
      const seeded = getLiveRunState("conv-1");
      expect(seeded.pending).toBe(true);
      expect(seeded.activeRunId).toBe("run-1");
      expect(seeded.source).toBe("reattached");
      expect(seeded.mode).toBe("agent");
      expect(seeded.agentSteps).toHaveLength(1);
      expect(seeded.liveToolCalls.map((c) => c.call.id)).toEqual(["call-2"]);

      opts.onEvent({ type: "tool_call", iteration: 2, status: "completed", call: { id: "call-2", name: "write_file", parameters: {} } });
      opts.onEvent({ type: "assistant", iteration: 2, content: "partial", final: false });
      const done = { type: "done", status: "completed", response: "final answer", steps: [], iterations: 2 };
      opts.onEvent(done);
      return { finalEvent: done };
    });

    await reattachLiveRun("conv-1", { mode: "agent" });

    expect(listAgentRunsMock).toHaveBeenCalledWith({ conversationId: "conv-1", limit: 1 });
    expect(getAgentRunMock).toHaveBeenCalledWith("run-1");
    expect(getAgentRunStreamMock).toHaveBeenCalledWith("run-1", expect.objectContaining({ since: 0 }));

    const state = getLiveRunState("conv-1");
    // done finalized exactly like a native done
    expect(state.pending).toBe(false);
    expect(state.streamingText).toBe("final answer");
    expect(state.liveToolCalls).toEqual([]);
    expect(state.activeRunId).toBe("run-1");
    expect(state.source).toBe("reattached");
  });

  it("skips silently when the store already tracks a live run (warm return)", async () => {
    setLivePending("conv-warm", true);
    await reattachLiveRun("conv-warm");
    expect(listAgentRunsMock).not.toHaveBeenCalled();
  });

  it("skips when the latest run is not in an active status", async () => {
    listAgentRunsMock.mockResolvedValue({ runs: [{ id: "run-9", status: "completed" }] });
    await reattachLiveRun("conv-cold-done");
    expect(getAgentRunMock).not.toHaveBeenCalled();
    expect(hasLiveRun("conv-cold-done")).toBe(false);
  });

  it("skips silently when listing runs fails", async () => {
    listAgentRunsMock.mockRejectedValue(new Error("network down"));
    await expect(reattachLiveRun("conv-err")).resolves.toBeUndefined();
    expect(hasLiveRun("conv-err")).toBe(false);
  });

  it("skips silently when the run detail fetch fails", async () => {
    listAgentRunsMock.mockResolvedValue({ runs: [{ id: "run-404", status: "running" }] });
    getAgentRunMock.mockRejectedValue(new Error("not found"));
    await reattachLiveRun("conv-404");
    expect(getAgentRunStreamMock).not.toHaveBeenCalled();
    expect(hasLiveRun("conv-404")).toBe(false);
  });

  it("settles the store when the stream closes without a done event", async () => {
    listAgentRunsMock.mockResolvedValue({ runs: [{ id: "run-x", status: "running" }] });
    getAgentRunMock.mockResolvedValue({ run: { id: "run-x", steps: [], toolCalls: [] } });
    getAgentRunStreamMock.mockResolvedValue({});
    await reattachLiveRun("conv-close");
    expect(hasLiveRun("conv-close")).toBe(false);
  });

  it("does not double-stream the same run when called concurrently", async () => {
    const resolvers: Array<(value: { runs: unknown[] }) => void> = [];
    listAgentRunsMock.mockImplementation(
      () =>
        new Promise<{ runs: unknown[] }>((resolve) => {
          resolvers.push(resolve);
        })
    );
    getAgentRunMock.mockResolvedValue({ run: { id: "run-dup", steps: [], toolCalls: [] } });
    getAgentRunStreamMock.mockResolvedValue({});

    const first = reattachLiveRun("conv-dup");
    const second = reattachLiveRun("conv-dup");
    for (const resolve of resolvers) resolve({ runs: [{ id: "run-dup", status: "running" }] });
    await Promise.all([first, second]);

    expect(getAgentRunStreamMock).toHaveBeenCalledTimes(1);
  });
});
