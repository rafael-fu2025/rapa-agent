// §4.3 — Tests for the diagnostics tools.
//
// The full tool pipeline (which spawns child processes) is hard to test
// portably — the executable may not be on PATH, the workspace shape may
// not match a real project, etc. So this suite focuses on:
//
//   1. The `workdir` validation logic (rejects absolute paths, `..` traversal,
//      and non-existent paths).
//   2. The shell env sanitization helper that §4.3 added to `shell.ts`.
//   3. The `command` and `framework` parameter overrides — they flow
//      through `resolveTestCommand` / `resolveLintCommand` and the
//      returned `data.command` reflects them.

import { describe, expect, it } from "vitest";
import { ReadLintsTool, RunTestsTool } from "./diagnostics.js";
import { getSanitizedEnv, SENSITIVE_ENV_PATTERNS } from "./shell.js";

const ctx = {
  workspaceRoot: process.cwd(),
  userId: "u",
  conversationId: "c"
} as any;

describe("diagnostics — workdir validation", () => {
  const testTool = new RunTestsTool();
  const lintTool = new ReadLintsTool();

  it("rejects absolute paths", async () => {
    const r1 = await testTool.execute({ workdir: "C:\\Windows", timeout: 1000 }, ctx);
    expect(r1.success).toBe(false);
    expect(r1.error).toMatch(/workdir/);

    const r2 = await lintTool.execute({ workdir: "/etc/passwd", timeout: 1000 }, ctx);
    expect(r2.success).toBe(false);
    expect(r2.error).toMatch(/workdir/);
  });

  it("rejects `..` traversal", async () => {
    const r1 = await testTool.execute({ workdir: "../etc", timeout: 1000 }, ctx);
    expect(r1.success).toBe(false);
    expect(r1.error).toMatch(/workdir/);

    const r2 = await lintTool.execute({ workdir: "..\\system32", timeout: 1000 }, ctx);
    expect(r2.success).toBe(false);
    expect(r2.error).toMatch(/workdir/);
  });

  it("rejects non-existent workdir", async () => {
    const r = await testTool.execute({ workdir: "does-not-exist-12345-xyz", timeout: 1000 }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/does not exist/i);
  });
});

describe("diagnostics — env sanitization", () => {
  it("exports a helper that strips known-sensitive env vars", () => {
    expect(SENSITIVE_ENV_PATTERNS).toBeDefined();
    expect(Array.isArray(SENSITIVE_ENV_PATTERNS)).toBe(true);
    expect(SENSITIVE_ENV_PATTERNS.length).toBeGreaterThan(5);
  });

  it("strips DATABASE_URL and APP_SECRET from the env", () => {
    process.env.DATABASE_URL = "postgresql://user:pass@host:5432/db";
    process.env.APP_SECRET = "super-secret-test-value";
    process.env.TEST_VAR = "should-pass-through";

    const sanitized = getSanitizedEnv();

    expect(sanitized.DATABASE_URL).toBeUndefined();
    expect(sanitized.APP_SECRET).toBeUndefined();
    expect(sanitized.TEST_VAR).toBe("should-pass-through");

    delete process.env.DATABASE_URL;
    delete process.env.APP_SECRET;
    delete process.env.TEST_VAR;
  });

  it("strips common API key patterns", () => {
    process.env.OPENAI_API_KEY = "sk-test-1234";
    process.env.MY_API_SECRET = "shhh";
    process.env.RANDOM_API_KEY = "should-be-stripped";
    process.env.PATH_KEEPS = "/usr/bin";

    const sanitized = getSanitizedEnv();
    expect(sanitized.OPENAI_API_KEY).toBeUndefined();
    expect(sanitized.MY_API_SECRET).toBeUndefined();
    expect(sanitized.RANDOM_API_KEY).toBeUndefined();
    expect(sanitized.PATH_KEEPS).toBe("/usr/bin");

    delete process.env.OPENAI_API_KEY;
    delete process.env.MY_API_SECRET;
    delete process.env.RANDOM_API_KEY;
    delete process.env.PATH_KEEPS;
  });
});

describe("diagnostics — `command` and `framework` parameter overrides", () => {
  it("uses the explicit `command` when provided", async () => {
    const tool = new RunTestsTool();
    const r = await tool.execute({ command: "echo OVERRIDE_TEST", timeout: 1000 }, ctx);
    expect((r.data as any)?.command).toBe("echo OVERRIDE_TEST");
  });

  it("maps `framework: \"jest\"` to a jest command", async () => {
    const tool = new RunTestsTool();
    const r = await tool.execute({ framework: "jest", timeout: 1000 }, ctx);
    expect((r.data as any)?.command).toMatch(/jest/);
  });

  it("maps `framework: \"pytest\"` to a pytest command", async () => {
    const tool = new RunTestsTool();
    const r = await tool.execute({ framework: "pytest", timeout: 1000 }, ctx);
    expect((r.data as any)?.command).toMatch(/pytest/);
  });

  it("maps lint framework \"eslint\" correctly", async () => {
    const tool = new ReadLintsTool();
    const r = await tool.execute({ framework: "eslint", timeout: 1000 }, ctx);
    expect((r.data as any)?.command).toMatch(/eslint/);
  });
});
