// Regression tests for shell injection through git tools.
//
// runGit used to build `git ${args.join(" ")}` and pass it to exec (a shell).
// LLM-controlled values (commit refs, paths) could break out into arbitrary
// commands via `&`, `|`, `;`. It now uses execFile, which passes args directly
// to git with no shell — a hostile ref must produce a git error, not a
// executed command.

import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { beforeEach, describe, expect, it } from "vitest";

import { GitDiffTool, GitLogTool } from "./git.js";
import type { ToolExecutionContext } from "../lib/tools.js";

const execFile = promisify(execFileCb);

let workspaceRoot = "";
let context: ToolExecutionContext;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "rapa-git-"));
  await execFile("git", ["init"], { cwd: workspaceRoot });
  await writeFile(join(workspaceRoot, "a.txt"), "hello\n", "utf-8");
  await execFile("git", ["add", "."], { cwd: workspaceRoot });
  await execFile(
    "git",
    ["-c", "user.email=test@test.local", "-c", "user.name=Test", "commit", "-m", "init"],
    { cwd: workspaceRoot }
  );
  context = { workspaceRoot, userId: "u", conversationId: "c1" };
});

describe("git tools — no shell injection", () => {
  it("treats a hostile commit ref as a literal ref, never as shell syntax", async () => {
    const tool = new GitDiffTool();
    const result = await tool.execute(
      { commit: "HEAD & echo RAPA_PWNED_MARKER" },
      context
    );

    // git must reject the bogus ref as an unknown revision — the whole string
    // reached git as ONE literal argument. (execFile's error message echoes
    // the command line, so the marker can legitimately appear in `error`
    // there — but never in `output`, which is where a shell-executed
    // `echo RAPA_PWNED_MARKER` would land.)
    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("unknown revision");
    expect(result.output ?? "").not.toContain("RAPA_PWNED_MARKER");
  });

  it("treats a hostile path as a literal path", async () => {
    const tool = new GitDiffTool();
    const result = await tool.execute(
      { path: "a.txt & echo RAPA_PWNED_MARKER" },
      context
    );

    // A pathspec that matches nothing is a successful empty diff — what
    // matters is that no shell ran the trailing echo.
    expect(result.output ?? "").not.toContain("RAPA_PWNED_MARKER");
    expect(result.error ?? "").not.toContain("RAPA_PWNED_MARKER");
  });

  it("still serves legitimate refs and paths", async () => {
    const tool = new GitLogTool();
    const result = await tool.execute({ path: "a.txt" }, context);
    expect(result.success).toBe(true);
    expect(result.output ?? "").toContain("init");
  });
});
