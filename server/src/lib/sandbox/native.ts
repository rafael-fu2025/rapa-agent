// Native sandbox backend.
//
// "native" means the command runs directly on the host (inside the workspace
// jail that shell.ts already enforces). Two responsibilities live here:
//
// 1. `terminateProcessTree` — kill a whole process tree instead of only the
//    direct child. `child.kill()` leaves grandchildren (npm run scripts,
//    spawned servers, compilers) running as orphans; this helper reaches them.
// 2. The backend object itself: probe is always true (nothing external to
//    reach) and prepare is the identity — policy enforcement for native mode
//    (privilege-escalation blocklist) lives in the executing tool, because it
//    needs to return a structured ToolResult, not throw.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { SandboxBackend, SandboxPrepareOptions } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Kill a process and (best effort) its whole tree.
 *
 * - Windows: `taskkill /pid <pid> /T /F` walks the child tree natively.
 * - POSIX: the caller spawns children with `detached: true`, giving them
 *   their own process group; `process.kill(-pid)` signals the group. When
 *   the group kill fails (stale pid, not a group leader) fall back to a
 *   direct single-process kill.
 *
 * Never throws — a vanished process is treated as "already terminated".
 */
export async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (pid === undefined || !Number.isFinite(pid) || pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {
      // Non-zero exit means the process was already gone.
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // Not a group leader (or already gone) — fall through to the direct kill.
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * Spawn a child in its own process group (POSIX) so `terminateProcessTree`
 * can reach the whole tree. Windows relies on taskkill /T instead.
 */
export function spawnTreeKillable(command: string, options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ReturnType<typeof spawn> {
  return spawn(command, {
    shell: true,
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    detached: process.platform !== "win32"
  });
}

function createNativeSandbox(): SandboxBackend {
  return {
    name: "native",
    async probe(): Promise<boolean> {
      return true;
    },
    async prepare(command: string, opts: SandboxPrepareOptions): Promise<{ command: string; cwd: string }> {
      // Identity: the command runs as-is on the host. Sandboxed *policy*
      // (privilege-escalation blocklist) is enforced by the executing tool
      // so it can produce a structured validation error instead of throwing.
      return { command, cwd: opts.cwd };
    },
    async terminate(pid: number | undefined): Promise<void> {
      await terminateProcessTree(pid);
    }
  };
}

let nativeBackend: SandboxBackend | undefined;

/** Process-wide singleton so probe state stays consistent. */
export function getNativeSandbox(): SandboxBackend {
  nativeBackend ??= createNativeSandbox();
  return nativeBackend;
}
