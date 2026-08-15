/**
 * Phase 1.4: turn / step lifecycle emission tests.
 *
 * See `.agents/notes/implemented/architecture/2026-08-15-turn-step-lifecycle.md`.
 *
 * These tests verify the *presence and ordering* of the new
 * `turn/start`, `turn/end`, `step/start` events. They mock the LLM
 * client at the constructor boundary (existing test seam) and assert
 * on the captured event stream.
 */

import { describe, expect, it } from "vitest";

import { Agent } from "../../agent.js";
import type { AgentExecutionEvent, AgentConfig, AgentMessage, ToolExecutionContext } from "../types.js";

/** Minimal LLMClient-shaped stub that yields a single final response. */
function singleResponseStub(content: string) {
  return {
    async *streamChat(): AsyncGenerator<{ type: string; delta?: string; calls?: unknown[]; message: AgentMessage }, AgentMessage, unknown> {
      yield { type: "content", delta: content, message: { role: "assistant", content } };
      const message: AgentMessage = { role: "assistant", content };
      yield { type: "done", message };
      return message;
    },
    async callNonStreaming() {
      return { role: "assistant", content } as AgentMessage;
    },
    getApiKeySwitch() {
      return undefined;
    }
  };
}

function buildContext(): ToolExecutionContext {
  return {
    workspaceRoot: "",
    conversationId: "lifecycle-test",
    mode: "plan",
    autoApproveTools: new Set<string>()
  } as unknown as ToolExecutionContext;
}

function buildConfig(): AgentConfig {
  return {
    model: "test-model",
    provider: "test",
    maxIterations: 3,
    isNewConversation: true,
    seedHistory: [],
    apiKey: "test-key"
  } as unknown as AgentConfig;
}

async function collectEvents(agent: Agent, prompt: string): Promise<AgentExecutionEvent[]> {
  const out: AgentExecutionEvent[] = [];
  for await (const ev of agent.stream(prompt)) {
    out.push(ev);
  }
  return out;
}

describe("Agent lifecycle — turn/step events", () => {
  it("emits turn/start once at the top of the stream", async () => {
    const stub = singleResponseStub("done");
    const agent = new Agent(buildContext(), buildConfig(), stub as never);
    const events = await collectEvents(agent, "hi");

    const turnStarts = events.filter((e) => e.type === "turn/start");
    expect(turnStarts).toHaveLength(1);
    const first = turnStarts[0]!;
    expect(first.type).toBe("turn/start");
    if (first.type === "turn/start") {
      expect(first.conversationId).toBe("lifecycle-test");
      expect(first.mode).toBe("plan");
      expect(first.iterationBudget).toBe(3);
    }
  });

  it("emits turn/start before the existing start event", async () => {
    const stub = singleResponseStub("done");
    const agent = new Agent(buildContext(), buildConfig(), stub as never);
    const events = await collectEvents(agent, "hi");

    const turnStartIdx = events.findIndex((e) => e.type === "turn/start");
    const startIdx = events.findIndex((e) => e.type === "start");
    expect(turnStartIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(turnStartIdx);
  });

  it("emits step/start at the top of each iteration", async () => {
    const stub = singleResponseStub("done");
    const agent = new Agent(buildContext(), buildConfig(), stub as never);
    const events = await collectEvents(agent, "hi");

    const stepStarts = events.filter((e) => e.type === "step/start");
    expect(stepStarts.length).toBeGreaterThanOrEqual(1);
    // Each step/start should have an iteration >= 1, increasing
    const iterations = stepStarts
      .map((e) => (e.type === "step/start" ? e.iteration : 0));
    for (let i = 1; i < iterations.length; i += 1) {
      expect(iterations[i]).toBeGreaterThanOrEqual(iterations[i - 1]!);
    }
  });

  it("emits turn/end before done", async () => {
    const stub = singleResponseStub("done");
    const agent = new Agent(buildContext(), buildConfig(), stub as never);
    const events = await collectEvents(agent, "hi");

    const turnEndIdx = events.findIndex((e) => e.type === "turn/end");
    const doneIdx = events.findIndex((e) => e.type === "done");
    expect(turnEndIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(turnEndIdx);
  });

  it("emits exactly one turn/end per turn", async () => {
    const stub = singleResponseStub("done");
    const agent = new Agent(buildContext(), buildConfig(), stub as never);
    const events = await collectEvents(agent, "hi");
    const turnEnds = events.filter((e) => e.type === "turn/end");
    expect(turnEnds).toHaveLength(1);
  });
});