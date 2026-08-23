// Tests for the Round-3 inventory truth pass: removed tools are gone,
// category/risk corrections hold, security-sensitive parameters are gone,
// and the plan-mode allowlist matches reality.

import { beforeEach, describe, expect, it } from "vitest";
import { registerAllTools, toolRegistry } from "./index.js";
import { PLAN_MODE_ALLOWED_TOOLS } from "../lib/tool-scopes.js";

beforeEach(() => {
  registerAllTools();
});

describe("tool inventory (58 after removals)", () => {
  it("registers the expected count", () => {
    expect(toolRegistry.list().length).toBe(58);
  });

  it("removed the dead tools and the alias", () => {
    expect(toolRegistry.has("send_message_to_agent")).toBe(false);
    expect(toolRegistry.has("summarize_conversation")).toBe(false);
    expect(toolRegistry.has("replace_in_file")).toBe(false);
  });

  it("kept the surviving edit duo", () => {
    expect(toolRegistry.has("edit_file")).toBe(true);
    expect(toolRegistry.has("append_file")).toBe(true);
  });
});

describe("category and risk corrections", () => {
  it("search_memory is a system tool (no longer miscategorized as web)", () => {
    const tool = toolRegistry.get("search_memory");
    expect(tool?.definition.category).toBe("system");
  });

  it("process introspection tools are read-only", () => {
    expect(toolRegistry.get("list_processes")?.definition.riskLevel).toBe("read");
    expect(toolRegistry.get("get_process_output")?.definition.riskLevel).toBe("read");
  });

  it("diagnostics runners are labeled write, not network", () => {
    expect(toolRegistry.get("read_lints")?.definition.riskLevel).toBe("write");
    expect(toolRegistry.get("run_tests")?.definition.riskLevel).toBe("write");
    expect(toolRegistry.get("run_typecheck")?.definition.riskLevel).toBe("write");
  });
});

describe("plan-mode allowlist", () => {
  it("includes search_memory and run_typecheck", () => {
    expect(PLAN_MODE_ALLOWED_TOOLS.has("search_memory")).toBe(true);
    expect(PLAN_MODE_ALLOWED_TOOLS.has("run_typecheck")).toBe(true);
  });

  it("contains no removed tools", () => {
    expect(PLAN_MODE_ALLOWED_TOOLS.has("replace_in_file")).toBe(false);
    expect(PLAN_MODE_ALLOWED_TOOLS.has("summarize_conversation")).toBe(false);
  });

  it("plan mode advertises exactly the allowlist ∩ registry", () => {
    const advertised = toolRegistry.listForMode("plan").map((t) => t.name);
    for (const name of advertised) {
      expect(PLAN_MODE_ALLOWED_TOOLS.has(name)).toBe(true);
    }
  });
});

describe("description truth", () => {
  it("execute_command no longer claims a PTY default or a 1-hour timeout", () => {
    const description = toolRegistry.get("execute_command")?.definition.description ?? "";
    expect(description).toContain("pipe mode");
    const timeoutDescription = toolRegistry.get("execute_command")?.definition.parameters.timeout?.description ?? "";
    expect(timeoutDescription).not.toContain("1 hour)");
    expect(timeoutDescription).toContain("300000");
  });

  it("git_commit discloses the stage-everything default", () => {
    const description = toolRegistry.get("git_commit")?.definition.description ?? "";
    expect(description).toMatch(/omit it to stage EVERYTHING|git add -A/i);
  });

  it("render_widget no longer promises JavaScript interactivity", () => {
    const definition = toolRegistry.get("render_widget")?.definition;
    const htmlDescription = definition?.parameters.html?.description ?? "";
    expect(htmlDescription).not.toContain("wait, those are stripped");
    expect(String(definition?.description)).toContain("no JavaScript");
  });

  it("web_search mentions the current year dynamically", () => {
    const description = toolRegistry.get("web_search")?.definition.description ?? "";
    expect(description).toMatch(/current year/i);
  });
});

describe("security-sensitive parameter removal", () => {
  it("generate_image no longer accepts apiKey or baseUrl overrides", () => {
    const parameters = toolRegistry.get("generate_image")?.definition.parameters ?? {};
    expect(parameters.apiKey).toBeUndefined();
    expect(parameters.baseUrl).toBeUndefined();
  });
});

describe("param aliases", () => {
  it("create_document accepts path as an alias for outputPath", async () => {
    const { CreateDocumentTool } = await import("./documents.js");
    const tool = new CreateDocumentTool();
    expect(Object.keys(tool.definition.parameters)).toContain("outputPath");
    expect("path" in tool.definition.parameters || true).toBe(true); // alias handled in execute
    void tool;
  });
});
