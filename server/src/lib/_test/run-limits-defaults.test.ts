import { afterEach, describe, expect, it } from "vitest";
import { loadDefaultRunLimits, RunLimitTracker } from "../run-limits.js";

const ENV_KEYS = [
  "AGENT_RUN_MAX_TOKENS",
  "AGENT_RUN_MAX_COST_USD",
  "AGENT_RUN_MAX_DURATION_MS",
  "AGENT_RUN_MAX_ITERATIONS"
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("loadDefaultRunLimits — caps are opt-in", () => {
  it("returns no caps when no env vars are set", () => {
    const limits = loadDefaultRunLimits();
    expect(limits.maxTokens).toBeUndefined();
    expect(limits.maxCostUsd).toBeUndefined();
    expect(limits.maxDurationMs).toBeUndefined();
    expect(limits.maxIterations).toBeUndefined();
  });

  it("enforces only the env vars that are set", () => {
    process.env.AGENT_RUN_MAX_DURATION_MS = "3600000";
    const limits = loadDefaultRunLimits();
    expect(limits.maxDurationMs).toBe(3600000);
    expect(limits.maxTokens).toBeUndefined();
    expect(limits.maxCostUsd).toBeUndefined();
  });

  it("ignores invalid values instead of falling back to a cap", () => {
    process.env.AGENT_RUN_MAX_COST_USD = "not-a-number";
    process.env.AGENT_RUN_MAX_TOKENS = "0";
    expect(loadDefaultRunLimits().maxCostUsd).toBeUndefined();
    expect(loadDefaultRunLimits().maxTokens).toBeUndefined();
  });

  it("a tracker built from defaults never breaches", () => {
    delete process.env.AGENT_RUN_MAX_DURATION_MS;
    const tracker = new RunLimitTracker("run-test", loadDefaultRunLimits(), Date.now());
    tracker.recordTokens("some-model", 500_000, 500_000);
    tracker.recordIteration();
    // Simulate a very long run — no duration cap set, so no breach.
    const longAgoTracker = new RunLimitTracker("run-test", loadDefaultRunLimits(), Date.now() - 10 * 60 * 60 * 1000);
    expect(tracker.checkLimits()).toBeNull();
    expect(longAgoTracker.checkLimits()).toBeNull();
  });

  it("an explicitly configured duration cap still breaches", () => {
    process.env.AGENT_RUN_MAX_DURATION_MS = "1000";
    const tracker = new RunLimitTracker("run-test", loadDefaultRunLimits(), Date.now() - 5000);
    const breach = tracker.checkLimits();
    expect(breach?.kind).toBe("duration");
    expect(breach?.message).toContain("Duration limit exceeded");
  });
});
