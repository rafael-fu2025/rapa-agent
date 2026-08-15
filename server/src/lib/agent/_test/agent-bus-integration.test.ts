/**
 * Integration test: Agent.stream() emits events on the bus.
 *
 * See `.agents/notes/implemented/architecture/2026-08-15-in-process-event-bus.md`.
 */

import { describe, expect, it } from "vitest";

import { Agent } from "../../agent.js";
import type { AgentConfig, AgentMessage, ToolExecutionContext } from "../types.js";

function singleResponseStub(content: string) {
  return {
    async *streamChat(): AsyncGenerator<{ type: string; reasoningDelta?: string; contentDelta?: string; message: AgentMessage }, AgentMessage, unknown> {
      yield { type: "chunk", contentDelta: content, message: { role: "assistant", content } };
      const message: AgentMessage = { role: "assistant", content };
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
    conversationId: "bus-test",
    mode: "chat",
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

describe("Agent — bus integration", () => {
  it("emits turn/start, step/start, turn/end, session/end on the bus", async () => {
    const stub = singleResponseStub("done");
    const agent = new Agent(buildContext(), buildConfig(), stub as never);

    const turnStarts: Array<{ mode: string; iterationBudget: number }> = [];
    const stepStarts: number[] = [];
    const turnEnds: Array<{ status: string; iterations: number }> = [];
    const sessionEnds: Array<{ status: string }> = [];

    agent.events.on("agent/turn/start", (p) => { turnStarts.push({ mode: p.mode, iterationBudget: p.iterationBudget }); });
    agent.events.on("agent/step/start", (p) => { stepStarts.push(p.iteration); });
    agent.events.on("agent/turn/end", (p) => { turnEnds.push({ status: p.status, iterations: p.iterations }); });
    agent.events.on("session/session/end", (p) => { sessionEnds.push({ status: p.status }); });

    // Use run() so session/* events fire
    await agent.run("hi");

    expect(turnStarts).toHaveLength(1);
    expect(turnStarts[0]!.mode).toBe("chat");
    expect(stepStarts.length).toBeGreaterThanOrEqual(1);
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]!.status).toBe("completed");
    expect(sessionEnds).toHaveLength(1);
    expect(sessionEnds[0]!.status).toBe("completed");
  });

  it("serial listeners see events in stream() order", async () => {
    const stub = singleResponseStub("done");
    const agent = new Agent(buildContext(), buildConfig(), stub as never);

    const sequence: string[] = [];
    agent.events.on("agent/turn/start", () => { sequence.push("turn/start"); });
    agent.events.on("agent/step/start", () => { sequence.push("step/start"); });
    agent.events.on("agent/turn/end", () => { sequence.push("turn/end"); });

    // stream() emits turn/start + step/start + turn/end (no session/* — run() handles those)
    for await (const _ev of agent.stream("hi")) { /* consume */ }

    // turn/start → step/start → turn/end (the loop ran at least once)
    expect(sequence[0]).toBe("turn/start");
    expect(sequence).toContain("step/start");
    expect(sequence[sequence.length - 1]).toBe("turn/end");
  });
});