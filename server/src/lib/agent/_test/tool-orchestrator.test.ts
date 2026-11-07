// Tests for the P2-D tool result truncation logic in ToolOrchestrator.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../../tools.js";
import { ToolOrchestrator } from "../tool-orchestrator.js";
import { toolRegistry } from "../../../tools/index.js";
import { ReadFileTool, WriteFileTool } from "../../../tools/filesystem.js";

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
  async execute(params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
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
  async execute(params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    const length = (params.length as number) ?? 0;
    return { success: true, output: "x".repeat(length) };
  }
}

class LeakyTool extends Tool {
  definition: ToolDefinition = {
    name: "leaky",
    description: "emits result shapes carrying secrets",
    category: "system",
    riskLevel: "read",
    requiresApproval: false,
    parameters: {}
  };
  async execute(_params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    return {
      success: true,
      output: "run ok — api_key=sk-live-abcdef1234567890abcdef",
      data: {
        content: "config loaded with secret: hunter2-super-long-value",
        body: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==",
        textContent: "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        results: [
          { title: "search hit", snippet: "found sk-xyz98765432109876543210 in logs", content: " Authorization: Bearer abc.def.ghi-jkl-mno-pqr-stu-vwx-yz" },
          { title: "plain hit", snippet: "nothing sensitive here" }
        ]
      }
    };
  }
}

class LeakyWriteTool extends Tool {
  definition: ToolDefinition = {
    name: "leaky_write",
    description: "emits result shapes carrying secrets on the write path",
    category: "system",
    riskLevel: "write",
    requiresApproval: false,
    parameters: {}
  };
  async execute(_params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    return {
      success: true,
      output: "written — api_key=sk-live-abcdef1234567890abcdef",
      data: {
        content: "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789"
      }
    };
  }
}

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "rapa-trunc-"));
  workspaceRoot = base;
  // Register the test tools against the global registry so ToolOrchestrator
  // can find them. Tear them down in `afterEach` to keep tests isolated.
  toolRegistry.register(new NoopTool());
  toolRegistry.register(new LongOutputTool());
  toolRegistry.register(new LeakyTool());
  toolRegistry.register(new LeakyWriteTool());
});

afterEach(() => {
  toolRegistry.unregister("noop");
  toolRegistry.unregister("long_output");
  toolRegistry.unregister("leaky");
  toolRegistry.unregister("leaky_write");
  vi.unstubAllEnvs();
});

describe("ToolOrchestrator read dedup (context economy)", () => {
  const makeConfig = (overrides: Record<string, unknown> = {}) => ({
    maxIterations: 5,
    autoApproveTools: ["write_file"],
    provider: "p",
    model: "m",
    baseUrl: "b",
    apiKey: "k",
    ...overrides
  });

  const readCall = (path: string, params: Record<string, unknown> = {}) =>
    ({ id: `read-${path}-${JSON.stringify(params)}`, name: "read_file", parameters: { path, ...params } });

  beforeEach(() => {
    toolRegistry.register(new ReadFileTool());
    toolRegistry.register(new WriteFileTool());
  });

  afterEach(() => {
    toolRegistry.unregister("read_file");
    toolRegistry.unregister("write_file");
  });

  it("stubs an identical re-read of an unchanged file", async () => {
    await writeFile(join(workspaceRoot, "a.txt"), "hello world", "utf-8");
    const orch = new ToolOrchestrator({
      context: { workspaceRoot, userId: "u", conversationId: "c" },
      config: makeConfig()
    });

    const [first] = await orch.executeToolCallsInBatches([readCall("a.txt")]);
    expect((first!.data as Record<string, unknown>).content).toBe("hello world");
    expect((first!.data as Record<string, unknown>).deduped).toBeUndefined();

    const [second] = await orch.executeToolCallsInBatches([readCall("a.txt")]);
    const data = second!.data as Record<string, unknown>;
    expect(data.deduped).toBe(true);
    expect(String(data.content)).toMatch(/UNCHANGED/i);
    // Metadata survives so the model still knows what it has seen.
    expect(data.path).toBe("a.txt");
    expect(data.totalLines).toBeDefined();
  });

  it("returns full content again once the file changed on disk", async () => {
    await writeFile(join(workspaceRoot, "b.txt"), "version 1", "utf-8");
    const orch = new ToolOrchestrator({
      context: { workspaceRoot, userId: "u", conversationId: "c" },
      config: makeConfig()
    });

    await orch.executeToolCallsInBatches([readCall("b.txt")]);
    await writeFile(join(workspaceRoot, "b.txt"), "version 2 with different bytes", "utf-8");
    const [reread] = await orch.executeToolCallsInBatches([readCall("b.txt")]);
    expect((reread!.data as Record<string, unknown>).content).toBe("version 2 with different bytes");
    expect((reread!.data as Record<string, unknown>).deduped).toBeUndefined();
  });

  it("does not dedup a different range of the same file", async () => {
    await writeFile(join(workspaceRoot, "c.txt"), "one\ntwo\nthree\nfour", "utf-8");
    const orch = new ToolOrchestrator({
      context: { workspaceRoot, userId: "u", conversationId: "c" },
      config: makeConfig()
    });

    await orch.executeToolCallsInBatches([readCall("c.txt")]);
    const [partial] = await orch.executeToolCallsInBatches([readCall("c.txt", { offset: 2, limit: 2 })]);
    expect((partial!.data as Record<string, unknown>).content).toBe("two\nthree");
    expect((partial!.data as Record<string, unknown>).deduped).toBeUndefined();
  });

  it("invalidates the snapshot after a write to the same file", async () => {
    await writeFile(join(workspaceRoot, "d.txt"), "initial", "utf-8");
    const orch = new ToolOrchestrator({
      context: { workspaceRoot, userId: "u", conversationId: "c" },
      config: makeConfig()
    });

    await orch.executeToolCallsInBatches([readCall("d.txt")]);
    const [, writeResult] = await orch.executeToolCallsInBatches([
      readCall("d.txt"),
      { id: "w1", name: "write_file", parameters: { path: "d.txt", content: "rewritten" } }
    ]);
    expect(writeResult!.success).toBe(true);

    // The write invalidated the snapshot: the next read returns the new
    // content in full (not a stub keyed on the pre-write content).
    const [reread] = await orch.executeToolCallsInBatches([readCall("d.txt")]);
    expect((reread!.data as Record<string, unknown>).content).toBe("rewritten");
  });

  it("respects memoryBudget.readDedup === false", async () => {
    await writeFile(join(workspaceRoot, "e.txt"), "stable content", "utf-8");
    const orch = new ToolOrchestrator({
      context: { workspaceRoot, userId: "u", conversationId: "c" },
      config: makeConfig({ memoryBudget: { readDedup: false } })
    });

    await orch.executeToolCallsInBatches([readCall("e.txt")]);
    const [reread] = await orch.executeToolCallsInBatches([readCall("e.txt")]);
    expect((reread!.data as Record<string, unknown>).content).toBe("stable content");
    expect((reread!.data as Record<string, unknown>).deduped).toBeUndefined();
  });
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

describe("ToolOrchestrator secret redaction", () => {
  const makeOrchestrator = () => new ToolOrchestrator({
    context: { workspaceRoot, userId: "u", conversationId: "c" },
    config: { maxIterations: 1, autoApproveTools: [], provider: "p", model: "m", baseUrl: "b", apiKey: "k" }
  });

  it("redacts secrets from output and data fields on the read path", async () => {
    const orch = makeOrchestrator();
    const [result] = await orch.executeToolCallsInBatches([
      { id: "l1", name: "leaky", parameters: {} }
    ]);
    expect(result.success).toBe(true);

    const serialized = JSON.stringify(result);
    // Secrets never survive the pipeline.
    expect(serialized).not.toContain("sk-live-abcdef1234567890abcdef");
    expect(serialized).not.toContain("hunter2-super-long-value");
    expect(serialized).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(serialized).not.toContain("sk-xyz98765432109876543210");
    expect(serialized).not.toContain("Bearer abc.def.ghi-jkl-mno-pqr-stu-vwx-yz");
    // Redaction leaves a masked trace, not an empty string.
    expect(result.output).toContain("api_");
    // Non-secret structure is preserved.
    const data = result.data as Record<string, unknown>;
    expect(data.results).toHaveLength(2);
    expect((data.results as Array<Record<string, unknown>>)[1]).toEqual({
      title: "plain hit",
      snippet: "nothing sensitive here"
    });
  });

  it("skips strings that start with a data:image URI (base64 false positive)", async () => {
    const orch = makeOrchestrator();
    const [result] = await orch.executeToolCallsInBatches([
      { id: "l1", name: "leaky", parameters: {} }
    ]);
    const data = result.data as Record<string, unknown>;
    const body = data.body as string;
    expect(body.startsWith("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg")).toBe(true);
    expect(body).toContain("iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4");
  });

  it("redacts results[] entry fields (title/snippet/content)", async () => {
    const orch = makeOrchestrator();
    const [result] = await orch.executeToolCallsInBatches([
      { id: "l1", name: "leaky", parameters: {} }
    ]);
    const [first] = (result.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    expect(first.title).toBe("search hit");
    expect(first.snippet).not.toContain("sk-xyz98765432109876543210");
    expect(first.snippet).toContain("found");
    expect(first.content).not.toContain("Bearer abc.def");
  });

  it("redacts on the sequential write path too", async () => {
    const orch = makeOrchestrator();
    const [result] = await orch.executeToolCallsInBatches([
      { id: "lw1", name: "leaky_write", parameters: {} }
    ]);
    expect(result.success).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-live-abcdef1234567890abcdef");
    expect(serialized).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("leaves clean results untouched (no copy churn)", async () => {
    const orch = makeOrchestrator();
    const [result] = await orch.executeToolCallsInBatches([
      { id: "t1", name: "noop", parameters: { text: "just text, no secrets" } }
    ]);
    expect(result.output).toBe("just text, no secrets");
  });
});

describe("ToolOrchestrator auto-approve classifier ride-through", () => {
  it("attaches config.autoApproveClassifier to the approval request", async () => {
    const { ExecuteCommandTool } = await import("../../../tools/shell.js");
    toolRegistry.register(new ExecuteCommandTool());
    const seen: Array<Record<string, unknown>> = [];
    const orch = new ToolOrchestrator({
      context: { workspaceRoot, userId: "u", conversationId: "c" },
      config: {
        maxIterations: 1,
        autoApproveTools: [],
        provider: "p",
        model: "m",
        baseUrl: "b",
        apiKey: "k",
        autoApproveClassifier: { enabled: true, provider: "openai", model: "gpt-test" },
        requestToolApproval: async (request) => {
          seen.push(request as unknown as Record<string, unknown>);
          return { approved: true };
        }
      }
    });

    // execute_command is a shell tool with requiresApproval — the approval
    // path (and therefore requestToolApproval) runs for it.
    await orch.executeToolCallsInBatches([
      { id: "s1", name: "execute_command", parameters: { command: "echo classifier-ride-test" } }
    ]);

    toolRegistry.unregister("execute_command");

    expect(seen).toHaveLength(1);
    expect(seen[0].autoApproveClassifier).toEqual({ enabled: true, provider: "openai", model: "gpt-test" });
  });
});
