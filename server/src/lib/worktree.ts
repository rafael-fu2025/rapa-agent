// Run worktrees — git worktree-per-run isolation (Item 3).
//
// When the user opts in, an agent run executes inside a dedicated git
// worktree (`<repoRoot>/.rapa/worktrees/run-<short8>` on branch
// `rapa/run-<short8>`) instead of the original checkout. The run can
// freely modify files; afterwards the user merges the branch back or
// discards it. All git access goes through execFile WITHOUT a shell —
// the same pattern as tools/git.ts — so refs and paths can never break
// out into command execution.
//
// Branches carry no creation date, so age-based cleanup uses the run
// rows instead: `sweepStaleWorktrees` in lib/agent-run-store.ts queries
// terminal runs whose worktree metadata is older than 7 days and calls
// `discardRunWorktree` here.

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

import { getSanitizedEnv } from "../tools/shell.js";

const execFileAsync = promisify(execFile);

/** Info for one run worktree — the shape persisted on the AgentRun row. */
export type RunWorktreeInfo = {
  branch: string;
  path: string;
  originalRoot: string;
};

/** RunWorktreeInfo plus the lifecycle status stored alongside it. */
export type StoredWorktreeMetadata = RunWorktreeInfo & {
  status?: "active" | "merged" | "discarded";
};

type GitRunResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; error: string };

const GIT_TIMEOUT_MS = 30_000;

/**
 * execFile-based git invocation — no shell, 8MB buffer, secret-stripped
 * environment (mirrors tools/git.ts runGit so the same sanitization rules
 * apply to every child process the backend spawns).
 */
async function runGit(args: string[], cwd: string, timeout = GIT_TIMEOUT_MS): Promise<GitRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024 * 8,
      windowsHide: true,
      env: { ...getSanitizedEnv(), LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Git command failed";
    return { ok: false, error: message };
  }
}

/**
 * Reduce a run id to a branch-safe token: cuids only contain
 * [a-z0-9], but generated seeds (uuid hex, timestamps) and future id
 * formats may not — strip anything outside [a-zA-Z0-9-] and cap length.
 */
export function sanitizeBranchToken(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned.slice(0, 32);
}

/** True when `dir` is inside a git working tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  const result = await runGit(["rev-parse", "--is-inside-work-tree"], dir);
  return result.ok && result.stdout.trim() === "true";
}

/**
 * True only when `dir` IS a git repository root (its own .git), not a
 * subfolder of one. `git rev-parse` walks up the tree, so an empty workspace
 * under an accidental parent repo (live case: a repo at C:\Users\Rafael
 * tracking the xampp projects) reports "inside a work tree" — creating a
 * worktree there checked out the parent repo's entire tracked tree into the
 * empty workspace. Worktree isolation is only meaningful when the workspace
 * is the repo being isolated, so this is the eligibility check.
 */
export async function isGitRepoRoot(dir: string): Promise<boolean> {
  if (!(await isGitRepo(dir))) return false;
  const toplevel = await runGit(["rev-parse", "--show-toplevel"], dir);
  if (!toplevel.ok) return false;
  const resolvedRoot = resolvePath(toplevel.stdout.trim());
  const resolvedDir = resolvePath(dir);
  // Windows paths are case-insensitive; compare case-normalized there.
  return process.platform === "win32"
    ? resolvedRoot.toLowerCase() === resolvedDir.toLowerCase()
    : resolvedRoot === resolvedDir;
}

/**
 * Create an isolated worktree for one agent run:
 *   branch: rapa/run-<short8>   path: <repoRoot>/.rapa/worktrees/run-<short8>
 *
 * `id` is the run id when available, or a generated seed at request-
 * prepare time (the run row does not exist yet). On a branch/path
 * already-exists collision the creation is retried once with a `-2`
 * suffix; a second collision throws so the caller can fall back to the
 * original workspace (never fail the run because of isolation setup).
 */
export async function createRunWorktree(repoRoot: string, id: string): Promise<RunWorktreeInfo> {
  const short8 = sanitizeBranchToken(id).slice(0, 8) || "run";
  const attempts: Array<{ suffix: string }> = [{ suffix: "" }, { suffix: "-2" }];

  // The worktrees parent directory must exist before `git worktree add`
  // (git creates the leaf only on some versions).
  await mkdir(join(repoRoot, ".rapa", "worktrees"), { recursive: true });

  let lastError = "git worktree add failed";
  for (const attempt of attempts) {
    const branch = `rapa/run-${short8}${attempt.suffix}`;
    const path = join(repoRoot, ".rapa", "worktrees", `run-${short8}${attempt.suffix}`);
    const result = await runGit(["worktree", "add", "-b", branch, path, "HEAD"], repoRoot);
    if (result.ok) {
      return { branch, path, originalRoot: repoRoot };
    }
    lastError = result.error;
    if (!/already exists/i.test(result.error)) {
      throw new Error(`git worktree add failed: ${result.error}`);
    }
  }
  throw new Error(`git worktree add failed after retry: ${lastError}`);
}

/**
 * True for a `git status --porcelain` line that only reports the run-
 * worktree infrastructure (`.rapa/worktrees/**`). The worktree working
 * directories live INSIDE the repo, so they always show up as untracked
 * in the original checkout — they are not user work and must not trip
 * the dirty-checkout merge guard.
 */
export function isWorktreeInfraStatusLine(line: string): boolean {
  if (!line.trim()) return false;
  // Porcelain v1: "XY <path>"; renames: "XY <orig> -> <new>".
  const pathPart = line.length > 3 ? line.slice(3) : "";
  return pathPart.split(" -> ").some((candidate) => {
    const normalized = candidate.replace(/^"/, "").replace(/"$/, "").replace(/\\/g, "/");
    return normalized === ".rapa/worktrees" || normalized.startsWith(".rapa/worktrees/");
  });
}

/**
 * Merge a completed run's branch back into the original checkout with
 * --no-ff (so the run's work stays one reviewable merge commit).
 *
 * Guards:
 *   - the ORIGINAL checkout must be clean (`git status --porcelain`
 *     empty apart from the `.rapa/worktrees` infrastructure) — merging
 *     into a dirty tree could interleave with the user's uncommitted work;
 *   - a conflicted merge is aborted immediately, leaving the original
 *     checkout untouched.
 */
export async function mergeRunWorktree(
  repoRoot: string,
  worktree: { branch: string }
): Promise<{ ok: boolean; message: string }> {
  // Exclude the worktree area via pathspec AND filter the remaining lines
  // (the pathspec prevents `?? .rapa/` collapsing; the filter is belt and
  // braces for exotic porcelain quoting).
  const status = await runGit(
    ["status", "--porcelain", "--", ".", ":(exclude).rapa/worktrees"],
    repoRoot
  );
  if (!status.ok) {
    return { ok: false, message: `Could not read the original checkout's status: ${status.error}` };
  }
  const dirtyLines = status.stdout.split("\n").filter((line) => !isWorktreeInfraStatusLine(line));
  if (dirtyLines.some((line) => line.trim().length > 0)) {
    return { ok: false, message: "original checkout has uncommitted changes — commit or stash first" };
  }

  const merge = await runGit(["merge", "--no-ff", worktree.branch], repoRoot);
  if (merge.ok) {
    return { ok: true, message: `Merged ${worktree.branch} into the workspace` };
  }

  const combined = merge.error;
  if (/conflict/i.test(combined)) {
    await runGit(["merge", "--abort"], repoRoot);
    return { ok: false, message: "merge conflict — aborted, resolve manually" };
  }
  return { ok: false, message: `Merge failed: ${combined.slice(0, 500)}` };
}

/**
 * Remove a run worktree and delete its branch. Best-effort per step: a
 * worktree that is already gone (pruned, deleted by hand) must not stop
 * the branch deletion.
 */
export async function discardRunWorktree(
  repoRoot: string,
  worktree: { branch: string; path: string }
): Promise<{ ok: boolean; message: string }> {
  const errors: string[] = [];

  const remove = await runGit(["worktree", "remove", "--force", worktree.path], repoRoot);
  if (!remove.ok && !/not a working tree|does not exist|is not a working tree/i.test(remove.error)) {
    errors.push(`worktree remove: ${remove.error}`);
    // Recover from a stale registration so the branch step can proceed.
    await runGit(["worktree", "prune"], repoRoot);
  }

  const deleteBranch = await runGit(["branch", "-D", worktree.branch], repoRoot);
  if (!deleteBranch.ok) {
    errors.push(`branch delete: ${deleteBranch.error}`);
  }

  if (errors.length > 0) {
    return { ok: false, message: `Discard failed — ${errors.join("; ")}` };
  }
  return { ok: true, message: `Discarded worktree ${worktree.branch}` };
}

/**
 * Parse the worktree metadata stored on an AgentRun row (Json column).
 * Returns null for absent/malformed values so callers can 404 cleanly.
 */
export function parseWorktreeMetadata(value: unknown): StoredWorktreeMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const branch = typeof record.branch === "string" ? record.branch : "";
  const path = typeof record.path === "string" ? record.path : "";
  const originalRoot = typeof record.originalRoot === "string" ? record.originalRoot : "";
  if (!branch || !path || !originalRoot) return null;
  const status = record.status === "merged" || record.status === "discarded" || record.status === "active"
    ? record.status
    : undefined;
  return { branch, path, originalRoot, ...(status ? { status } : {}) };
}
