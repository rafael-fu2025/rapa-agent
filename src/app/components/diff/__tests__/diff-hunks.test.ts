import { describe, expect, it } from "vitest";

import {
  computeDiffStats,
  computeHunks,
  extractDiffFromResult,
  extractDiffs,
  hashEntry
} from "../diff-hunks";
import type { AgentStep } from "../../../../lib/agent-api";

function stepWithEditData(data: Record<string, unknown>, toolName = "edit_file"): AgentStep {
  return {
    iteration: 3,
    toolCalls: [{ id: "call-1", name: toolName, parameters: {} }],
    toolResults: [{ success: true, data }],
    timestamp: new Date().toISOString()
  };
}

describe("computeHunks", () => {
  it("groups a single change with surrounding context and correct line numbers", () => {
    const before = "a\nb\nc\nd\ne\nf\ng\n";
    const after = "a\nb\nX\nd\ne\nf\ng\n";

    const hunks = computeHunks(before, after);

    expect(hunks).toHaveLength(1);
    const [hunk] = hunks;
    // 2 leading ctx + del/add pair + 3 trailing ctx (capped).
    expect(hunk.header).toBe("@@ -1,6 +1,6 @@");
    expect(hunk.lines.map((line) => line.type)).toEqual([
      "ctx", "ctx", "del", "add", "ctx", "ctx", "ctx"
    ]);
    expect(hunk.lines[2]).toMatchObject({ type: "del", oldLine: 3, text: "c" });
    expect(hunk.lines[3]).toMatchObject({ type: "add", newLine: 3, text: "X" });
    expect(hunk.lines[4]).toMatchObject({ type: "ctx", oldLine: 4, newLine: 4, text: "d" });
  });

  it("returns an empty array for identical inputs", () => {
    expect(computeHunks("same\ncontent\n", "same\ncontent\n")).toEqual([]);
  });

  it("splits far-apart changes into separate hunks", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    const before = `${lines.join("\n")}\n`;
    const afterLines = [...lines];
    afterLines[3] = "CHANGED-EARLY";
    afterLines[20] = "CHANGED-LATE";
    const after = `${afterLines.join("\n")}\n`;

    const hunks = computeHunks(before, after);

    expect(hunks).toHaveLength(2);
    for (const hunk of hunks) {
      // One del + one add per changed line, padded by exactly 3 ctx
      // lines on each side (both changes sit far from the file edges).
      const changedCount = hunk.lines.filter((line) => line.type !== "ctx").length;
      expect(changedCount).toBe(2);
      const firstChange = hunk.lines.findIndex((line) => line.type !== "ctx");
      const lastChange = hunk.lines.length - 1 - [...hunk.lines].reverse().findIndex((line) => line.type !== "ctx");
      expect(firstChange).toBe(3);
      expect(hunk.lines.length - 1 - lastChange).toBe(3);
    }
    expect(hunks[0].lines.some((line) => line.text === "CHANGED-EARLY")).toBe(true);
    expect(hunks[1].lines.some((line) => line.text === "CHANGED-LATE")).toBe(true);
  });

  it("handles a pure addition at the end of the file", () => {
    const hunks = computeHunks("one\ntwo\n", "one\ntwo\nthree\n");

    expect(hunks).toHaveLength(1);
    const last = hunks[0].lines[hunks[0].lines.length - 1];
    expect(last).toMatchObject({ type: "add", newLine: 3, text: "three" });
  });
});

describe("computeDiffStats", () => {
  it("counts added and removed lines", () => {
    expect(computeDiffStats("a\nb\nc\n", "a\nX\nY\nc\n")).toEqual({ added: 2, removed: 1 });
    expect(computeDiffStats("", "fresh\n")).toEqual({ added: 1, removed: 0 });
  });
});

describe("extractDiffs", () => {
  it("pulls before/after from edit tool result previews", () => {
    const steps = [
      stepWithEditData({
        path: "src/a.ts",
        preview: { before: "old\n", after: "new\n" },
        lineRange: { start: 1, end: 1 },
        matchStrategy: "exact"
      })
    ];

    const diffs = extractDiffs(steps);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      id: "3-call-1",
      path: "src/a.ts",
      before: "old\n",
      after: "new\n",
      lineStart: 1,
      lineEnd: 1,
      matchStrategy: "exact"
    });
  });

  it("skips non-edit tools, failed results, and non-object data", () => {
    const notEdit = stepWithEditData({ path: "x", preview: { before: "a", after: "b" } }, "read_file");
    const failed = {
      ...stepWithEditData({ path: "x", preview: { before: "a", after: "b" } }),
      toolResults: [{ success: false, data: { path: "x" } }]
    } satisfies AgentStep;
    const noData = stepWithEditData("just a string" as unknown as Record<string, unknown>);

    expect(extractDiffs([notEdit, failed, noData])).toEqual([]);
  });
});

describe("extractDiffFromResult", () => {
  it("returns null for missing or pathless data", () => {
    expect(extractDiffFromResult(null, "t", 0)).toBeNull();
    expect(extractDiffFromResult({ preview: { before: "a", after: "b" } }, "t", 0)).toBeNull();
  });

  it("reads the diff.{before,after} shape as a fallback", () => {
    const entry = extractDiffFromResult({ path: "f.ts", diff: { before: "a\n", after: "b\n" } }, "t", 2);
    expect(entry).toMatchObject({ path: "f.ts", before: "a\n", after: "b\n", id: "2-t" });
  });
});

describe("hashEntry", () => {
  it("is stable and sensitive to content changes", () => {
    const entry = { id: "1", path: "a.ts", before: "x\n", after: "y\n" };
    expect(hashEntry(entry)).toBe(hashEntry({ ...entry, id: "other" }));
    expect(hashEntry(entry)).not.toBe(hashEntry({ ...entry, after: "z\n" }));
  });

  it("falls back to the raw preview when no before/after data exists", () => {
    const raw = { id: "1", path: "a.ts", before: "", after: "", rawPreview: "diff --git a" };
    expect(hashEntry(raw)).not.toBe(hashEntry({ id: "1", path: "a.ts", before: "", after: "" }));
  });
});
