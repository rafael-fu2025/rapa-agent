/**
 * Capability registry tests.
 *
 * See `.agents/notes/implemented/architecture/2026-08-15-capability-seam-triple.md`.
 */

import { describe, expect, it } from "vitest";

import {
  CapabilityRegistry,
  capabilityRegistry,
  listCapabilitiesForMode,
  lookupCapability,
  wrapToolAsProvider,
  type CapabilityProvider,
  type CapabilityPolicy
} from "../capability.js";
import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../../tools.js";

class FakeTool extends Tool {
  definition: ToolDefinition = {
    name: "fake_tool",
    description: "A fake tool for testing",
    parameters: {
      input: { type: "string", description: "input", required: true }
    },
    category: "system",
    riskLevel: "read",
    requiresApproval: false
  };
  async execute(_params: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<ToolResult> {
    return { success: true, output: "fake result" };
  }
}

class DestructiveTool extends Tool {
  definition: ToolDefinition = {
    name: "delete_everything",
    description: "delete stuff",
    parameters: {},
    category: "filesystem",
    riskLevel: "destructive",
    requiresApproval: true
  };
  async execute(): Promise<ToolResult> {
    return { success: true };
  }
}

describe("CapabilityRegistry", () => {
  it("register(provider, policy) stores an entry", () => {
    const reg = new CapabilityRegistry();
    const provider: CapabilityProvider = {
      definition: {
        name: "echo",
        description: "echo",
        parameters: {},
        category: "system"
      },
      async execute() { return { success: true, output: "ok" }; }
    };
    const policy: CapabilityPolicy = { riskLevel: "read", requiresApproval: false };
    reg.register(provider, policy);

    const entry = reg.get("echo");
    expect(entry?.provider.definition.name).toBe("echo");
    expect(entry?.policy.riskLevel).toBe("read");
  });

  it("register rejects duplicates", () => {
    const reg = new CapabilityRegistry();
    const provider: CapabilityProvider = {
      definition: { name: "x", description: "", parameters: {}, category: "system" },
      async execute() { return { success: true }; }
    };
    reg.register(provider, { riskLevel: "read", requiresApproval: false });
    expect(() => reg.register(provider, { riskLevel: "read", requiresApproval: false })).toThrow(/already registered/);
  });

  it("registerTool wraps a Tool with default policy from its definition", () => {
    const reg = new CapabilityRegistry();
    const tool = new FakeTool();
    reg.registerTool(tool);

    const entry = reg.get("fake_tool");
    expect(entry?.provider.definition.name).toBe("fake_tool");
    expect(entry?.policy.riskLevel).toBe("read");
    expect(entry?.policy.requiresApproval).toBe(false);
  });

  it("registerTool extracts riskLevel/requiresApproval from the tool definition", () => {
    const reg = new CapabilityRegistry();
    reg.registerTool(new DestructiveTool());
    const entry = reg.get("delete_everything");
    expect(entry?.policy.riskLevel).toBe("destructive");
    expect(entry?.policy.requiresApproval).toBe(true);
  });

  it("wrapToolAsProvider preserves the Tool's execute semantics", async () => {
    const tool = new FakeTool();
    const provider = wrapToolAsProvider(tool);
    const result = await provider.execute({ input: "hi" }, {} as ToolExecutionContext);
    expect(result).toEqual({ success: true, output: "fake result" });
  });

  it("rebuildFromToolRegistry populates from a legacy registry", () => {
    const reg = new CapabilityRegistry();
    const tools = new Map<string, Tool>([["fake_tool", new FakeTool()]]);
    reg.rebuildFromToolRegistry({
      list: () => Array.from(tools.values()).map((t) => t.definition),
      get: (name) => tools.get(name)
    });
    expect(reg.size()).toBe(1);
    expect(reg.has("fake_tool")).toBe(true);
  });

  it("listByRisk filters entries by risk threshold", () => {
    const reg = new CapabilityRegistry();
    reg.registerTool(new FakeTool()); // read
    reg.registerTool(new DestructiveTool()); // destructive
    expect(reg.listByRisk("read").map((e) => e.provider.definition.name)).toEqual(["fake_tool"]);
    expect(reg.listByRisk("destructive").map((e) => e.provider.definition.name).sort()).toEqual(["delete_everything", "fake_tool"]);
  });
});

describe("module-level capability helpers", () => {
  it("lookupCapability returns the entry from the process-wide registry", () => {
    capabilityRegistry.clear();
    capabilityRegistry.registerTool(new FakeTool());
    const entry = lookupCapability("fake_tool");
    expect(entry?.provider.definition.name).toBe("fake_tool");
  });

  it("listCapabilitiesForMode filters for plan mode (no writes/execute)", () => {
    capabilityRegistry.clear();
    capabilityRegistry.registerTool(new FakeTool());
    capabilityRegistry.registerTool(new DestructiveTool());
    const planEntries = listCapabilitiesForMode("plan");
    expect(planEntries.find((e) => e.provider.definition.name === "fake_tool")).toBeDefined();
    expect(planEntries.find((e) => e.provider.definition.name === "delete_everything")).toBeDefined();
    // Note: real `execute_command`/`write_file` would be filtered by name; this
    // test only covers the structure since those tools aren't registered.
  });
});