// Tests for the sub-agent runner: isolated child agents with fresh context,
// a read-only toolset, depth limits, and working-memory isolation. Uses the
// same fake-LLM seam as agent.test.ts (passed through runChildAgent's
// llmClient parameter — the Agent constructor's test seam).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runChildAgent, MAX_AGENT_DEPTH, CHILD_SAFE_TOOLS } from "../../sub-agent-runner.js";
import { childAgentRegistry, type ChildAgentHandle } from "../../../tools/sub-agents.js";
import { registerAllTools } from "../../../tools/index.js";
import type { AgentConfig, AgentMessage, ProviderChatMessage } from "../types.js";
import type { LLMClient } from "../llm-client.js";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "rapa-subagent-"));
  registerAllTools();
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function makeFakeLlm(
  script: AgentMessage[]
): LLMClient & { calls: Array<{ messages: ProviderChatMessage[]; openAITools: unknown[] }> } {
  let callIndex = 0;
  const calls: Array<{ messages: ProviderChatMessage[]; openAITools: unknown[] }> = [];
  const fake = {
    async *streamChat(messages: ProviderChatMessage[], _timeout: number, openAITools: unknown[]) {
      calls.push({
        messages: messages.map((m) => ({ ...m })),
        openAITools: Array.isArray(openAITools) ? [...openAITools] : []
      });
      const message = script[callIndex] ?? { role: "assistant", content: "done" };
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

const parentConfig: AgentConfig = {
  maxIterations: 10,
  autoApproveTools: [],
  provider: "test",
  model: "test-model",
  baseUrl: "http://localhost",
  apiKey: "k"
};

function makeHandle(task = "Investigate the workspace and report what files exist at the root."): ChildAgentHandle {
  return childAgentRegistry.create({
    parentConversationId: "conv-test",
    parentRunId: "run-test",
    task,
    maxIterations: 5
  });
}

describe("runChildAgent", () => {
  it("runs the child in a fresh context and returns a structured report", async () => {
    await writeFile(join(workspaceRoot, "note.txt"), "hello from the workspace", "utf-8");

    const llm = makeFakeLlm([
      {
        role: "assistant",
        content: "Reading the file.",
        toolCalls: [{ id: "c1", name: "read_file", parameters: { path: "note.txt" } }]
      } as AgentMessage,
      { role: "assistant", content: "The workspace contains note.txt with the text 'hello from the workspace'." }
    ]);

    const handle = makeHandle();
    const outcome = await runChildAgent(
      { workspaceRoot, userId: "u", conversationId: "conv-test", mode: "agent" },
      parentConfig,
      handle,
      llm
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.report).toContain("hello from the workspace");
    expect(outcome.report).toContain("child agent summary");
    expect(outcome.report).toContain("paths examined: note.txt");
    expect(outcome.toolCallCount).toBe(1);

    // Registry is populated for get_agent_status.
    const registered = childAgentRegistry.get(handle.id);
    expect(registered?.status).toBe("completed");
    expect(registered?.result).toContain("child agent summary");

    // Fresh context: the child's first provider payload contains the TASK
    // and the isolation instructions, not a parent conversation.
    const firstMessages = llm.calls[0]?.messages ?? [];
    const allContent = firstMessages.map((m) => String(m.content)).join("\n");
    expect(allContent).toContain("isolated child agent");
    expect(allContent).toContain("Investigate the workspace and report what files exist at the root.");
  });

  it("advertises and permits only read-only tools to the child", async () => {
    const llm = makeFakeLlm([
      {
        role: "assistant",
        content: "Trying to write.",
        toolCalls: [{ id: "c1", name: "write_file", parameters: { path: "evil.txt", content: "nope" } }]
      } as AgentMessage,
      { role: "assistant", content: "I could not write; reporting instead." }
    ]);

    const handle = makeHandle();
    const outcome = await runChildAgent(
      { workspaceRoot, userId: "u", conversationId: "conv-test", mode: "agent" },
      parentConfig,
      handle,
      llm
    );

    // The write tool is not advertised to the child at all.
    const advertisedNames = ((llm.calls[0]?.openAITools ?? []) as Array<Record<string, unknown>>)
      .map((tool) => (tool.function as { name?: string } | undefined)?.name);
    expect(advertisedNames).not.toContain("write_file");
    expect(advertisedNames).not.toContain("execute_command");
    for (const name of advertisedNames) {
      expect(CHILD_SAFE_TOOLS.has(String(name))).toBe(true);
    }

    // The attempted write never hit the disk.
    await expect(readFile(join(workspaceRoot, "evil.txt"))).rejects.toThrow();
    expect(outcome.status).toBe("completed");
  });

  it("refuses to spawn at the nesting limit without running any LLM call", async () => {
    const handle = makeHandle();
    const outcome = await runChildAgent(
      { workspaceRoot, userId: "u", conversationId: "conv-test", mode: "agent", agentDepth: MAX_AGENT_DEPTH },
      parentConfig,
      handle,
      makeFakeLlm([])
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.report).toContain("nesting limit");
    expect(outcome.toolCallCount).toBe(0);
    expect(childAgentRegistry.get(handle.id)?.status).toBe("failed");
  });

  it("never writes the parent's working-memory file", async () => {
    const llm = makeFakeLlm([{ role: "assistant", content: "Report done." }]);
    const handle = makeHandle();

    await runChildAgent(
      { workspaceRoot, userId: "u", conversationId: "conv-test", mode: "agent", agentDepth: 1 },
      parentConfig,
      handle,
      llm
    );

    await expect(readFile(join(workspaceRoot, ".rapa", "working-memory.md"))).rejects.toThrow();
  });

  it("marks a pre-aborted child as cancelled", async () => {
    const llm = makeFakeLlm([{ role: "assistant", content: "never finishes" }]);
    const handle = makeHandle();
    handle.abortController?.abort();

    const outcome = await runChildAgent(
      { workspaceRoot, userId: "u", conversationId: "conv-test", mode: "agent" },
      parentConfig,
      handle,
      llm
    );

    expect(outcome.status).toBe("cancelled");
    expect(childAgentRegistry.get(handle.id)?.status).toBe("cancelled");
  });
});
