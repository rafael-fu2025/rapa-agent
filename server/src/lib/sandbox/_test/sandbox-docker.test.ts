// Tests for the Docker sandbox backend: command wrapping, cwd mapping, and
// the probe-failure contract (SandboxUnavailableError, never a silent bypass).

import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    // Only execFile is mocked — spawn stays real for other modules in the graph.
    execFile: vi.fn()
  };
});

import {
  buildDockerCommand,
  getDockerSandbox,
  resetDockerSandboxStateForTests,
  SandboxUnavailableError,
  toContainerCwd
} from "../docker.js";

const mockedExecFile = vi.mocked(execFile);

beforeEach(() => {
  resetDockerSandboxStateForTests();
  mockedExecFile.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toContainerCwd", () => {
  it("maps the workspace root to /workspace", () => {
    expect(toContainerCwd("C:\\tmp\\ws", "C:\\tmp\\ws")).toBe("/workspace");
  });

  it("maps subdirectories with POSIX separators", () => {
    expect(toContainerCwd("C:\\tmp\\ws\\packages\\app", "C:\\tmp\\ws")).toBe("/workspace/packages/app");
    expect(toContainerCwd("/tmp/ws/src", "/tmp/ws")).toBe("/workspace/src");
  });

  it("falls back to /workspace for paths outside the root", () => {
    expect(toContainerCwd("/somewhere/else", "/tmp/ws")).toBe("/workspace");
  });
});

describe("buildDockerCommand", () => {
  const baseOpts = {
    workspaceRoot: "/tmp/ws",
    cwd: "/tmp/ws/sub",
    timeoutMs: 30_000
  };

  it("wraps the command with no-network, volume mount and workdir", () => {
    const wrapped = buildDockerCommand("npm test", baseOpts);
    expect(wrapped).toContain("docker run --rm --network none");
    expect(wrapped).toContain('-v "/tmp/ws:/workspace"');
    expect(wrapped).toContain("-w /workspace/sub");
    expect(wrapped).toContain("node:20-alpine sh -c");
  });

  it("base64-encodes the inner command (quoting-safe) and round-trips it", () => {
    const tricky = `echo "a | b && c" > 'out.txt'`;
    const wrapped = buildDockerCommand(tricky, baseOpts);
    const match = wrapped.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d \| sh/);
    expect(match).not.toBeNull();
    expect(Buffer.from(match![1], "base64").toString("utf8")).toBe(tricky);
    // The raw command must not appear unencoded in the outer string.
    expect(wrapped.includes("a | b")).toBe(false);
  });
});

describe("docker backend probe fallback", () => {
  it("prepare throws SandboxUnavailableError when the daemon is unreachable", async () => {
    mockedExecFile.mockImplementation(((_file: string, _args: string[], _options: unknown, callback?: unknown) => {
      const cb = callback as (err: Error | null, stdout?: string, stderr?: string) => void;
      cb(new Error("docker: command not found"));
      return undefined;
    }) as never);

    const backend = getDockerSandbox();
    await expect(backend.probe()).resolves.toBe(false);
    await expect(backend.prepare("ls -la", {
      workspaceRoot: "/tmp/ws",
      cwd: "/tmp/ws",
      timeoutMs: 1_000
    })).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("prepare wraps the command when the probe succeeds (skipping the pull once cached)", async () => {
    mockedExecFile.mockImplementation(((_file: string, args: string[], _options: unknown, callback?: unknown) => {
      const cb = callback as (err: Error | null, stdout?: string, stderr?: string) => void;
      // Probe succeeds; the pull is left failing-free as well.
      cb(null, "24.0.7", "");
      return undefined;
    }) as never);

    const backend = getDockerSandbox();
    const prepared = await backend.prepare("git status", {
      workspaceRoot: "/tmp/ws",
      cwd: "/tmp/ws/sub",
      timeoutMs: 1_000
    });
    expect(prepared.cwd).toBe("/tmp/ws/sub");
    expect(prepared.command).toContain("--network none");
    expect(prepared.command).toContain("-w /workspace/sub");
    expect(Buffer.from(
      (prepared.command.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d \| sh/) ?? [])[1] ?? "",
      "base64"
    ).toString("utf8")).toBe("git status");
  });

  it("terminate never throws for a stale pid", async () => {
    const backend = getDockerSandbox();
    await expect(backend.terminate(undefined)).resolves.toBeUndefined();
  });
});
