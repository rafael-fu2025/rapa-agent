// Worktree-per-run isolation (Item 3) — real-git integration tests.
//
// The suite runs against a throwaway repository in the OS temp dir
// (git init + one commit). If git is not on PATH the whole suite skips
// gracefully instead of failing the gate — git is an optional runtime
// dependency for worktree isolation.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createRunWorktree,
  discardRunWorktree,
  isGitRepo,
  isGitRepoRoot,
  isWorktreeInfraStatusLine,
  mergeRunWorktree,
  parseWorktreeMetadata,
  sanitizeBranchToken
} from "../worktree.js";

const execFileAsync = promisify(execFile);

let gitAvailable = false;
try {
  await execFileAsync("git", ["--version"]);
  gitAvailable = true;
} catch {
  gitAvailable = false;
}

const suite = gitAvailable ? describe : describe.skip;

let repoRoot = "";
const createdDirs: string[] = [];

async function git(args: string[], cwd: string = repoRoot): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

beforeAll(async () => {
  if (!gitAvailable) return;
  repoRoot = await mkdtemp(join(tmpdir(), "rapa-worktree-"));
  createdDirs.push(repoRoot);
  await git(["init"]);
  await git(["config", "user.email", "rapa@example.test"]);
  await git(["config", "user.name", "Rapa Test"]);
  await writeFile(join(repoRoot, "README.md"), "# base\n");
  await git(["add", "."]);
  await git(["commit", "-m", "init"]);
});

afterAll(async () => {
  for (const dir of createdDirs) {
    // Worktrees register metadata in the parent repo; discard before rm.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

suite("sanitizeBranchToken", () => {
  it("keeps cuid characters and strips everything else", () => {
    expect(sanitizeBranchToken("cmabc123def")).toBe("cmabc123def");
    expect(sanitizeBranchToken("abc_def.ghi")).toBe("abc-def-ghi");
    expect(sanitizeBranchToken("run:uuid/with~weird$$chars")).toBe("run-uuid-with-weird-chars");
  });

  it("caps the token length", () => {
    const token = sanitizeBranchToken("a".repeat(64));
    expect(token.length).toBeLessThanOrEqual(32);
  });

  it("trims leading and trailing dashes", () => {
    expect(sanitizeBranchToken("__leading__")).toBe("leading");
  });
});

suite("isGitRepo", () => {
  it("detects a git repository", async () => {
    expect(await isGitRepo(repoRoot)).toBe(true);
  });

  it("rejects a plain directory", async () => {
    const plain = await mkdtemp(join(tmpdir(), "rapa-notgit-"));
    createdDirs.push(plain);
    expect(await isGitRepo(plain)).toBe(false);
  });
});

suite("isGitRepoRoot", () => {
  it("accepts the repository root itself", async () => {
    expect(await isGitRepoRoot(repoRoot)).toBe(true);
  });

  it("rejects a subfolder of a repository — the live empty-workspace bug", async () => {
    // Live case: an "empty" workspace under an accidental parent repo (a
    // repo in the user's home directory tracking unrelated projects)
    // inherited that repo, and worktree creation checked out the parent's
    // entire tracked tree into the workspace. A subfolder must never
    // qualify as an isolation root.
    const sub = join(repoRoot, "empty-workspace");
    await mkdir(sub, { recursive: true });
    expect(await isGitRepo(sub)).toBe(true);
    expect(await isGitRepoRoot(sub)).toBe(false);
  });

  it("rejects a plain directory even when a parent is a repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "rapa-notgit-root-"));
    createdDirs.push(plain);
    expect(await isGitRepoRoot(plain)).toBe(false);
  });
});

suite("createRunWorktree", () => {
  it("creates a worktree on branch rapa/run-<short8> under .rapa/worktrees", async () => {
    const info = await createRunWorktree(repoRoot, "cmabc123def456");
    createdDirs.push(info.path);

    expect(info.branch).toBe("rapa/run-cmabc123");
    expect(info.originalRoot).toBe(repoRoot);
    expect(existsSync(join(info.path, "README.md"))).toBe(true);
    expect(info.path).toContain(join(".rapa", "worktrees"));

    // The branch exists and points at HEAD.
    const { stdout } = await execFileAsync("git", ["rev-parse", info.branch], { cwd: repoRoot });
    expect(stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("retries with a -2 suffix when the branch already exists", async () => {
    const first = await createRunWorktree(repoRoot, "collision01");
    createdDirs.push(first.path);
    const second = await createRunWorktree(repoRoot, "collision01");
    createdDirs.push(second.path);

    expect(second.branch).toBe(`${first.branch}-2`);
    expect(second.path).not.toBe(first.path);
    expect(existsSync(join(second.path, "README.md"))).toBe(true);
  });
});

suite("isWorktreeInfraStatusLine", () => {
  it("ignores untracked worktree infrastructure, nothing else", () => {
    expect(isWorktreeInfraStatusLine("?? .rapa/worktrees/")).toBe(true);
    expect(isWorktreeInfraStatusLine("?? .rapa/worktrees/run-abc12345")).toBe(true);
    expect(isWorktreeInfraStatusLine('?? ".rapa/worktrees/run-abc"')).toBe(true);
    expect(isWorktreeInfraStatusLine("?? .rapa\\worktrees\\run-abc")).toBe(true);
    expect(isWorktreeInfraStatusLine(" R old.txt -> .rapa/worktrees/run-x/new.txt")).toBe(true);
    expect(isWorktreeInfraStatusLine(" M src/app.ts")).toBe(false);
    expect(isWorktreeInfraStatusLine("?? .rapa/working-memory.md")).toBe(false);
    expect(isWorktreeInfraStatusLine("")).toBe(false);
  });
});

suite("mergeRunWorktree", () => {
  it("refuses when the original checkout has uncommitted changes", async () => {
    const info = await createRunWorktree(repoRoot, "mergedirty1");
    createdDirs.push(info.path);
    await writeFile(join(repoRoot, "dirty.txt"), "uncommitted\n");

    const result = await mergeRunWorktree(repoRoot, info);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("uncommitted changes");

    // Restore the clean state — later tests in this suite merge into the
    // same repo and the dirty guard must not fire for them.
    await rm(join(repoRoot, "dirty.txt"), { force: true });
  });

  it("merges a committed worktree branch back with --no-ff", async () => {
    const info = await createRunWorktree(repoRoot, "mergeok001");
    createdDirs.push(info.path);
    await writeFile(join(info.path, "feature.txt"), "from worktree\n");
    await git(["add", "."], info.path);
    await git(["commit", "-m", "worktree change"], info.path);

    const result = await mergeRunWorktree(repoRoot, info);
    expect(result.ok).toBe(true);
    expect(await readFile(join(repoRoot, "feature.txt"), "utf8")).toContain("from worktree");
  });

  it("aborts cleanly on a merge conflict", async () => {
    const info = await createRunWorktree(repoRoot, "conflict01");
    createdDirs.push(info.path);
    // Conflicting change in the worktree...
    await writeFile(join(info.path, "README.md"), "# worktree version\n");
    await git(["add", "."], info.path);
    await git(["commit", "-m", "worktree rewrites readme"], info.path);
    // ...and a different committed change to the same file in the original.
    await writeFile(join(repoRoot, "README.md"), "# original version\n");
    await git(["add", "."], repoRoot);
    await git(["commit", "-m", "original rewrites readme"], repoRoot);

    const result = await mergeRunWorktree(repoRoot, info);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("merge conflict");

    // The original checkout is untouched — no MERGE_HEAD left behind.
    const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: repoRoot });
    expect(status.stdout).not.toContain("UU");
    expect(await readFile(join(repoRoot, "README.md"), "utf8")).toContain("# original version");
  });
});

suite("discardRunWorktree", () => {
  it("removes the worktree directory and deletes the branch", async () => {
    const info = await createRunWorktree(repoRoot, "discard001");
    await writeFile(join(info.path, " stray.txt"), "x\n");

    const result = await discardRunWorktree(repoRoot, info);
    expect(result.ok).toBe(true);
    expect(existsSync(info.path)).toBe(false);

    const branchList = await execFileAsync("git", ["branch", "--list", info.branch], { cwd: repoRoot });
    expect(branchList.stdout.trim()).toBe("");
  });

  it("still deletes the branch when the worktree directory vanished", async () => {
    const info = await createRunWorktree(repoRoot, "vanish0001");
    await rm(info.path, { recursive: true, force: true });

    const result = await discardRunWorktree(repoRoot, info);
    expect(result.ok).toBe(true);
    const branchList = await execFileAsync("git", ["branch", "--list", info.branch], { cwd: repoRoot });
    expect(branchList.stdout.trim()).toBe("");
  });
});

suite("parseWorktreeMetadata", () => {
  it("parses a stored metadata object", () => {
    const parsed = parseWorktreeMetadata({
      branch: "rapa/run-abc",
      path: "C:/repo/.rapa/worktrees/run-abc",
      originalRoot: "C:/repo",
      status: "active"
    });
    expect(parsed).toEqual({
      branch: "rapa/run-abc",
      path: "C:/repo/.rapa/worktrees/run-abc",
      originalRoot: "C:/repo",
      status: "active"
    });
  });

  it("returns null for absent or malformed values", () => {
    expect(parseWorktreeMetadata(undefined)).toBeNull();
    expect(parseWorktreeMetadata(null)).toBeNull();
    expect(parseWorktreeMetadata("branch")).toBeNull();
    expect(parseWorktreeMetadata(["a"])).toBeNull();
    expect(parseWorktreeMetadata({ branch: "x" })).toBeNull();
    expect(parseWorktreeMetadata({ branch: 1, path: "p", originalRoot: "r" })).toBeNull();
  });

  it("defaults status to undefined for legacy rows without one", () => {
    const parsed = parseWorktreeMetadata({ branch: "b", path: "p", originalRoot: "r" });
    expect(parsed?.status).toBeUndefined();
  });
});

suite("worktree directory layout", () => {
  it("keeps worktrees inside the repo under .rapa/worktrees", async () => {
    const info = await createRunWorktree(repoRoot, "layout0001");
    createdDirs.push(info.path);
    const relative = info.path.slice(repoRoot.length + 1);
    const expectedPrefix = join(".rapa", "worktrees") + (process.platform === "win32" ? "\\" : "/");
    expect(relative.startsWith(expectedPrefix)).toBe(true);
  });
});
