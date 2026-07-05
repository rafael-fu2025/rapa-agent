// Tests for the P2-D tool result truncation logic in ToolOrchestrator.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../../tools.js";
import { ToolOrchestrator } from "../tool-orchestrator.js";
import { registerAllTools, toolRegistry } from "../../../tools/index.js";

let workspaceRoot = "";

class NoopTool extends Tool {
  definition: ToolDefinition = {
    name: "noop",
    description: "noop",
    category: "system",
    riskLevel: "read",
    requiresApproval: false,
    parameters: {}
  };
  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    return { success: true, output: (params.text as string) ?? "ok" };
  }
}

class LongOutputTool extends Tool {
  definition: ToolDefinition = {
    name: "long_output",
    description: "emits a long output",
    category: "system",
    riskLevel: "read",
    requiresApproval: false,
    parameters: {
      length: { type: "number", description: "size", required: true }
    }
  };
  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const length = (params.length as number) ?? 0;
    return { success: true, output: "x".repeat(length) };
  }
}

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "rapa-trunc-"));
  workspaceRoot = base;
  // Register the test tools against the global registry so ToolOrchestrator
  // can find them. Tear them down in `afterEach` to keep tests isolated.
  toolRegistry.register(new NoopTool());
  toolRegistry.register(new LongOutputTool());
});

afterEach(() => {
  toolRegistry.unregister("noop");
  toolRegistry.unregister("long_output");
  vi.unstubAllEnvs();
});

describe("ToolOrchestrator tool-result truncation (P2-D)", () => {
  it("passes through a small result unchanged", async () => {
    const orch = new ToolOrchestrator({
      context: { workspaceRoot, userId: "u", conversationId: "c" },
      config: { maxIterations: 1, autoApproveTools: [], provider: "p", model: "m", baseUrl: "b", apiKey: "k" }
    });
    const [result] = await orch.executeToolCallsInBatches([
      { id: "t1", name: "noop", parameters: { text: "small" } }
    ]);
    expect(result.output).toBe("small");
    // Truncation is opt-in: the result object is returned as-is when the
    // output is within the cap. No `truncated` flag is added.
    expect(result.data === undefined || (typeof result.data === "object" && !("truncated" in (result.data as object)))).toBe(true);
  });

  it("truncates an output that exceeds the default 50_000 char cap", async () => {
    const orch = new ToolOrchestrator({
      context: { workspaceRoot, userId: "u", conversationId: "c" },
      config: { maxIterations: 1, autoApproveTools: [], provider: "p", model: "m", baseUrl: "b", apiKey: "k" }
    });
    const [result] = await orch.executeToolCallsInBatches([
      { id: "t1", name: "long_output", parameters: { length: 100_000 } }
    ]);
    expect(result.success).toBe(true);
    expect(result.output?.length).toBeLessThan(100_000);
    // Output is either truncated (if eviction didn't fire) or evicted to disk
    expect(result.output).toMatch(/truncated|evicted/);
  });

  it("honours a smaller cap set via TOOL_OUTPUT_MAX_CHARS", async () => {
    vi.stubEnv("TOOL_OUTPUT_MAX_CHARS", "500");
    const orch = new ToolOrchestrator({
      context: { workspaceRoot, userId: "u", conversationId: "c" },
      config: { maxIterations: 1, autoApproveTools: [], provider: "p", model: "m", baseUrl: "b", apiKey: "k" }
    });
    const [result] = await orch.executeToolCallsInBatches([
      { id: "t1", name: "long_output", parameters: { length: 5_000 } }
    ]);
    expect(result.output?.length).toBeLessThan(1_000);
    expect(result.output).toMatch(/truncated \d+ chars/);
  });

  it("honours a per-call override via config.memoryBudget.toolResultCharLimit", async () => {
    const orch = new ToolOrchestrator({
      context: { workspaceRoot, userId: "u", conversationId: "c" },
      config: {
        maxIterations: 1,
        autoApproveTools: [],
        provider: "p",
        model: "m",
        baseUrl: "b",
        apiKey: "k",
        memoryBudget: { toolResultCharLimit: 100 }
      }
    });
    const [result] = await orch.executeToolCallsInBatches([
      { id: "t1", name: "long_output", parameters: { length: 2_000 } }
    ]);
    expect(result.output?.length).toBeLessThan(300);
  });

  it("does not mutate the underlying result when no truncation is needed", async () => {
    const orch = new ToolOrchestrator({
      context: { workspaceRoot, userId: "u", conversationId: "c" },
      config: { maxIterations: 1, autoApproveTools: [], provider: "p", model: "m", baseUrl: "b", apiKey: "k" }
    });
    const [result] = await orch.executeToolCallsInBatches([
      { id: "t1", name: "noop", parameters: { text: "hello" } }
    ]);
    expect(result.success).toBe(true);
    expect(result.output).toBe("hello");
  });
});
