// Tests for context compaction: the dropped-slice return contract and the
// post-compaction file restoration helpers (collectRecentlyReadFiles +
// buildFileRestorationMessages). compactHistory takes an injectable llmCall,
// so everything here runs without a real LLM.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "../types.js";
import {
  compactHistory,
  collectRecentlyReadFiles,
  buildFileRestorationMessages,
  RESTORATION_MAX_FILES
} from "../context-compactor.js";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "rapa-compaction-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

const fakeLlmCall = async () => "Summary of old turns.";

/**
 * Real history shape: an assistant message carrying `toolCalls` followed by
 * a tool message whose `toolResults` are positionally aligned with those
 * calls (ToolResult itself has no tool name — the pairing is positional).
 */
function readToolMessages(paths: string[]): AgentMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: paths.map((p, idx) => ({ id: `c${idx}`, name: "read_file", parameters: { path: p } }))
    },
    {
      role: "tool",
      content: "[]",
      toolResults: paths.map((p) => ({ success: true, output: "…", data: { path: p, content: "…" } }))
    }
  ];
}

describe("compactHistory — dropped slice", () => {
  it("returns the dropped messages alongside the compacted history", async () => {
    const history: AgentMessage[] = [
      { role: "system", content: "seed" },
      ...readToolMessages(["old.txt"]),
      { role: "user", content: "go" },
      { role: "assistant", content: "ok" }
    ];
    // Tiny budget so almost everything lands in toCompact.
    const { compactedHistory, summary, dropped } = await compactHistory(history, 300, fakeLlmCall);

    expect(summary).toBe("Summary of old turns.");
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped).toContainEqual(history[1]);
    expect(compactedHistory[0].content).toContain("[Compacted context");
  });

  it("returns an empty dropped slice when the budget cannot even keep the newest turn", async () => {
    const history: AgentMessage[] = [
      { role: "user", content: "hi there, this message is not tiny" },
      { role: "assistant", content: "hello" }
    ];
    // A budget so small the newest-first walk cannot keep even one message:
    // splitIndex stays at history.length and compaction is a no-op.
    const result = await compactHistory(history, 10, fakeLlmCall);
    expect(result.dropped).toEqual([]);
    expect(result.compactedHistory).toBe(history);
  });

  it("returns an empty dropped slice when summarization fails", async () => {
    const history: AgentMessage[] = [
      { role: "system", content: "seed" },
      ...readToolMessages(["old.txt"]),
      { role: "user", content: "go" },
      { role: "assistant", content: "ok" }
    ];
    const failingCall = async () => { throw new Error("summarizer down"); };
    const result = await compactHistory(history, 300, failingCall);
    expect(result.dropped).toEqual([]);
    expect(result.compactedHistory).toBe(history);
  });
});

describe("collectRecentlyReadFiles", () => {
  it("collects distinct read_file paths newest-first", () => {
    const dropped: AgentMessage[] = [
      ...readToolMessages(["first.txt"]),
      { role: "assistant", content: "analysis" },
      ...readToolMessages(["second.txt"]),
      ...readToolMessages(["first.txt", "third.txt"])
    ];
    // Distinct files ordered by how recently they were (first) read:
    // third.txt is newest, first.txt oldest — its re-read doesn't re-order.
    expect(collectRecentlyReadFiles(dropped)).toEqual(["third.txt", "second.txt", "first.txt"]);
  });

  it("prioritizes files that were written this run", () => {
    const dropped: AgentMessage[] = [
      ...readToolMessages(["a.txt"]),
      ...readToolMessages(["b.txt"]),
      ...readToolMessages(["c.txt"])
    ];
    const prioritized = collectRecentlyReadFiles(dropped, new Set(["c.txt"]));
    expect(prioritized[0]).toBe("c.txt");
    expect(prioritized).toContain("a.txt");
    expect(prioritized).toContain("b.txt");
  });

  it("normalizes ./ prefixes and case for the priority match", () => {
    const dropped: AgentMessage[] = [...readToolMessages(["./Src/App.tsx"])];
    const prioritized = collectRecentlyReadFiles(dropped, new Set(["src/app.tsx"]));
    expect(prioritized[0]).toBe("./Src/App.tsx");
  });

  it("caps the number of collected files", () => {
    const dropped: AgentMessage[] = [
      ...readToolMessages(Array.from({ length: 10 }, (_, i) => `f${i}.txt`))
    ];
    expect(collectRecentlyReadFiles(dropped).length).toBe(RESTORATION_MAX_FILES);
  });

  it("ignores non-read_file tool results", () => {
    const dropped: AgentMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c0", name: "web_search", parameters: { query: "test" } }]
      },
      {
        role: "tool",
        content: "[]",
        toolResults: [{ success: true, output: "hits", data: { results: [] } }]
      }
    ];
    expect(collectRecentlyReadFiles(dropped)).toEqual([]);
  });

  it("ignores tool results with no preceding assistant tool call", () => {
    const dropped: AgentMessage[] = [
      {
        role: "tool",
        content: "[]",
        toolResults: [{ success: true, output: "orphan", data: { path: "orphan.txt" } }]
      }
    ];
    expect(collectRecentlyReadFiles(dropped)).toEqual([]);
  });
});

describe("buildFileRestorationMessages", () => {
  it("re-reads files from disk and emits system messages with current state", async () => {
    await writeFile(join(workspaceRoot, "live.txt"), "line1\nline2", "utf-8");
    const messages = await buildFileRestorationMessages(["live.txt"], workspaceRoot, 10_000);

    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("[File restored after context compaction");
    expect(messages[0].content).toContain("path: live.txt");
    expect(messages[0].content).toContain("line1\nline2");
    expect(messages[0].content).toContain("lines: 2");
  });

  it("skips missing files silently", async () => {
    const messages = await buildFileRestorationMessages(["nope.txt"], workspaceRoot, 10_000);
    expect(messages).toEqual([]);
  });

  it("truncates restored content to the char budget", async () => {
    await writeFile(join(workspaceRoot, "big.txt"), "x".repeat(5_000), "utf-8");
    const messages = await buildFileRestorationMessages(["big.txt"], workspaceRoot, 1_000);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toContain("restored content truncated at 1000 chars");
  });

  it("stops once the remaining budget cannot fit a useful restoration", async () => {
    await writeFile(join(workspaceRoot, "one.txt"), "a".repeat(250), "utf-8");
    await writeFile(join(workspaceRoot, "two.txt"), "b".repeat(250), "utf-8");
    // Budget 300: file one is restored in full (250 chars), leaving 50 —
    // below the useful-restoration floor, so file two is skipped.
    const messages = await buildFileRestorationMessages(["one.txt", "two.txt"], workspaceRoot, 300);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toContain("aaa");
  });

  it("restores nothing when the total budget is below the useful floor", async () => {
    await writeFile(join(workspaceRoot, "tiny.txt"), "content", "utf-8");
    expect(await buildFileRestorationMessages(["tiny.txt"], workspaceRoot, 50)).toEqual([]);
  });

  it("returns nothing without a workspace root", async () => {
    expect(await buildFileRestorationMessages(["x.txt"], "", 1_000)).toEqual([]);
  });
});
