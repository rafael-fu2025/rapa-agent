// Tests for the verify-before-done completion gate and its supporting
// helpers (hasTestInfrastructure, resolveTypecheckCommand,
// summarizeVerification). The agent-level tests use the fake-LLM seam from
// agent.test.ts and a real workspace whose `npm test` script fails or
// passes on demand.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../../agent.js";
import { registerAllTools } from "../../../tools/index.js";
import { hasTestInfrastructure, resolveTypecheckCommand } from "../../../tools/diagnostics.js";
import { ToolOrchestrator } from "../tool-orchestrator.js";
import type { AgentConfig, AgentExecutionEvent, AgentMessage, ProviderChatMessage } from "../types.js";
import type { LLMClient } from "../llm-client.js";
import type { ToolResult } from "../../tools.js";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "rapa-verify-"));
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
      const message = script[callIndex] ?? script[script.length - 1] ?? { role: "assistant", content: "" };
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

const buildConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  maxIterations: 10,
  autoApproveTools: ["write_file"],
  provider: "test",
  model: "test-model",
  baseUrl: "http://localhost",
  apiKey: "k",
  ...overrides
});

async function runAgent(llm: LLMClient, prompt: string): Promise<{
  events: AgentExecutionEvent[];
  done?: Extract<AgentExecutionEvent, { type: "done" }>;
}> {
  const agent = new Agent(
    { workspaceRoot, userId: "u", conversationId: `c-${Date.now()}-${Math.random().toString(36).slice(2)}`, mode: "agent" },
    buildConfig(),
    llm
  );
  const events: AgentExecutionEvent[] = [];
  for await (const event of agent.stream(prompt)) {
    events.push(event);
  }
  return { events, done: events.find((e) => e.type === "done") as Extract<AgentExecutionEvent, { type: "done" }> | undefined };
}

const writeToolTurn: AgentMessage = {
  role: "assistant",
  content: "Writing the file.",
  toolCalls: [{ id: "c1", name: "write_file", parameters: { path: "src.js", content: "console.log(1)\n" } }]
} as AgentMessage;

describe("hasTestInfrastructure / resolveTypecheckCommand", () => {
  it("detects a package.json test script as test infrastructure", async () => {
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ name: "t", scripts: { test: "node x.js" } }), "utf-8");
    expect(hasTestInfrastructure(workspaceRoot)).toBe(true);
  });

  it("treats a bare scaffold with no test setup as having no infrastructure", () => {
    expect(hasTestInfrastructure(workspaceRoot)).toBe(false);
  });

  it("prefers the project's own typecheck script", async () => {
    await writeFile(
      join(workspaceRoot, "package.json"),
      JSON.stringify({ name: "t", scripts: { typecheck: "tsc --noEmit" } }),
      "utf-8"
    );
    expect(resolveTypecheckCommand(workspaceRoot)).toBe("npm run typecheck 2>&1");
  });

  it("falls back to tsc --noEmit when only a tsconfig exists", async () => {
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ name: "t" }), "utf-8");
    await writeFile(join(workspaceRoot, "tsconfig.json"), "{}", "utf-8");
    expect(resolveTypecheckCommand(workspaceRoot)).toBe("npx tsc --noEmit 2>&1");
  });

  it("returns null when no typecheck is configured", async () => {
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ name: "t" }), "utf-8");
    expect(resolveTypecheckCommand(workspaceRoot)).toBeNull();
  });
});

describe("summarizeVerification", () => {
  const orch = new ToolOrchestrator({
    context: { workspaceRoot, userId: "u", conversationId: "c" },
    config: { maxIterations: 1, autoApproveTools: [], provider: "p", model: "m", baseUrl: "b", apiKey: "k" }
  });

  it("splits results by command and reports pass/fail", () => {
    const results: ToolResult[] = [
      { success: true, output: "ok", data: { command: "npm test", pass: true } },
      { success: false, output: "err", error: "2 test(s) failed", data: { command: "npm run typecheck 2>&1", pass: false } }
    ];
    expect(orch.summarizeVerification(results)).toEqual({
      testsPassed: true,
      typecheckPassed: false
    });
  });

  it("returns null when nothing ran", () => {
    expect(orch.summarizeVerification([])).toBeNull();
  });
});

describe("verify-before-done gate (agent loop)", () => {
  it("bounces a declared-complete answer back once when tests fail, then completes with the status", async () => {
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ name: "t", scripts: { test: "node failing.js" } }), "utf-8");
    await writeFile(join(workspaceRoot, "failing.js"), "console.error('boom'); process.exit(1);\n", "utf-8");

    const llm = makeFakeLlm([
      writeToolTurn,
      { role: "assistant", content: "All done — the work is complete." },
      { role: "assistant", content: "Fixed the failures. Done." }
    ]);
    const { events, done } = await runAgent(llm, "write the file and finish");

    // The gate fired: a verification step + a bounce user message exist.
    const bounceStep = events.find((e) => e.type === "step" && /Verify-before-done/.test(e.step.reasoning ?? ""));
    expect(bounceStep).toBeDefined();
    const bounceMessage = llm.calls[2]?.messages.find((m) => m.role === "user" && /verification FAILED/i.test(String(m.content)));
    expect(bounceMessage).toBeDefined();

    // The run still completes, carrying the failing status on the done event.
    expect(done?.status).toBe("completed");
    expect(done?.verification).toEqual({ testsPassed: false, typecheckPassed: true });
  });

  it("completes without a bounce when verification passes", async () => {
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ name: "t", scripts: { test: "node passing.js" } }), "utf-8");
    await writeFile(join(workspaceRoot, "passing.js"), "console.log('Tests 1 passed');\n", "utf-8");

    const llm = makeFakeLlm([
      writeToolTurn,
      { role: "assistant", content: "Work complete." }
    ]);
    const { done } = await runAgent(llm, "write the file and finish");

    expect(llm.calls.length).toBe(2);
    expect(done?.verification).toEqual({ testsPassed: true, typecheckPassed: true });
  });

  it("skips the gate when no files were modified", async () => {
    const llm = makeFakeLlm([
      { role: "assistant", content: "Nothing to change — here is the answer." }
    ]);
    const { done } = await runAgent(llm, "just answer");

    expect(llm.calls.length).toBe(1);
    expect(done?.verification).toBeUndefined();
  });
});
