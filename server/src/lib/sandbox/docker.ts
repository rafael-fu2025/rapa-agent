// Docker sandbox backend.
//
// Wraps a shell command so it runs inside an ephemeral, network-disabled
// container with the workspace mounted read-write at /workspace:
//
//   docker run --rm --network none -v "<workspaceRoot>:/workspace" \
//     -w /workspace/<relative-cwd> node:20-alpine sh -c "echo <b64> | base64 -d | sh"
//
// The inner command is base64-encoded into the `sh -c` payload. That sidesteps
// every host-shell quoting hazard (cmd.exe, PowerShell, Git Bash, POSIX sh):
// the outer command is one flat token stream with no embedded pipes or quotes
// for the host shell to misread, and the container decodes it verbatim.
//
// Failure contract: if the Docker daemon cannot be reached, `prepare` throws
// `SandboxUnavailableError`. The executing tool then returns a validation
// error telling the model/user the command will only run natively through the
// normal approval flow — the sandbox never silently degrades.

import { execFile } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";

import type { SandboxBackend, SandboxPrepareOptions } from "./types.js";
import { terminateProcessTree } from "./native.js";

const execFileAsync = promisify(execFile);

const DOCKER_IMAGE = "node:20-alpine";
const PROBE_TIMEOUT_MS = 3_000;
const PULL_TIMEOUT_MS = 120_000;
/** Failed probes are retried after this window (successful ones stick). */
const PROBE_FAILURE_TTL_MS = 60_000;

export class SandboxUnavailableError extends Error {
  constructor(message = "Docker sandbox is unavailable") {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

type ProbeState = {
  available: boolean;
  checkedAt: number;
};

let probeState: ProbeState | undefined;
let probeInFlight: Promise<boolean> | undefined;
let imagePulled = false;

async function probeDocker(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["version", "--format", "{{.Server}}"], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Memoized Docker daemon probe. Success is cached for the process lifetime;
 * failure is retried after PROBE_FAILURE_TTL_MS so a daemon that starts late
 * recovers without a server restart.
 */
export async function probeDockerCached(): Promise<boolean> {
  const now = Date.now();
  if (probeState?.available) return true;
  if (probeState && !probeState.available && now - probeState.checkedAt < PROBE_FAILURE_TTL_MS) {
    return false;
  }
  probeInFlight ??= probeDocker().then((available) => {
    probeState = { available, checkedAt: Date.now() };
    probeInFlight = undefined;
    if (!available) {
      console.warn("[sandbox] docker probe failed — daemon unreachable or docker CLI missing");
    }
    return available;
  }).catch(() => {
    probeState = { available: false, checkedAt: Date.now() };
    probeInFlight = undefined;
    return false;
  });
  return probeInFlight;
}

async function ensureImage(): Promise<void> {
  if (imagePulled) return;
  console.log(`[sandbox] pulling sandbox image ${DOCKER_IMAGE} (first use)...`);
  try {
    await execFileAsync("docker", ["pull", DOCKER_IMAGE], { timeout: PULL_TIMEOUT_MS, windowsHide: true });
    imagePulled = true;
    console.log(`[sandbox] sandbox image ${DOCKER_IMAGE} ready`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[sandbox] failed to pull ${DOCKER_IMAGE}: ${message}`);
    throw new SandboxUnavailableError(`Failed to pull sandbox image ${DOCKER_IMAGE}`);
  }
}

/**
 * Map a host cwd inside the workspace to its container path under /workspace.
 * The cwd is guaranteed by the caller (workspace jail) to be inside
 * workspaceRoot; any escaping path falls back to the workspace root.
 */
export function toContainerCwd(cwd: string, workspaceRoot: string): string {
  let rel: string;
  try {
    rel = relative(workspaceRoot, cwd);
  } catch {
    return "/workspace";
  }
  if (!rel || rel === "." || rel.startsWith("..")) return "/workspace";
  return `/workspace/${rel.split(/[\\/]+/).join("/")}`;
}

/**
 * Build the docker-wrapped command string. Exported for tests — the wrapping
 * is pure string composition over the prepared options.
 */
export function buildDockerCommand(command: string, opts: SandboxPrepareOptions): string {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  const workdir = toContainerCwd(opts.cwd, opts.workspaceRoot);
  return (
    `docker run --rm --network none ` +
    `-v "${opts.workspaceRoot}:/workspace" ` +
    `-w ${workdir} ` +
    `${DOCKER_IMAGE} sh -c "echo ${encoded} | base64 -d | sh"`
  );
}

function createDockerSandbox(): SandboxBackend {
  return {
    name: "docker",
    probe(): Promise<boolean> {
      return probeDockerCached();
    },
    async prepare(command: string, opts: SandboxPrepareOptions): Promise<{ command: string; cwd: string }> {
      const available = await probeDockerCached();
      if (!available) {
        throw new SandboxUnavailableError();
      }
      await ensureImage();
      // The returned cwd stays on the host: the docker CLI (and the volume
      // mount pointing at workspaceRoot) run on the host; only the inner
      // command executes inside the container at /workspace.
      return { command: buildDockerCommand(command, opts), cwd: opts.cwd };
    },
    async terminate(pid: number | undefined): Promise<void> {
      // Killing the docker CLI client tears down the attached `docker run`;
      // --rm then removes the container. Best effort — never throws.
      await terminateProcessTree(pid);
    }
  };
}

let dockerBackend: SandboxBackend | undefined;

/** Process-wide singleton so the memoized probe/image state is shared. */
export function getDockerSandbox(): SandboxBackend {
  dockerBackend ??= createDockerSandbox();
  return dockerBackend;
}

/** Test hook: reset memoized probe/image state. */
export function resetDockerSandboxStateForTests(): void {
  probeState = undefined;
  probeInFlight = undefined;
  imagePulled = false;
}
