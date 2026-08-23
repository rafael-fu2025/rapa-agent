// Tests for the Round-2 execution-flow changes: running-status events,
// risk-overlay approval visibility, denial-tracked checkpoint validation,
// honest synthetic validation labels, and shell abort propagation.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../../agent.js";
import { registerAllTools, toolRegistry } from "../../../tools/index.js";
import { ToolOrchestrator } from "../tool-orchestrator.js";
import { ExecuteCommandTool } from "../../../tools/shell.js";
import type { AgentConfig, AgentExecutionEvent, AgentMessage, ProviderChatMessage, ToolCall } from "../types.js";
import type { LLMClient } from "../llm-client.js";
import type { ToolExecutionContext, ToolResult } from "../../tools.js";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "rapa-execflow-"));
  registerAllTools();
});

afterEach(async () => {
  // Windows can briefly hold the tmpdir as an aborted child's cwd — retry once.
  try {
    await rm(workspaceRoot, { recursive: true, force: true });
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
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

const baseConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  maxIterations: 5,
  autoApproveTools: ["write_file"],
  provider: "test",
  model: "test-model",
  baseUrl: "http://localhost",
  apiKey: "k",
  ...overrides
});

async function runAgent(
  llm: LLMClient,
  prompt: string,
  config: AgentConfig
): Promise<AgentExecutionEvent[]> {
  const agent = new Agent(
    { workspaceRoot, userId: "u", conversationId: `execflow-${Date.now()}-${Math.random().toString(36).slice(2)}`, mode: "agent" },
    config,
    llm
  );
  const events: AgentExecutionEvent[] = [];
  for await (const event of agent.stream(prompt)) {
    events.push(event);
  }
  return events;
}

describe("running-status events", () => {
  it("emits pending → running → completed for an executed tool call", async () => {
    const llm = makeFakeLlm([
      {
        role: "assistant",
        content: "Writing.",
        toolCalls: [{ id: "w1", name: "write_file", parameters: { path: "out.txt", content: "hi" } }]
      } as AgentMessage,
      { role: "assistant", content: "Done." }
    ]);
    const events = await runAgent(llm, "write the file", baseConfig());

    const statuses = events
      .filter((e): e is Extract<AgentExecutionEvent, { type: "tool_call" }> =>
        e.type === "tool_call" && e.call.name === "write_file")
      .map((e) => e.status);
    expect(statuses).toContain("running");
    // Order: pending first, running before completed.
    expect(statuses.indexOf("running")).toBeGreaterThan(statuses.indexOf("pending"));
    expect(statuses.indexOf("running")).toBeLessThan(statuses.lastIndexOf("completed"));
  });
});

describe("risk-overlay approval visibility", () => {
  it("surfaces a requires_approval event even when the shell tool is auto-approved", async () => {
    const llm = makeFakeLlm([
      {
        role: "assistant",
        content: "Running the risky command.",
        toolCalls: [{ id: "c1", name: "execute_command", parameters: { command: "rm -rf /tmp/whatever-should-need-approval" } }]
      } as AgentMessage,
      { role: "assistant", content: "OK, it was rejected. Moving on." }
    ]);

    const events = await runAgent(llm, "run the cleanup", baseConfig({ autoApproveTools: ["execute_command", "shell"] }));

    const approvalEvents = events.filter(
      (e): e is Extract<AgentExecutionEvent, { type: "tool_call" }> =>
        e.type === "tool_call" && e.status === "requires_approval" && e.call.name === "execute_command"
    );
    expect(approvalEvents.length).toBeGreaterThan(0);
    // The event carries an approval payload so the UI can render the dialog.
    const data = approvalEvents[0].result?.data as { approvalId?: string; requiresApproval?: boolean } | undefined;
    expect(data?.approvalId ?? data?.requiresApproval).toBeTruthy();
  });
});

describe("denial-tracked validation", () => {
  const context = (): ToolExecutionContext => ({ workspaceRoot, userId: "u", conversationId: "denial-test" });

  it("a user-denied tool is recorded and skipped by checkpoint validation", async () => {
    // Workspace with test infrastructure + a typecheck script.
    await writeFile(
      join(workspaceRoot, "package.json"),
      JSON.stringify({ name: "t", scripts: { test: "node failing.js", typecheck: "node -e 0" } }),
      "utf-8"
    );
    await writeFile(join(workspaceRoot, "failing.js"), "process.exit(1);\n", "utf-8");

    const orch = new ToolOrchestrator({
      context: context(),
      config: {
        ...baseConfig(),
        autoApproveTools: ["write_file"],
        // Deny every approval request → the tools get denied.
        requestToolApproval: async () => ({ approved: false, message: "no" })
      }
    });

    // Trigger a denial on run_tests via a direct call.
    const denied = await orch.executeToolCallsInBatches([
      { id: "t1", name: "run_tests", parameters: {} } as ToolCall
    ]);
    expect(denied[0]?.success).toBe(false);
    expect(orch.getUserDeniedTools().has("run_tests")).toBe(true);

    // Now write a source file and run checkpoint validation: run_tests must
    // be skipped (the typecheck still runs — not denied — and must be
    // labeled with its real name).
    const validation = await orch.runCheckpointValidation(
      [{ id: "w1", name: "write_file", parameters: { path: "src.ts", content: "const x: number = 1;\n" } } as ToolCall],
      [{ success: true, output: "ok" } as ToolResult]
    );

    const commands = validation.map((r) => String((r.data as { command?: string }).command ?? ""));
    expect(commands.some((c) => /npm test/.test(c))).toBe(false);
    expect(commands.some((c) => /typecheck/.test(c))).toBe(true);
    const typecheckResult = validation.find((r) => (r.data as { toolName?: string }).toolName === "run_typecheck");
    expect(typecheckResult).toBeDefined();
  });
});

describe("shell abort propagation", () => {
  it("aborting the context signal kills the running command early", async () => {
    const controller = new AbortController();
    const tool = toolRegistry.get("execute_command") as ExecuteCommandTool;

    const startedAt = Date.now();
    const execution = tool.execute(
      { command: "node -e \"setTimeout(() => process.exit(0), 8000)\"", timeout: 20000 },
      { workspaceRoot, userId: "u", conversationId: "abort-test", signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 150);

    const result = await execution;
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(5000);
    expect(result.success).toBe(false);
  }, 15000);
});
