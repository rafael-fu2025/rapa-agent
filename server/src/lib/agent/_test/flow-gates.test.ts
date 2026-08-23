// Agent-level tests for the Round-2 flow gates:
//   1. ask_user gates the turn — bundled tool calls are deferred, not run
//   2. incomplete-plan bounce — a done-declaration with open tasks bounces once
//   3. buildAgentIdentityMessage — the revived live system message

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../../agent.js";
import { registerAllTools } from "../../../tools/index.js";
import { getTaskStore, clearTaskStore } from "../../../tools/task-store.js";
import { buildAgentIdentityMessage } from "../prompt-builder.js";
import type { AgentConfig, AgentExecutionEvent, AgentMessage, ProviderChatMessage } from "../types.js";
import type { LLMClient } from "../llm-client.js";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "rapa-flowgates-"));
  registerAllTools();
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function makeFakeLlm(script: AgentMessage[]): LLMClient & {
  calls: Array<{ messages: ProviderChatMessage[] }>;
} {
  let callIndex = 0;
  const calls: Array<{ messages: ProviderChatMessage[] }> = [];
  const fake = {
    async *streamChat(messages: ProviderChatMessage[]): AsyncGenerator<unknown, AgentMessage, unknown> {
      calls.push({ messages: messages.map((m) => ({ ...m })) });
      const message = script[callIndex] ?? script[script.length - 1];
      callIndex += 1;
      if (typeof message.content === "string" && message.content.length > 0) {
        yield { type: "chunk", contentDelta: message.content };
      }
      return message;
    },
    getApiKeySwitch() {
      return undefined;
    },
    getCurrentKeyInfo() {
      return {};
    },
    calls
  };
  return fake as unknown as LLMClient & { calls: typeof calls };
}

const buildConfig = (): AgentConfig => ({
  maxIterations: 6,
  autoApproveTools: ["write_file"],
  provider: "test",
  model: "test-model",
  baseUrl: "http://localhost",
  apiKey: "k"
});

async function runAgent(
  llm: LLMClient,
  prompt: string,
  conversationId: string
): Promise<{ events: AgentExecutionEvent[]; done?: Extract<AgentExecutionEvent, { type: "done" }> }> {
  const agent = new Agent(
    { workspaceRoot, userId: "u", conversationId, mode: "agent" },
    buildConfig(),
    llm
  );
  const events: AgentExecutionEvent[] = [];
  for await (const event of agent.stream(prompt)) {
    events.push(event);
  }
  return {
    events,
    done: events.find((e) => e.type === "done") as Extract<AgentExecutionEvent, { type: "done" }> | undefined
  };
}

const askUserCall = {
  id: "q1",
  name: "ask_user",
  parameters: {
    questions: [{
      question: "Which database should the app use?",
      header: "Database",
      options: [
        { label: "SQLite", description: "Embedded, zero-config" },
        { label: "PostgreSQL", description: "Hosted, multi-user" }
      ],
      multiSelect: false
    }]
  }
};

describe("ask_user gates the turn", () => {
  it("defers bundled tool calls instead of executing them before the answer", async () => {
    await writeFile(join(workspaceRoot, "existing.txt"), "do not touch", "utf-8");

    const llm = makeFakeLlm([
      {
        role: "assistant",
        content: "Before I continue, one question:",
        toolCalls: [
          askUserCall,
          { id: "w1", name: "write_file", parameters: { path: "created-before-answer.txt", content: "premature" } }
        ]
      } as AgentMessage
    ]);

    const { events, done } = await runAgent(llm, "Set up the database for the app", "conv-askuser-gate");

    // The premature write never hit the disk.
    const { readFile } = await import("node:fs/promises");
    await expect(readFile(join(workspaceRoot, "created-before-answer.txt"))).rejects.toThrow();
    expect(await readFile(join(workspaceRoot, "existing.txt"), "utf-8")).toBe("do not touch");

    // The bundled write got a deferred result; the ask_user one executed.
    // (Each call emits a pending pre-event without a result — take the last.)
    const writeEvents = events.filter((e) => e.type === "tool_call" && e.call.name === "write_file");
    const writeEvent = writeEvents[writeEvents.length - 1] as
      | Extract<AgentExecutionEvent, { type: "tool_call" }> | undefined;
    expect((writeEvent?.result?.data as { deferred?: boolean } | undefined)?.deferred).toBe(true);

    const askEvents = events.filter((e) => e.type === "tool_call" && e.call.name === "ask_user");
    const askEvent = askEvents[askEvents.length - 1] as
      | Extract<AgentExecutionEvent, { type: "tool_call" }> | undefined;
    expect((askEvent?.result?.data as { deferred?: boolean } | undefined)?.deferred).toBeUndefined();

    // The run ended interactively with the question.
    expect(done?.interactive?.type).toBe("ask_user");
  });
});

describe("incomplete-plan bounce", () => {
  it("bounces a done-declaration once when tasks remain open", async () => {
    // Seed an open task plan directly in the merged store (no DB needed).
    const store = getTaskStore("conv-plan-bounce");
    store.set("task-1", { id: "task-1", content: "Implement the feature", status: "completed", updatedAt: new Date().toISOString() });
    store.set("task-2", { id: "task-2", content: "Run the tests", status: "pending", updatedAt: new Date().toISOString() });

    try {
      const llm = makeFakeLlm([
        { role: "assistant", content: "The feature is complete. Done." },
        { role: "assistant", content: "All tasks finished and verified. Final report ready." }
      ]);
      const { events, done } = await runAgent(llm, "Implement the feature and run tests", "conv-plan-bounce");

      // Bounce fired: a step was recorded and the second LLM call carries the bounce message.
      const bounceStep = events.find((e) => e.type === "step" && /Plan incomplete/i.test(e.step.reasoning ?? ""));
      expect(bounceStep).toBeDefined();
      const bounceMessage = llm.calls[1]?.messages.find(
        (m) => m.role === "user" && /task plan still has/i.test(String(m.content))
      );
      expect(bounceMessage).toBeDefined();

      // The run still completes (second attempt proceeds) with the plan state.
      expect(done?.status).toBe("completed");
      expect(done?.taskPlan).toEqual({ completed: 1, total: 2 });
    } finally {
      clearTaskStore("conv-plan-bounce");
    }
  });

  it("completes without a bounce when the plan is fully closed", async () => {
    const store = getTaskStore("conv-plan-done");
    store.set("task-1", { id: "task-1", content: "Only task", status: "completed", updatedAt: new Date().toISOString() });

    try {
      const llm = makeFakeLlm([{ role: "assistant", content: "Done." }]);
      const { done } = await runAgent(llm, "Do the thing", "conv-plan-done");
      expect(llm.calls.length).toBe(1);
      expect(done?.status).toBe("completed");
      expect(done?.taskPlan).toEqual({ completed: 1, total: 1 });
    } finally {
      clearTaskStore("conv-plan-done");
    }
  });
});

describe("buildAgentIdentityMessage (live system message)", () => {
  it("agent mode carries the working discipline and key rules", () => {
    const message = buildAgentIdentityMessage("agent");
    expect(message).toContain("AGENT MODE");
    expect(message).toContain("HOW TO WORK");
    expect(message).toContain("KEY RULES");
    expect(message).toContain("edit_file");
    // The old dead prompt referenced a nonexistent parameter — fixed.
    expect(message).not.toContain("timeoutMs");
    expect(message).toContain("`timeout`");
  });

  it("plan mode carries the plan workflow and read-only constraints", () => {
    const message = buildAgentIdentityMessage("plan");
    expect(message).toContain("PLAN MODE");
    expect(message).toContain("Step-by-Step Execution Plan");
    expect(message).toContain("never call write_file");
  });
});
