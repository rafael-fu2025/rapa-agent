// Tests for the native sandbox backend and mode resolution.

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { getNativeSandbox } from "../native.js";
import {
  resolveSandboxBackend,
  resolveSandboxMode,
  terminateProcessTree
} from "../index.js";

describe("native sandbox backend", () => {
  it("always probes true", async () => {
    const backend = getNativeSandbox();
    await expect(backend.probe()).resolves.toBe(true);
    expect(backend.name).toBe("native");
  });

  it("prepare is the identity on command and cwd", async () => {
    const backend = getNativeSandbox();
    const prepared = await backend.prepare("npm run build  &&  echo done", {
      workspaceRoot: "C:\\tmp\\ws",
      cwd: "C:\\tmp\\ws\\packages\\app",
      timeoutMs: 5_000
    });
    expect(prepared.command).toBe("npm run build  &&  echo done");
    expect(prepared.cwd).toBe("C:\\tmp\\ws\\packages\\app");
  });

  it("terminate resolves for missing pids and stale pids without throwing", async () => {
    await expect(terminateProcessTree(undefined)).resolves.toBeUndefined();
    await expect(terminateProcessTree(0)).resolves.toBeUndefined();
    // Pid 4_194_304+ is out of range on Windows and virtually unused on POSIX;
    // either way the helper must swallow the failure.
    await expect(terminateProcessTree(4_000_000)).resolves.toBeUndefined();
  });

  it("kills a spawned process tree via terminateProcessTree", async () => {
    // Long-lived grandchild: `node -e "setInterval(...)"` under a shell.
    // With shell:true the direct child is the shell — the node process is a
    // descendant, so only a tree kill reliably reaches it.
    const quoted = JSON.stringify(process.execPath);
    const child = spawn(`${quoted} -e "setInterval(() => {}, 60000)"`, {
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: "ignore"
    });
    expect(child.pid).toBeDefined();

    // Give the shell + node grandchild a moment to start.
    await new Promise((resolve) => setTimeout(resolve, 700));

    // Attach the exit listener BEFORE the kill (taskkill completes quickly
    // and the 'exit' event can fire while the kill call is still pending),
    // then start the kill and race it against a safety timeout.
    const exitedPromise = new Promise<boolean>((resolve) => {
      child.once("exit", () => resolve(true));
    });
    const killPromise = terminateProcessTree(child.pid);
    const exited = await Promise.race([
      exitedPromise,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000))
    ]);
    await killPromise;

    expect(exited).toBe(true);
  }, 20_000);
});

describe("resolveSandboxMode", () => {
  it("prefers the context value", () => {
    expect(resolveSandboxMode({ sandboxMode: "off" })).toBe("off");
    expect(resolveSandboxMode({ sandboxMode: "docker" })).toBe("docker");
    expect(resolveSandboxMode({ sandboxMode: "native" })).toBe("native");
  });

  it("falls back to RAPA_SANDBOX_MODE, then native", () => {
    delete process.env.RAPA_SANDBOX_MODE;
    expect(resolveSandboxMode()).toBe("native");

    process.env.RAPA_SANDBOX_MODE = "docker";
    expect(resolveSandboxMode()).toBe("docker");

    process.env.RAPA_SANDBOX_MODE = "OFF";
    expect(resolveSandboxMode()).toBe("off");

    process.env.RAPA_SANDBOX_MODE = "garbage";
    expect(resolveSandboxMode()).toBe("native");

    delete process.env.RAPA_SANDBOX_MODE;
  });

  it("context beats env", () => {
    process.env.RAPA_SANDBOX_MODE = "off";
    expect(resolveSandboxMode({ sandboxMode: "docker" })).toBe("docker");
    delete process.env.RAPA_SANDBOX_MODE;
  });
});

describe("resolveSandboxBackend", () => {
  it("returns null for off and memoizes singletons", () => {
    expect(resolveSandboxBackend("off")).toBeNull();
    const native = resolveSandboxBackend("native");
    expect(native?.name).toBe("native");
    expect(resolveSandboxBackend("native")).toBe(native);
    const docker = resolveSandboxBackend("docker");
    expect(docker?.name).toBe("docker");
    expect(resolveSandboxBackend("docker")).toBe(docker);
  });
});
