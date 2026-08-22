// Regression tests: edit_file / append_file must use the symlink-safe
// workspace boundary check. The lexical check let a symlink (or junction)
// inside the workspace pointing outside turn these write tools into
// arbitrary-file-write beyond the workspace root.

import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { EditFileTool, AppendFileTool } from "./edit-file.js";
import { clearRealpathCache } from "./filesystem.js";
import type { ToolExecutionContext } from "../lib/tools.js";

let workspaceRoot = "";
let outsideRoot = "";
let base = "";
const createdSymlinks: string[] = [];
let symlinksSupported = false;

beforeAll(async () => {
  const probe = join(tmpdir(), `rapa-edit-symlink-probe-${process.pid}`);
  try {
    await symlink(probe + ".target", probe, "file");
    symlinksSupported = true;
    await rm(probe, { force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    symlinksSupported = code !== "EPERM" && code !== "ENOSYS" && code !== "EACCES";
  }
});

beforeEach(async () => {
  clearRealpathCache();
  base = await mkdtemp(join(tmpdir(), "rapa-edit-test-"));
  workspaceRoot = join(base, "workspace");
  outsideRoot = join(base, "outside");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "safe.txt"), "hello world");
  await writeFile(join(outsideRoot, "secret.txt"), "do not touch me");
});

afterEach(async () => {
  clearRealpathCache();
  for (const target of createdSymlinks.splice(0)) {
    await rm(target, { force: true }).catch(() => undefined);
  }
  await rm(base, { recursive: true, force: true });
});

function context(): ToolExecutionContext {
  return { workspaceRoot, userId: "u", conversationId: "c1" };
}

describe("edit_file / append_file — symlink escape", () => {
  it("edit_file refuses to follow a symlink pointing outside the workspace", async () => {
    if (!symlinksSupported) return;
    await symlink(join(outsideRoot, "secret.txt"), join(workspaceRoot, "leak.txt"), "file");
    createdSymlinks.push(join(workspaceRoot, "leak.txt"));

    const result = await new EditFileTool().execute(
      { path: "leak.txt", oldText: "do not", newText: "PWNED" },
      context()
    );

    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("outside workspace");
    // The target file must be untouched.
    expect(await readFile(join(outsideRoot, "secret.txt"), "utf-8")).toBe("do not touch me");
  });

  it("append_file refuses to follow a symlink pointing outside the workspace", async () => {
    if (!symlinksSupported) return;
    await symlink(join(outsideRoot, "secret.txt"), join(workspaceRoot, "leak2.txt"), "file");
    createdSymlinks.push(join(workspaceRoot, "leak2.txt"));

    const result = await new AppendFileTool().execute(
      { path: "leak2.txt", content: "APPENDED" },
      context()
    );

    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("outside workspace");
    expect(await readFile(join(outsideRoot, "secret.txt"), "utf-8")).toBe("do not touch me");
  });

  it("edit_file still edits regular in-workspace files", async () => {
    const result = await new EditFileTool().execute(
      { path: "safe.txt", oldText: "hello", newText: "goodbye" },
      context()
    );
    expect(result.success).toBe(true);
    expect(await readFile(join(workspaceRoot, "safe.txt"), "utf-8")).toBe("goodbye world");
  });
});
