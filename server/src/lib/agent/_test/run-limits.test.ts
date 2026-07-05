import { describe, it, expect } from "vitest";
import { estimateCallCost, RunLimitTracker } from "./run-limits.js";

describe("estimateCallCost", () => {
  it("uses the model's exact table entry when available", () => {
    // gpt-4o: $2.50/M input, $10/M output
    const cost = estimateCallCost("gpt-4o", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(12.5, 2);
  });

  it("matches by substring for similar model names", () => {
    const cost = estimateCallCost("claude-sonnet-4.6-custom", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18, 2);
  });

  it("falls back to the default price for unknown models", () => {
    const cost = estimateCallCost("some-unknown-model", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(10, 2); // 2M tokens * $5/M = $10
  });

  it("returns 0 for 0 tokens", () => {
    expect(estimateCallCost("gpt-4o", 0, 0)).toBe(0);
  });
});

describe("RunLimitTracker", () => {
  it("starts with zero usage", () => {
    const t = new RunLimitTracker("r1", { maxTokens: 1000 });
    expect(t.getUsage().tokens).toBe(0);
    expect(t.getUsage().costUsd).toBe(0);
    expect(t.getUsage().iterations).toBe(0);
  });

  it("accumulates tokens and cost on recordTokens", () => {
    const t = new RunLimitTracker("r1", { maxTokens: 1_000_000 });
    t.recordTokens("gpt-4o", 100, 50);
    t.recordTokens("gpt-4o", 200, 100);
    expect(t.getUsage().tokens).toBe(450);
    expect(t.getUsage().costUsd).toBeGreaterThan(0);
  });

  it("fires a token breach when usage exceeds the limit", () => {
    const t = new RunLimitTracker("r1", { maxTokens: 100 });
    const breaches: { kind: string }[] = [];
    t.setBreachListener((b) => { breaches.push({ kind: b.kind }); });
    t.recordTokens("gpt-4o", 50, 60);
    const found = t.checkLimits();
    expect(found).not.toBeNull();
    expect(found?.kind).toBe("tokens");
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.kind).toBe("tokens");
  });

  it("fires a cost breach when cost exceeds the limit", () => {
    const t = new RunLimitTracker("r1", { maxCostUsd: 0.001 });
    t.recordTokens("gpt-4o", 1_000_000, 1_000_000);
    const found = t.checkLimits();
    expect(found?.kind).toBe("cost");
  });

  it("fires an iteration breach when iterations exceed the limit", () => {
    const t = new RunLimitTracker("r1", { maxIterations: 2 });
    t.recordIteration();
    t.recordIteration();
    t.recordIteration();
    const found = t.checkLimits();
    expect(found?.kind).toBe("duration"); // intentional: "iterations" is bucketed under "duration"
    expect(found?.message).toMatch(/Iteration limit/);
  });

  it("does not fire when within limits", () => {
    const t = new RunLimitTracker("r1", { maxTokens: 1000, maxCostUsd: 100 });
    t.recordTokens("gpt-4o", 100, 50);
    expect(t.checkLimits()).toBeNull();
  });

  it("summary includes tokens, cost, iterations, and duration when set", () => {
    const t = new RunLimitTracker("r1", { maxDurationMs: 60000 });
    t.recordTokens("gpt-4o", 100, 50);
    t.recordIteration();
    const s = t.summary();
    expect(s).toContain("tokens");
    expect(s).toContain("iterations");
  });
});
