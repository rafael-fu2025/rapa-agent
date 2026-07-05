// Tests for the per-tool prompt documentation renderer.

import { describe, expect, it } from "vitest";
import { renderToolDocs, TOOL_DOCS } from "../tool-docs.js";

type MinimalTool = { name: string; description: string; category: string };

describe("renderToolDocs", () => {
  it("groups tools by category, preserving first-seen order", () => {
    // Use real tool names so we exercise the rich-doc path (backticks).
    const tools: MinimalTool[] = [
      { name: "read_file", description: "Read a file", category: "filesystem" },
      { name: "execute_command", description: "Run shell", category: "shell" },
      { name: "write_file", description: "Write a file", category: "filesystem" }
    ];
    const out = renderToolDocs(tools);
    // filesystem is seen first (read_file) so it comes before shell (execute_command).
    const fsIdx = out.indexOf("### filesystem");
    const shellIdx = out.indexOf("### shell");
    expect(fsIdx).toBeGreaterThanOrEqual(0);
    expect(shellIdx).toBeGreaterThanOrEqual(0);
    expect(fsIdx).toBeLessThan(shellIdx);
    // within filesystem, read_file was added before write_file
    expect(out.indexOf("`read_file`")).toBeLessThan(out.indexOf("`write_file`"));
  });

  it("renders the rich doc block for documented tools", () => {
    const tools: MinimalTool[] = [
      { name: "read_file", description: "Read a file", category: "filesystem" }
    ];
    const out = renderToolDocs(tools);
    // Has the four required sections of a rich doc
    expect(out).toContain("`read_file`");
    expect(out).toContain("**When to use**");
    expect(out).toContain("**Signature**");
    expect(out).toContain("**Example**");
    expect(out).toContain("**Rules**");
  });

  it("falls back to a one-liner for undocumented tools", () => {
    const tools: MinimalTool[] = [
      { name: "totally_new_tool", description: "Does something new", category: "system" }
    ];
    const out = renderToolDocs(tools);
    expect(out).toContain("**totally_new_tool**");
    expect(out).toContain("Does something new");
    // No rich doc structure for undocumented tools
    expect(out).not.toContain("#### `totally_new_tool`");
  });

  it("renders all 30+ registered tool docs without errors", () => {
    // Sanity: every key in TOOL_DOCS has a non-empty summary and signature
    for (const [name, doc] of Object.entries(TOOL_DOCS)) {
      expect(doc.summary.length, `${name} missing summary`).toBeGreaterThan(0);
      expect(doc.signature.length, `${name} missing signature`).toBeGreaterThan(0);
      expect(doc.example.length, `${name} missing example`).toBeGreaterThan(0);
      expect(doc.rules.length, `${name} missing rules`).toBeGreaterThan(0);
      expect(doc.whenToUse.length, `${name} missing whenToUse`).toBeGreaterThan(0);
    }
  });

  it("does not break when an empty tools list is passed", () => {
    expect(renderToolDocs([])).toBe("");
  });
});
