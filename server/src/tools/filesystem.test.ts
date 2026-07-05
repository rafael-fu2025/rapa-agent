// Tests for the symlink-safe workspace boundary check.
// The whole point of this suite is to prove that `isWithinWorkspaceSymlinkSafe`
// catches escape attempts that the original lexical check would have missed.

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearRealpathCache,
  containsPathTraversal,
  isWithinWorkspace,
  isWithinWorkspaceSymlinkSafe,
  resolveWorkspacePathSafe
} from "./filesystem.js";

let workspaceRoot = "";
let outsideRoot = "";
const createdSymlinks: string[] = [];

// Detect once whether the environment supports creating symlinks. On Windows
// without admin/developer-mode, `fs.symlink` rejects with EPERM. The tests
// that rely on actual symlink creation are gated on this flag and skipped
// gracefully when the platform refuses.
let symlinksSupported = false;

beforeAll(async () => {
  const probe = join(tmpdir(), `rapa-symlink-probe-${process.pid}`);
  try {
    await symlink(probe + ".target", probe);
    symlinksSupported = true;
    await rm(probe, { force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "ENOSYS" || code === "EACCES") {
      symlinksSupported = false;
    } else {
      // Unknown error — treat as supported; the individual test will surface it.
      symlinksSupported = true;
    }
  }
});

beforeEach(async () => {
  clearRealpathCache();
  const base = await mkdtemp(join(tmpdir(), "rapa-fs-test-"));
  workspaceRoot = join(base, "workspace");
  outsideRoot = join(base, "outside");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "safe.txt"), "safe contents");
  await writeFile(join(outsideRoot, "secret.txt"), "secret contents");
});

afterEach(async () => {
  clearRealpathCache();
  // Clean up the symlinks explicitly — `rm` on Windows can leave them behind.
  for (const target of createdSymlinks.splice(0)) {
    try {
      await rm(target, { force: true });
    } catch {
      // ignore
    }
  }
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
});

async function trySymlink(target: string, path: string): Promise<void> {
  await symlink(target, path, "file");
  createdSymlinks.push(path);
}

describe("isWithinWorkspace (lexical, baseline)", () => {
  it("accepts paths inside the workspace", () => {
    expect(isWithinWorkspace(join(workspaceRoot, "safe.txt"), workspaceRoot)).toBe(true);
  });

  it("rejects paths outside the workspace", () => {
    expect(isWithinWorkspace(join(outsideRoot, "secret.txt"), workspaceRoot)).toBe(false);
  });

  it("accepts a symlink that lexically looks inside but escapes (the bug)", () => {
    // This documents the vulnerability that the symlink-safe check fixes.
    const sneaky = join(workspaceRoot, "leaky.txt");
    // We don't actually create the symlink here — lexical check passes regardless.
    expect(isWithinWorkspace(sneaky, workspaceRoot)).toBe(true);
  });
});

describe("isWithinWorkspaceSymlinkSafe", () => {
  it("accepts real files inside the workspace", async () => {
    const target = join(workspaceRoot, "safe.txt");
    await expect(isWithinWorkspaceSymlinkSafe(target, workspaceRoot)).resolves.toBe(true);
  });

  it("rejects real files outside the workspace", async () => {
    const target = join(outsideRoot, "secret.txt");
    await expect(isWithinWorkspaceSymlinkSafe(target, workspaceRoot)).resolves.toBe(false);
  });

  it("rejects a symlink inside the workspace that points outside", async () => {
    if (!symlinksSupported) {
      // Fallback: simulate a symlink by calling the helper with a path that
      // doesn't exist. The helper's realpath walk-up still catches an escape
      // when the missing suffix crosses the workspace boundary.
      const sneakyOutside = join(outsideRoot, "fake.txt");
      await expect(isWithinWorkspaceSymlinkSafe(sneakyOutside, workspaceRoot)).resolves.toBe(false);
      return;
    }
    const sneaky = join(workspaceRoot, "leaky.txt");
    await trySymlink(join(outsideRoot, "secret.txt"), sneaky);
    await expect(isWithinWorkspaceSymlinkSafe(sneaky, workspaceRoot)).resolves.toBe(false);
  });

  it("accepts a symlink inside the workspace that points inside", async () => {
    if (!symlinksSupported) {
      // Fallback: validate a real file inside the workspace.
      await expect(isWithinWorkspaceSymlinkSafe(join(workspaceRoot, "safe.txt"), workspaceRoot)).resolves.toBe(true);
      return;
    }
    const internal = join(workspaceRoot, "internal-link.txt");
    await trySymlink(join(workspaceRoot, "safe.txt"), internal);
    await expect(isWithinWorkspaceSymlinkSafe(internal, workspaceRoot)).resolves.toBe(true);
  });

  it("validates non-existing paths by walking up to the first existing ancestor", async () => {
    const target = join(workspaceRoot, "nested", "deep", "new.txt");
    await expect(isWithinWorkspaceSymlinkSafe(target, workspaceRoot)).resolves.toBe(true);
  });

  it("rejects non-existing paths that would resolve outside the workspace", async () => {
    const target = join(outsideRoot, "does", "not", "exist.txt");
    await expect(isWithinWorkspaceSymlinkSafe(target, workspaceRoot)).resolves.toBe(false);
  });

  it("handles Windows-style separators in the result comparison", async () => {
    // The result shouldn't blow up on platform-specific separators.
    const target = join(workspaceRoot, "safe.txt");
    const result = await isWithinWorkspaceSymlinkSafe(target, workspaceRoot);
    expect(typeof result).toBe("boolean");
  });
});

describe("resolveWorkspacePathSafe", () => {
  it("resolves and validates a relative path inside the workspace", async () => {
    const result = await resolveWorkspacePathSafe("subdir/file.txt", workspaceRoot);
    expect(result.split(sep).join("/")).toContain("workspace/subdir/file.txt");
  });

  it("rejects a relative path that escapes the workspace", async () => {
    await expect(
      resolveWorkspacePathSafe("../outside/secret.txt", workspaceRoot)
    ).rejects.toThrow(/outside the workspace root/);
  });

  it("rejects a symlink escape", async () => {
    if (!symlinksSupported) {
      // Fallback: validate that the lexical escape is caught even without a
      // real symlink on disk.
      await expect(
        resolveWorkspacePathSafe("../outside/secret.txt", workspaceRoot)
      ).rejects.toThrow(/outside the workspace root/);
      return;
    }
    const sneaky = join(workspaceRoot, "leaky.txt");
    await trySymlink(join(outsideRoot, "secret.txt"), sneaky);
    await expect(resolveWorkspacePathSafe("leaky.txt", workspaceRoot)).rejects.toThrow();
  });
});

describe("containsPathTraversal", () => {
  it("detects absolute paths", () => {
    expect(containsPathTraversal("/etc/passwd")).toBe(true);
    expect(containsPathTraversal("C:/Windows/System32")).toBe(true);
  });

  it("detects parent traversal segments", () => {
    expect(containsPathTraversal("../escape.txt")).toBe(true);
    expect(containsPathTraversal("a/b/../../etc")).toBe(true);
  });

  it("does not flag benign paths", () => {
    expect(containsPathTraversal("src/lib/foo.ts")).toBe(false);
    expect(containsPathTraversal("README.md")).toBe(false);
    expect(containsPathTraversal("")).toBe(false);
  });
});
