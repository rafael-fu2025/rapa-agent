/**
 * Plan-mode integration: Agent emits plan/enter, plan/exit on the bus
 * when mode === "plan".
 *
 * See `.agents/notes/implemented/architecture/2026-08-15-plan-mode-as-logged-state.md`.
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
    getApiKeySwitch() { return undefined; }
  };
}

function buildAgent(mode: "chat" | "plan"): Agent {
  const ctx = {
    workspaceRoot: "",
    conversationId: "plan-test",
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
  return new Agent(ctx, cfg, singleResponseStub("done") as never);
}

describe("Agent — plan-mode integration", () => {
  it("emits plan/enter + plan/exit on the bus when mode is plan", async () => {
    const agent = buildAgent("plan");
    const events: string[] = [];
    agent.events.on("plan/enter", () => events.push("plan/enter"));
    agent.events.on("plan/exit", () => events.push("plan/exit"));
    agent.events.on("agent/turn/start", () => events.push("turn/start"));
    agent.events.on("agent/turn/end", () => events.push("turn/end"));

    await agent.run("plan this");

    // Order: turn/start → plan/enter → ... → turn/end → plan/exit → done
    expect(events).toContain("plan/enter");
    expect(events).toContain("plan/exit");
    expect(events.indexOf("plan/enter")).toBeGreaterThan(events.indexOf("turn/start"));
    expect(events.indexOf("plan/exit")).toBeGreaterThan(events.indexOf("turn/end"));
  });

  it("does not emit plan/enter when mode is chat", async () => {
    const agent = buildAgent("chat");
    const events: string[] = [];
    agent.events.on("plan/enter", () => events.push("plan/enter"));
    agent.events.on("plan/exit", () => events.push("plan/exit"));

    await agent.run("just chat");

    expect(events).not.toContain("plan/enter");
    expect(events).not.toContain("plan/exit");
  });

  it("transitions plan.phase through entering → active → exiting → inactive", async () => {
    const agent = buildAgent("plan");
    const phases: string[] = [];
    // Patch the state object to observe transitions
    const originalActivate = agent.plan.activate.bind(agent.plan);
    const originalEnter = agent.plan.enter.bind(agent.plan);
    const originalExit = agent.plan.exit.bind(agent.plan);
    const originalReset = agent.plan.reset.bind(agent.plan);
    agent.plan.enter = ((...args: Parameters<typeof originalEnter>) => { phases.push(`enter->${agent.plan.phase}`); return originalEnter(...args); }) as typeof originalEnter;
    agent.plan.activate = ((...args: Parameters<typeof originalActivate>) => { phases.push(`activate(${agent.plan.phase})`); return originalActivate(...args); }) as typeof originalActivate;
    agent.plan.exit = ((...args: Parameters<typeof originalExit>) => { phases.push(`exit(${agent.plan.phase})`); return originalExit(...args); }) as typeof originalExit;
    agent.plan.reset = ((...args: Parameters<typeof originalReset>) => { phases.push(`reset(${agent.plan.phase})`); return originalReset(...args); }) as typeof originalReset;

    await agent.run("plan this");

    // The exact sequence is: enter (inactive→entering), activate (entering→active), exit (active→exiting), reset (exiting→inactive)
    expect(phases).toContain("activate(entering)");
    expect(phases).toContain("exit(active)");
    expect(phases).toContain("reset(exiting)");
    expect(agent.plan.phase).toBe("inactive");
  });
});