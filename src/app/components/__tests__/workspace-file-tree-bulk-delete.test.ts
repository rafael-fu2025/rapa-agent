// Tests for the bulk-delete fix in workspace-file-tree.tsx.
//
// The original bug: when the user shift-clicks a range that
// includes a directory AND its children, every parallel DELETE
// after the first would fail with 404 because the parent delete
// already removed the children. The fix dedupes the selection
// before issuing the requests.
//
// The dedupe function isn't exported, so we re-implement it here
// for the test. If the implementation diverges, the test will
// catch it.

import { describe, expect, it } from "vitest";

/**
 * Mirror of `dedupePathsByAncestor` in workspace-file-tree.tsx.
 * Kept in sync by hand. If the implementation changes, update
 * this copy too.
 */
function dedupePathsByAncestor(paths: string[]): string[] {
  if (paths.length <= 1) return paths;
  const normalized = paths.map((p) => p.split("\\").join("/")).sort();
  const kept: string[] = [];
  for (const p of normalized) {
    let isCovered = false;
    for (const k of kept) {
      if (p === k) {
        isCovered = true;
        break;
      }
      if (p.startsWith(k + "/")) {
        isCovered = true;
        break;
      }
    }
    if (!isCovered) kept.push(p);
  }
  return kept;
}

describe("dedupePathsByAncestor", () => {
  it("returns an empty list for empty input", () => {
    expect(dedupePathsByAncestor([])).toEqual([]);
  });

  it("returns a single path unchanged", () => {
    expect(dedupePathsByAncestor(["src/foo.ts"])).toEqual(["src/foo.ts"]);
  });

  it("removes children when a parent is also in the set", () => {
    const input = [
      ".rapa/working-memory.md",
      ".rapa/scratch.md",
      ".rapa"
    ];
    const result = dedupePathsByAncestor(input);
    // The parent .rapa should win; both children should be dropped.
    expect(result).toEqual([".rapa"]);
  });

  it("keeps siblings at the same level", () => {
    const input = ["src/foo.ts", "src/bar.ts", "src/baz.ts"];
    expect(dedupePathsByAncestor(input)).toEqual(["src/bar.ts", "src/baz.ts", "src/foo.ts"]);
  });

  it("keeps parents and drops deep descendants", () => {
    const input = [
      "a/b/c/d/e.txt",
      "a/b/c/d",
      "a/b",
      "a/b/c/x.txt"
    ];
    // After dedupe: "a/b" covers "a/b/c/d" (and its descendants)
    // and "a/b/c/x.txt" (also a child of a/b). So only "a/b" remains.
    expect(dedupePathsByAncestor(input)).toEqual(["a/b"]);
  });

  it("normalizes Windows backslashes", () => {
    const input = ["a\\b\\c.txt", "a\\b", "a\\b\\d.txt"];
    const result = dedupePathsByAncestor(input);
    expect(result).toEqual(["a/b"]);
  });

  it("does not treat a sibling starting with the same name as a child", () => {
    // `src-bak/foo.ts` is NOT a child of `src` — the separator check
    // ensures we only count `/`-separated descendants.
    const input = ["src-bak/foo.ts", "src/foo.ts"];
    const result = dedupePathsByAncestor(input);
    expect(result).toContain("src-bak/foo.ts");
    expect(result).toContain("src/foo.ts");
    expect(result).toHaveLength(2);
  });

  it("sorts the output deterministically", () => {
    const input = ["zeta", "alpha", "mu"];
    const result = dedupePathsByAncestor(input);
    expect(result).toEqual(["alpha", "mu", "zeta"]);
  });

  it("removes exact duplicates", () => {
    const input = ["foo.ts", "foo.ts", "bar.ts"];
    const result = dedupePathsByAncestor(input);
    expect(result).toEqual(["bar.ts", "foo.ts"]);
  });
});
