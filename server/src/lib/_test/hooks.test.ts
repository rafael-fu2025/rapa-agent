// Tests for the agent hooks lifecycle (Item 5): shell + http dispatch via
// injected I/O mocks, event/tool matching, fail-soft behavior on timeouts
// and errors, and best-effort useCount accounting.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  prisma: {
    agentHook: {
      findMany: vi.fn(),
      update: vi.fn()
    }
  }
}));

import { prisma } from "../db.js";
import {
  dispatchHook,
  dispatchHooksForEvent,
  loadHooksForUser,
  type HookConfig,
  type HookEventPayload
} from "../hooks.js";

const mockedFindMany = vi.mocked(prisma.agentHook.findMany);
const mockedUpdate = vi.mocked(prisma.agentHook.update);

type ExecFileSpy = ReturnType<typeof vi.fn>;

function makeExecMock(outcome: "ok" | "error" = "ok"): { spy: ExecFileSpy; calls: Array<{ file: string; options: Record<string, unknown> }> } {
  const calls: Array<{ file: string; options: Record<string, unknown> }> = [];
  const spy = vi.fn((file: string, _args: string[], options: Record<string, unknown>, callback: (err: Error | null) => void) => {
    calls.push({ file, options });
    callback(outcome === "ok" ? null : new Error("Command failed with exit code 1"));
  });
  return { spy: spy as unknown as ExecFileSpy, calls };
}

function makeHook(overrides: Partial<HookConfig> = {}): HookConfig {
  return {
    id: "hook-1",
    name: "test-hook",
    event: "tools/tool/call",
    matchTool: null,
    action: "shell",
    target: "echo hook-fired",
    timeoutMs: 5000,
    ...overrides
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const payload: HookEventPayload = {
  call: { id: "call-1", name: "read_file", parameters: { path: "a.txt" } },
  workspaceRoot: "C:/tmp/ws",
  conversationId: "conv-1"
};

beforeEach(() => {
  mockedFindMany.mockReset();
  mockedUpdate.mockReset();
  mockedUpdate.mockResolvedValue({ id: "hook-1", useCount: 1 } as never);
});

describe("dispatchHook (shell)", () => {
  it("executes the target via execFile with event env vars and workspace cwd", async () => {
    const { spy, calls } = makeExecMock();
    await dispatchHook(makeHook(), "tools/tool/call", payload, { execFileFn: spy as never });

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("echo hook-fired");
    const options = calls[0].options as {
      env: Record<string, string>;
      cwd?: string;
      timeout: number;
      shell: boolean;
    };
    expect(options.shell).toBe(true);
    expect(options.cwd).toBe("C:/tmp/ws");
    expect(options.timeout).toBe(5000);
    expect(options.env.RAPA_HOOK_EVENT).toBe("tools/tool/call");
    expect(JSON.parse(options.env.RAPA_HOOK_PAYLOAD)).toMatchObject({
      call: { name: "read_file" },
      conversationId: "conv-1"
    });
  });

  it("omits cwd when the payload has no workspaceRoot", async () => {
    const { spy, calls } = makeExecMock();
    await dispatchHook(makeHook(), "agent/turn/end", { status: "completed" }, { execFileFn: spy as never });
    expect(calls[0].options.cwd).toBeUndefined();
    const env = (calls[0].options as { env: Record<string, string> }).env;
    expect(env.RAPA_HOOK_EVENT).toBe("agent/turn/end");
  });

  it("resolves (fire-soft) when the shell command exits non-zero", async () => {
    const { spy } = makeExecMock("error");
    await expect(
      dispatchHook(makeHook(), "tools/tool/call", payload, { execFileFn: spy as never })
    ).resolves.toBeUndefined();
  });

  it("resolves (fire-soft) when execFile throws synchronously (timeout)", async () => {
    const throwing = vi.fn(() => {
      throw new Error("Command timed out after 5000 ms");
    });
    await expect(
      dispatchHook(makeHook(), "tools/tool/call", payload, { execFileFn: throwing as never })
    ).resolves.toBeUndefined();
  });
});

describe("dispatchHook (http)", () => {
  it("POSTs {event, payload} JSON to the target URL", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    await dispatchHook(
      makeHook({ action: "http", target: "https://hooks.example/relay" }),
      "tools/tool/result",
      { call: { name: "write_file" }, status: "x" },
      { fetchFn: fetchFn as never }
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example/relay");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as { event: string; payload: { call?: { name?: string } } };
    expect(body.event).toBe("tools/tool/result");
    expect(body.payload.call?.name).toBe("write_file");
  });

  it("resolves (fire-soft) when the HTTP endpoint fails", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      dispatchHook(makeHook({ action: "http", target: "https://hooks.example/relay" }), "tools/tool/call", payload, { fetchFn: fetchFn as never })
    ).resolves.toBeUndefined();
  });

  it("resolves (fire-soft) when fetch rejects (abort / network error)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("The operation was aborted due to timeout");
    });
    await expect(
      dispatchHook(makeHook({ action: "http", target: "https://hooks.example/relay" }), "tools/tool/call", payload, { fetchFn: fetchFn as never })
    ).resolves.toBeUndefined();
  });
});

describe("dispatchHooksForEvent", () => {
  it("dispatches only hooks matching the event name", async () => {
    const { spy, calls } = makeExecMock();
    const hooks = [
      makeHook({ id: "hook-call", event: "tools/tool/call" }),
      makeHook({ id: "hook-turn", event: "agent/turn/end" })
    ];
    await dispatchHooksForEvent("user-1", "tools/tool/call", payload, hooks, { execFileFn: spy as never });

    expect(calls).toHaveLength(1);
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "hook-call" }, data: expect.objectContaining({ useCount: { increment: 1 } }) })
    );
  });

  it("applies the matchTool filter against payload.call.name", async () => {
    const { spy, calls } = makeExecMock();
    const hooks = [
      makeHook({ id: "hook-read", matchTool: "read_file" }),
      makeHook({ id: "hook-write", matchTool: "write_file" }),
      makeHook({ id: "hook-any", matchTool: null })
    ];
    await dispatchHooksForEvent("user-1", "tools/tool/call", payload, hooks, { execFileFn: spy as never });

    expect(calls).toHaveLength(2);
    expect(mockedUpdate).toHaveBeenCalledTimes(2);
    const updatedIds = mockedUpdate.mock.calls.map((c) => (c[0] as { where: { id: string } }).where.id);
    expect(updatedIds.sort()).toEqual(["hook-any", "hook-read"]);
  });

  it("does not match when the hook has a matchTool and the payload has no call", async () => {
    const { spy, calls } = makeExecMock();
    const hooks = [
      makeHook({ id: "hook-read", matchTool: "read_file" }),
      makeHook({ id: "hook-any", matchTool: null })
    ];
    await dispatchHooksForEvent("user-1", "tools/tool/call", { workspaceRoot: "C:/tmp/ws" }, hooks, { execFileFn: spy as never });

    expect(calls).toHaveLength(1);
  });

  it("dispatches matching hooks in parallel (all fire even when some fail)", async () => {
    const calls: string[] = [];
    const firstHook = makeHook({ id: "hook-a", action: "shell", target: "a" });
    const secondHook = makeHook({ id: "hook-b", action: "http", target: "https://x/y" });
    const execSpy = vi.fn((_file: string, _args: string[], _options: Record<string, unknown>, cb: (err: Error | null) => void) => {
      calls.push("shell");
      cb(null);
    });
    const fetchFn = vi.fn(async () => {
      calls.push("http");
      return new Response("{}", { status: 200 });
    });
    await dispatchHooksForEvent(
      "user-1",
      "tools/tool/call",
      payload,
      [firstHook, secondHook],
      { execFileFn: execSpy as never, fetchFn: fetchFn as never }
    );
    expect(calls.sort()).toEqual(["http", "shell"]);
  });

  it("keeps accounting failures silent (update rejection does not throw)", async () => {
    const { spy } = makeExecMock();
    mockedUpdate.mockRejectedValue(new Error("db down"));
    await expect(
      dispatchHooksForEvent("user-1", "tools/tool/call", payload, [makeHook()], { execFileFn: spy as never })
    ).resolves.toBeUndefined();
    await flushMicrotasks();
  });
});

describe("loadHooksForUser", () => {
  it("maps DB rows to normalized HookConfig entries", async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: "h1",
        name: "notify",
        event: "agent/turn/end",
        matchTool: null,
        action: "http",
        target: "https://x/y",
        timeoutMs: 3000
      },
      {
        id: "h2",
        name: "log-shell",
        event: "tools/tool/call",
        matchTool: "execute_command",
        action: "weird-action",
        target: "log.sh",
        timeoutMs: 0
      }
    ] as never);

    const hooks = await loadHooksForUser("user-1");
    expect(hooks).toEqual([
      { id: "h1", name: "notify", event: "agent/turn/end", matchTool: null, action: "http", target: "https://x/y", timeoutMs: 3000 },
      // Unknown actions fall back to shell; non-positive timeouts fall back at dispatch time.
      { id: "h2", name: "log-shell", event: "tools/tool/call", matchTool: "execute_command", action: "shell", target: "log.sh", timeoutMs: 0 }
    ]);
    expect(mockedFindMany).toHaveBeenCalledWith({
      where: { userId: "user-1", enabled: true },
      orderBy: { createdAt: "asc" }
    });
  });

  it("returns an empty list (never throws) when the DB lookup fails", async () => {
    mockedFindMany.mockRejectedValue(new Error("db down"));
    await expect(loadHooksForUser("user-1")).resolves.toEqual([]);
  });

  it("falls back to a DB load when no hooks are passed in", async () => {
    mockedFindMany.mockResolvedValue([
      { id: "h1", name: "n", event: "tools/tool/call", matchTool: null, action: "shell", target: "t", timeoutMs: 5000 }
    ] as never);
    const { spy, calls } = makeExecMock();
    await dispatchHooksForEvent("user-1", "tools/tool/call", payload, undefined, { execFileFn: spy as never });
    expect(mockedFindMany).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });
});
