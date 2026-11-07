// Tests for the spawn-based PIPE execution path in ExecuteCommandTool:
// exit codes, timeout suggestions, abort, the sandbox policy gate, and the
// docker-unavailable fallback contract.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    // Only the docker CLI invocation is mocked (probe always fails here);
    // spawn and taskkill stay REAL — these tests exercise genuine child
    // processes so timeout/abort tree-kills are also verified end to end.
    execFile: vi.fn(((file: string, args: string[], options: unknown, callback?: unknown) => {
      if (file === "docker") {
        const cb = callback as ((err: Error | null, stdout?: string, stderr?: string) => void) | undefined;
        cb?.(new Error("docker not found in test"));
        return undefined;
      }
      return actual.execFile(file as never, args as never, options as never, callback as never);
    }) as never)
  };
});

import type { ToolExecutionContext, ToolResult } from "../../lib/tools.js";
import { ExecuteCommandTool } from "../shell.js";

const nodeQuoted = JSON.stringify(process.execPath);

let workspaceRoot = "";

async function makeContext(overrides: Partial<ToolExecutionContext> = {}): Promise<ToolExecutionContext> {
  return {
    workspaceRoot,
    userId: "test-user",
    conversationId: "test-conversation",
    ...overrides
  };
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "rapa-shell-pipe-"));
  delete process.env.RAPA_SANDBOX_MODE;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ExecuteCommandTool PIPE mode (spawn-based)", () => {
  it("captures stdout and succeeds on exit code 0", async () => {
    const tool = new ExecuteCommandTool();
    const result = await tool.execute(
      { command: `${nodeQuoted} -e "process.stdout.write('pipe-ok-12345')"` },
      await makeContext()
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("pipe-ok-12345");
    const data = result.data as Record<string, unknown>;
    expect(data.mode).toBe("pipe");
    expect(data.exitCode).toBeUndefined();
  });

  it("reports a non-zero exit code without throwing", async () => {
    const tool = new ExecuteCommandTool();
    const result = await tool.execute(
      { command: `${nodeQuoted} -e "process.stderr.write('boom-stderr'); process.exit(3)"` },
      await makeContext()
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("boom-stderr");
    const data = result.data as Record<string, unknown>;
    expect(data.exitCode).toBe(3);
  });

  it("kills the child on timeout and attaches the timeout suggestion", async () => {
    const tool = new ExecuteCommandTool();
    const result = await tool.execute(
      {
        command: `${nodeQuoted} -e "setTimeout(() => {}, 8000)"`,
        timeout: 1_000
      },
      await makeContext()
    );
    expect(result.success).toBe(false);
    const text = JSON.stringify(result);
    expect(text).toMatch(/timed out/i);
    expect(result.suggestions?.length ?? 0).toBeGreaterThan(0);
  }, 15_000);

  it("surfaces run-abort (context.signal) as a failed result", async () => {
    const controller = new AbortController();
    const tool = new ExecuteCommandTool();
    const execution = tool.execute(
      { command: `${nodeQuoted} -e "setTimeout(() => {}, 8000)"` },
      await makeContext({ signal: controller.signal })
    );
    setTimeout(() => controller.abort(), 300);
    const result: ToolResult = await execution;
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/aborted/i);
  }, 15_000);
});

describe("ExecuteCommandTool sandbox policy gate", () => {
  it("blocks privilege escalation in native mode (the default)", async () => {
    const tool = new ExecuteCommandTool();
    const result = await tool.execute(
      { command: "sudo rm -rf some-path" },
      await makeContext({ sandboxMode: "native" })
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("Blocked by sandbox policy: privilege escalation");
    expect((result.data as Record<string, unknown> | undefined)).toBeUndefined();
  });

  it("still blocks in docker mode", async () => {
    const tool = new ExecuteCommandTool();
    const result = await tool.execute(
      { command: "sudo echo hi" },
      await makeContext({ sandboxMode: "docker" })
    );
    expect(result.error).toBe("Blocked by sandbox policy: privilege escalation");
  });

  it("does not block when sandboxMode is off (legacy behavior)", async () => {
    const tool = new ExecuteCommandTool();
    const result = await tool.execute(
      { command: "sudo echo sandbox-off-probe" },
      await makeContext({ sandboxMode: "off" })
    );
    // The command ran (and failed because sudo doesn't exist / isn't usable
    // here) — crucially the failure is NOT the policy block.
    expect(result.error).not.toBe("Blocked by sandbox policy: privilege escalation");
  });

  it("env var RAPA_SANDBOX_MODE=off also disables the gate", async () => {
    vi.stubEnv("RAPA_SANDBOX_MODE", "off");
    const tool = new ExecuteCommandTool();
    const result = await tool.execute(
      { command: "sudo echo env-off-probe" },
      await makeContext()
    );
    expect(result.error).not.toBe("Blocked by sandbox policy: privilege escalation");
  });
});

describe("ExecuteCommandTool docker sandbox fallback", () => {
  it("returns the docker-unavailable validation error on the first call, then runs native", async () => {
    vi.stubEnv("RAPA_SANDBOX_MODE", "docker");
    const tool = new ExecuteCommandTool();
    const context = await makeContext();

    const first = await tool.execute(
      { command: `${nodeQuoted} -e "process.stdout.write('first')"`, timeout: 10_000 },
      context
    );
    expect(first.success).toBe(false);
    expect(first.error).toContain("Docker sandbox unavailable — approve to run natively");
    const firstData = first.data as Record<string, unknown>;
    expect(firstData.sandboxUnavailable).toBe(true);

    // The acknowledgement unlocks the native fallback for subsequent calls
    // (the "sandboxMode treated as native for that call" contract) — the
    // command now executes for real instead of erroring forever.
    const second = await tool.execute(
      { command: `${nodeQuoted} -e "process.stdout.write('second-native-run')"`, timeout: 10_000 },
      context
    );
    expect(second.success).toBe(true);
    expect(second.output).toContain("second-native-run");
  }, 20_000);
});
