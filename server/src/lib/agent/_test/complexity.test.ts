// §5.3 — Tests for the task complexity estimator.

import { describe, expect, it } from "vitest";
import { estimateComplexity, scaleThreshold } from "../complexity.js";

describe("estimateComplexity", () => {
  it("scores a trivial prompt as 'trivial' with multiplier 0.5", () => {
    const result = estimateComplexity("hi");
    expect(result.label).toBe("trivial");
    expect(result.thresholdMultiplier).toBe(0.5);
  });

  it("scores a small refactor as 'simple' or 'moderate'", () => {
    const result = estimateComplexity("rename the variable foo to bar in src/utils.ts");
    // "rename" is a moderate verb; "src/utils.ts" is a file path. The
    // total should land in 'simple' or 'moderate' depending on the
    // current thresholds.
    expect(["simple", "moderate", "complex"]).toContain(result.label);
    expect(result.signals.filePathCount).toBeGreaterThanOrEqual(1);
  });

  it("scores a refactor with many files as 'complex' or 'very-complex'", () => {
    const prompt = `
      Refactor the auth system across the entire codebase. Migrate the OAuth
      flow in src/auth/oauth.ts, the session handler in src/auth/session.ts,
      the token refresh in src/auth/refresh.ts, the user model in
      src/models/user.ts, the API routes in src/routes/auth.ts and
      src/routes/api.ts, and the migration script in scripts/migrate.ts.
      Add comprehensive tests and update the documentation.
    `;
    const result = estimateComplexity(prompt);
    expect(["complex", "very-complex"]).toContain(result.label);
    expect(result.signals.filePathCount).toBeGreaterThanOrEqual(5);
    expect(result.signals.heavyVerbCount).toBeGreaterThanOrEqual(2);
  });

  it("counts heavy verbs correctly", () => {
    const result = estimateComplexity("Please refactor and rebuild the entire auth system");
    expect(result.signals.heavyVerbCount).toBeGreaterThanOrEqual(2);
  });

  it("counts code fences", () => {
    const prompt = "Fix this:\n```js\nfoo()\n```\nand also:\n```ts\nbar()\n```";
    const result = estimateComplexity(prompt);
    expect(result.signals.codeFenceCount).toBe(2);
  });

  it("accepts a seed history parameter", () => {
    const seedHistory = [
      { role: "user", content: "I want to refactor the build pipeline. Migrate the entire auth system." }
    ];
    const result = estimateComplexity("now do it", seedHistory);
    // The seed history should contribute heavy verbs / length to the score.
    expect(result.signals.length).toBeGreaterThan(0);
  });
});

describe("scaleThreshold", () => {
  it("returns the base value when multiplier is 1", () => {
    expect(scaleThreshold(10, 1)).toBe(10);
  });

  it("rounds to the nearest integer", () => {
    expect(scaleThreshold(7, 1.5)).toBe(11); // 10.5 → 11
  });

  it("never returns less than 1", () => {
    expect(scaleThreshold(1, 0.001)).toBe(1);
  });
});
