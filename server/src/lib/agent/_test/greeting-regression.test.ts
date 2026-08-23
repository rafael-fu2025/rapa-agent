// Regression tests for the "double reasoning round on a trivial prompt" bug
// (seen live 2026-08-22): a greeting produced a reasoning-only reply, the
// reconstructed-from-reasoning answer matched the intent-without-action
// detector ("I should just acknowledge…"), and the harness injected a bogus
// "you wrote X but made no tool call" nudge — forcing a second, confused
// reasoning round. Also covers the stale-task guard firing on greetings.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../../agent.js";
import { registerAllTools } from "../../../tools/index.js";
import { clearTaskStore } from "../../../tools/task-store.js";
import type { AgentConfig, AgentExecutionEvent, AgentMessage, ProviderChatMessage } from "../types.js";
import type { LLMClient } from "../llm-client.js";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "rapa-greeting-"));
  registerAllTools();
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
  clearTaskStore("conv-greeting");
  clearTaskStore("conv-complex");
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
  maxIterations: 5,
  autoApproveTools: [],
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

describe("trivial-prompt handling (greeting regression)", () => {
  it("completes in ONE round when a reasoning-only reply mentions 'I should just acknowledge'", async () => {
    // Exactly the live failure shape: no visible content, private
    // deliberation containing "I should…" phrasing.
    const llm = makeFakeLlm([
      {
        role: "assistant",
        content: "",
        reasoning: "The user has just said 'hi'. There's a system reminder about task plans, but this is just a greeting — I should just acknowledge the greeting and ask how I can help."
      } as AgentMessage,
      { role: "assistant", content: "SHOULD NOT BE REACHED — the run must finish after round 1." }
    ]);

    const { done } = await runAgent(llm, "hi", "conv-greeting");

    // One LLM round only — no intent nudge, no second reasoning pass.
    expect(llm.calls.length).toBe(1);
    expect(done?.status).toBe("completed");
    // The reconstructed answer is the (cleaned) deliberation, and it must
    // NOT be the bogus second-round meta-response.
    expect(done?.response).not.toMatch(/SHOULD NOT BE REACHED/);
  });

  it("does not inject the 'call plan_tasks NOW' guard for a trivial prompt", async () => {
    const llm = makeFakeLlm([{ role: "assistant", content: "Hi! How can I help?" }]);
    await runAgent(llm, "hi", "conv-greeting");

    const allContent = llm.calls[0]?.messages.map((m) => String(m.content)).join("\n") ?? "";
    expect(allContent).not.toMatch(/call plan_tasks NOW/);
  });

  it("still injects the stale-task guard for a complex prompt", async () => {
    const llm = makeFakeLlm([{ role: "assistant", content: "Done." }]);
    await runAgent(
      llm,
      "Refactor the authentication module: extract the JWT logic into its own file, add unit tests for token expiry, update all imports, and run the test suite to verify nothing broke.",
      "conv-complex"
    );

    const allContent = llm.calls[0]?.messages.map((m) => String(m.content)).join("\n") ?? "";
    expect(allContent).toMatch(/call plan_tasks NOW/);
  });

  it("still nudges a PUBLIC commitment like 'Let me read the file' with no tool call", async () => {
    const llm = makeFakeLlm([
      { role: "assistant", content: "Let me read the config file to check the settings." },
      { role: "assistant", content: "OK, I changed my mind — here is the answer directly." }
    ]);
    const { done } = await runAgent(llm, "check the config settings please", "conv-greeting");

    // The nudge fired → second round happened.
    expect(llm.calls.length).toBe(2);
    expect(done?.status).toBe("completed");
    const nudge = llm.calls[1]?.messages.find(
      (m) => m.role === "user" && /without making the actual tool call|made no tool call|didn't emit/i.test(String(m.content))
    );
    expect(nudge).toBeDefined();
  });
});
