/**
 * Tests for the lifecycle observer consumer.
 *
 * See `.agents/notes/implemented/architecture/2026-08-15-in-process-event-bus.md`.
 */

import { describe, expect, it } from "vitest";

import { Agent } from "../../agent.js";
import { LifecycleObserver } from "../lifecycle-observer.js";
import type { AgentConfig, AgentMessage, ToolExecutionContext } from "../types.js";

function singleResponseStub() {
  return {
    async *streamChat(): AsyncGenerator<{ type: string; reasoningDelta?: string; contentDelta?: string; message: AgentMessage }, AgentMessage, unknown> {
      yield { type: "chunk", contentDelta: "hi", message: { role: "assistant", content: "hi" } };
      return { role: "assistant", content: "hi" } as AgentMessage;
    },
    async callNonStreaming() {
      return { role: "assistant", content: "hi" } as AgentMessage;
    },
    getApiKeySwitch() { return undefined; }
  };
}

function buildAgent(mode: "chat" | "plan" = "chat"): Agent {
  const ctx = {
    workspaceRoot: "",
    conversationId: "obs-test",
    mode,
    autoApproveTools: new Set<string>()
  } as unknown as ToolExecutionContext;
  const cfg = {
    model: "test-model",
    provider: "test",
    maxIterations: 3,
    isNewConversation: true,
    seedHistory: [],
    apiKey: "test-key"
  } as unknown as AgentConfig;
  return new Agent(ctx, cfg, singleResponseStub() as never);
}

describe("LifecycleObserver", () => {
  it("records one turn per stream invocation", async () => {
    const agent = buildAgent();
    const observer = new LifecycleObserver();
    observer.attach(agent);

    await agent.run("hi");

    expect(observer.turns).toHaveLength(1);
    expect(observer.turns[0]!.conversationId).toBe("obs-test");
    expect(observer.turns[0]!.mode).toBe("chat");
    expect(observer.turns[0]!.status).toBe("completed");
    expect(typeof observer.turns[0]!.elapsedMs).toBe("number");
  });

  it("records one step per iteration", async () => {
    const agent = buildAgent();
    const observer = new LifecycleObserver();
    observer.attach(agent);

    await agent.run("hi");

    expect(observer.steps.length).toBeGreaterThanOrEqual(1);
    // Each step's iteration is >= 1 and increasing
    for (let i = 1; i < observer.steps.length; i += 1) {
      expect(observer.steps[i]!.iteration).toBeGreaterThanOrEqual(observer.steps[i - 1]!.iteration);
    }
  });

  it("detach() prevents further event capture", async () => {
    const agent = buildAgent();
    const observer = new LifecycleObserver();
    observer.attach(agent);
    observer.detach();

    await agent.run("hi");

    expect(observer.turns).toHaveLength(0);
    expect(observer.steps).toHaveLength(0);
  });

  it("summary() reports counts and last turn duration", async () => {
    const agent = buildAgent();
    const observer = new LifecycleObserver();
    observer.attach(agent);
    await agent.run("hi");

    const s = observer.summary();
    expect(s.turns).toBe(1);
    expect(s.steps).toBeGreaterThanOrEqual(1);
    expect(typeof s.lastTurnDurationMs).toBe("number");
  });
});