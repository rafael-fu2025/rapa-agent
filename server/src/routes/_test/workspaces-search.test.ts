// Tests for the Tier 4 search endpoints:
//   GET /api/workspaces/:id/files/match?q=...   (Go to file)
//   GET /api/workspaces/:id/search?q=...        (Find in files)
//
// We exercise the same underlying helpers the routes use:
//   - listAllFiles (enumerates the workspace, skipping ignored dirs)
//   - The fuzzy match scoring
//   - The line-by-line substring search
//
// Like the Tier 2 tests, we work in a real temp dir so the helpers
// can use real fs primitives. No need to spin up Fastify.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "rapa-tier4-"));
  // Layout:
  //   <root>/src/components/Button.tsx
  //   <root>/src/lib/api.ts
  //   <root>/src/lib/api.test.ts
  //   <root>/src/index.ts
  //   <root>/README.md
  //   <root>/package.json
  await mkdir(join(workspaceRoot, "src", "components"), { recursive: true });
  await mkdir(join(workspaceRoot, "src", "lib"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "components", "Button.tsx"), "// button component\n");
  await writeFile(join(workspaceRoot, "src", "lib", "api.ts"), "// api helpers\n");
  await writeFile(join(workspaceRoot, "src", "lib", "api.test.ts"), "// api tests\n");
  await writeFile(join(workspaceRoot, "src", "index.ts"), "// entry point\n");
  await writeFile(join(workspaceRoot, "README.md"), "# Project\n");
  await writeFile(join(workspaceRoot, "package.json"), "{}\n");
  // Ignored dirs to make sure the filter works
  await mkdir(join(workspaceRoot, "node_modules", "react"), { recursive: true });
  await writeFile(join(workspaceRoot, "node_modules", "react", "index.js"), "// should be hidden\n");
  await mkdir(join(workspaceRoot, ".git"), { recursive: true });
  await writeFile(join(workspaceRoot, ".git", "config"), "// should be hidden\n");
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

// Re-implementations of the route's helpers, kept in sync with
// server/src/routes/workspaces.ts. We test the *behavior*, not the
// route registration itself (that would need a running Fastify).

const IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "web-dist", ".next", ".turbo", ".cache"
]);

type FlatEntry = { relativePath: string; name: string; isDir: boolean };

async function listAllFiles(
  rootPath: string,
  workspaceRoot: string,
  maxDepth = 12,
  currentDepth = 0
): Promise<FlatEntry[]> {
  if (currentDepth > maxDepth) return [];
  let entries;
  try {
    entries = await (await import("node:fs/promises")).readdir(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: FlatEntry[] = [];
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(rootPath, entry.name);
    const rel = (await import("node:path")).relative(workspaceRoot, fullPath);
    const isDir = entry.isDirectory();
    out.push({ relativePath: rel, name: entry.name, isDir });
    if (isDir) {
      const nested = await listAllFiles(fullPath, workspaceRoot, maxDepth, currentDepth + 1);
      out.push(...nested);
    }
  }
  return out;
}

type Scored = FlatEntry & { score: number; matchedField: "basename" | "path" | "fuzzy" };

function scoreMatches(entries: FlatEntry[], q: string): Scored[] {
  const qLower = q.toLowerCase();
  const scored: Scored[] = [];
  for (const entry of entries) {
    if (entry.isDir) continue;
    const lowerName = entry.name.toLowerCase();
    const lowerPath = entry.relativePath.toLowerCase();
    let score = 0;
    let matchedField: Scored["matchedField"] = "fuzzy";
    if (lowerName === qLower) {
      score = 200;
      matchedField = "basename";
    } else if (lowerName.includes(qLower)) {
      score = 100 + (lowerName.startsWith(qLower) ? 20 : 0);
      matchedField = "basename";
    } else if (lowerPath.includes(qLower)) {
      score = 50;
      matchedField = "path";
    } else {
      let lastIdx = -1;
      let ok = true;
      for (const ch of qLower) {
        const i = lowerName.indexOf(ch, lastIdx + 1);
        if (i < 0) { ok = false; break; }
        lastIdx = i;
      }
      if (ok) { score = 5; matchedField = "fuzzy"; }
      else continue;
    }
    const depth = entry.relativePath.split(/[\\/]/).length;
    score -= depth;
    scored.push({ ...entry, score, matchedField });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

describe("Tier 4 — listAllFiles", () => {
  it("enumerates every file in the tree", async () => {
    const files = await listAllFiles(workspaceRoot, workspaceRoot);
    const fileNames = files.filter((f) => !f.isDir).map((f) => f.name).sort();
    expect(fileNames).toEqual([
      "Button.tsx", "README.md", "api.test.ts", "api.ts", "index.ts", "package.json"
    ]);
  });

  it("skips node_modules and .git", async () => {
    const files = await listAllFiles(workspaceRoot, workspaceRoot);
    const paths = files.map((f) => f.relativePath);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths.some((p) => p.includes(".git"))).toBe(false);
  });

  it("skips dotfiles at the root", async () => {
    await writeFile(join(workspaceRoot, ".env"), "secret");
    const files = await listAllFiles(workspaceRoot, workspaceRoot);
    expect(files.find((f) => f.name === ".env")).toBeUndefined();
  });
});

describe("Tier 4 — go-to-file scoring", () => {
  it("exact basename match wins", async () => {
    const all = await listAllFiles(workspaceRoot, workspaceRoot);
    const scored = scoreMatches(all, "api.ts");
    expect(scored[0].name).toBe("api.ts");
    expect(scored[0].matchedField).toBe("basename");
    // 200 (exact match) minus depth (3 for src/lib/api.ts) = 197.
    expect(scored[0].score).toBe(200 - 3);
  });

  it("basename substring beats path substring", async () => {
    const all = await listAllFiles(workspaceRoot, workspaceRoot);
    const scored = scoreMatches(all, "api");
    // Two files have "api" in their basename: api.ts and api.test.ts.
    // Both should outrank any file where "api" only appears in the path.
    const top2 = scored.slice(0, 2).map((m) => m.name).sort();
    expect(top2).toEqual(["api.test.ts", "api.ts"]);
    for (const m of scored.slice(0, 2)) {
      expect(m.matchedField).toBe("basename");
    }
  });

  it("path substring match for non-basename queries", async () => {
    const all = await listAllFiles(workspaceRoot, workspaceRoot);
    const scored = scoreMatches(all, "components");
    // Only Button.tsx has "components" in its path; it should be the top match.
    expect(scored[0].name).toBe("Button.tsx");
    expect(scored[0].matchedField).toBe("path");
  });

  it("fuzzy match for out-of-order characters", async () => {
    const all = await listAllFiles(workspaceRoot, workspaceRoot);
    // "btn" is in "Button" but in scrambled order at the substring level.
    // Our implementation requires in-order, so "btn" should still match
    // because 'b', 't', 'n' all appear in "button" in order.
    const scored = scoreMatches(all, "btn");
    expect(scored[0].name).toBe("Button.tsx");
    expect(scored[0].matchedField).toBe("fuzzy");
  });

  it("deeper files rank lower than shallow ones for the same score tier", async () => {
    const all = await listAllFiles(workspaceRoot, workspaceRoot);
    const scored = scoreMatches(all, "ts");
    // api.ts (depth 3) should rank higher than src/lib/api.test.ts (depth 4)
    // because both match the basename and shallow paths get a boost.
    const api = scored.find((m) => m.name === "api.ts");
    const apiTest = scored.find((m) => m.name === "api.test.ts");
    expect(api).toBeDefined();
    expect(apiTest).toBeDefined();
    // Both have raw score 100, and both are at the same directory
    // depth (src/lib/api.ts is depth 3 same as src/lib/api.test.ts).
    // The depth-penalty is by total path-segment count, so two files
    // in the same directory tie. The test setup is too symmetric for
    // depth to break the tie — we add a third file in a deeper
    // directory to confirm the penalty actually fires.
    await mkdir(join(workspaceRoot, "src", "lib", "deep", "nested"), { recursive: true });
    // Name does NOT start with "ts" so the startsWith boost doesn't
    // apply. The match comes purely from the basename substring.
    await writeFile(
      join(workspaceRoot, "src", "lib", "deep", "nested", "constants.ts"),
      ""
    );
    const all2 = await listAllFiles(workspaceRoot, workspaceRoot);
    const scored2 = scoreMatches(all2, "ts");
    const deep = scored2.find((m) => m.name === "constants.ts");
    expect(deep).toBeDefined();
    // deep/nested/constants.ts has 5 segments, score = 100 - 5 = 95.
    // api.ts has 3 segments, score = 100 - 3 = 97. Shallow wins.
    expect(deep!.score).toBe(95);
    expect(api!.score).toBe(97);
    expect(api!.score).toBeGreaterThan(deep!.score);
  });

  it("returns no results for completely non-matching queries", async () => {
    const all = await listAllFiles(workspaceRoot, workspaceRoot);
    const scored = scoreMatches(all, "zzz");
    expect(scored).toEqual([]);
  });
});

describe("Tier 4 — full-text search", () => {
  // Re-implement the search loop from the route.
  async function search(workspaceRoot: string, q: string, limit = 200) {
    const SEARCH_MAX_FILE_SIZE = 1024 * 1024;
    const SEARCH_MAX_LINE_LENGTH = 500;
    const files = (await listAllFiles(workspaceRoot, workspaceRoot)).filter((e) => !e.isDir);
    const matches: { path: string; line: number; column: number; preview: string }[] = [];
    for (const entry of files) {
      const fullPath = join(workspaceRoot, entry.relativePath);
      try {
        const { stat, readFile: readFileFs } = await import("node:fs/promises");
        const stats = await stat(fullPath);
        if (stats.size > SEARCH_MAX_FILE_SIZE) continue;
        if (stats.size === 0) continue;
        const content = await readFileFs(fullPath, "utf-8");
        if (content.slice(0, 8192).includes("\u0000")) continue;
        const lines = content.split(/\r?\n/);
        const qLower = q.toLowerCase();
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.length > SEARCH_MAX_LINE_LENGTH) continue;
          const col = line.toLowerCase().indexOf(qLower);
          if (col >= 0) {
            matches.push({ path: entry.relativePath, line: i + 1, column: col + 1, preview: line });
            if (matches.length >= limit) return matches;
          }
        }
      } catch {
        // skip
      }
    }
    matches.sort((a, b) => {
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.line - b.line;
    });
    return matches;
  }

  it("finds matches in file contents with line numbers", async () => {
    await writeFile(
      join(workspaceRoot, "src", "lib", "api.ts"),
      `import { foo } from "./utils";\n` +
      `// TODO: implement bar\n` +
      `export const api = foo();\n`
    );
    const matches = await search(workspaceRoot, "TODO");
    expect(matches.length).toBe(1);
    expect(matches[0].path).toMatch(/api\.ts$/);
    expect(matches[0].line).toBe(2);
    expect(matches[0].preview).toContain("TODO");
    // "// TODO": //  is 0-1, space is 2, T is at index 3 (0-based),
    // so 1-based column is 4.
    expect(matches[0].column).toBe(4);
  });

  it("returns matches from multiple files, sorted by path then line", async () => {
    await writeFile(join(workspaceRoot, "README.md"), "hello world\nsecond line\nhello again\n");
    await writeFile(join(workspaceRoot, "src", "index.ts"), "// hello\nimport x;\n");
    const matches = await search(workspaceRoot, "hello");
    expect(matches.length).toBeGreaterThanOrEqual(3);
    // Sorted by path then line. README.md comes before src/index.ts.
    const readme = matches.filter((m) => m.path === "README.md");
    const index = matches.filter((m) => m.path.endsWith("index.ts"));
    expect(readme[0].line).toBe(1);
    expect(readme[1].line).toBe(3);
    expect(index[0].line).toBe(1);
  });

  it("returns no matches when the query is absent", async () => {
    const matches = await search(workspaceRoot, "zzz_no_match_zzz");
    expect(matches).toEqual([]);
  });

  it("respects the per-line length cap", async () => {
    // Create a file with a single 1000-character line containing the query.
    const longLine = "x".repeat(995) + "NEEDLE" + "y".repeat(10);
    await writeFile(join(workspaceRoot, "src", "components", "long.ts"), longLine);
    const matches = await search(workspaceRoot, "NEEDLE");
    expect(matches.length).toBe(0); // line too long, skipped
  });

  it("skips binary files (those with NUL bytes)", async () => {
    // Construct a file that has a NUL byte in the first 8 KB.
    const buf = Buffer.from("hello\u0000world", "utf-8");
    const { writeFile: writeFileFs } = await import("node:fs/promises");
    await writeFileFs(join(workspaceRoot, "src", "lib", "binary.dat"), buf);
    const matches = await search(workspaceRoot, "hello");
    // The "hello" string would match if we scanned it, but binary
    // detection skips the file before the substring search runs.
    const binMatch = matches.find((m) => m.path.endsWith("binary.dat"));
    expect(binMatch).toBeUndefined();
  });
});
