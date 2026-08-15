import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true
      }
    },
    testTimeout: 15000,
    hookTimeout: 30000,
    // Tests are read-only and should never hit the network by default.
    // Network calls in the Langfuse exporter are explicitly mocked.
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.backup.ts", "src/index.ts"],
      // Phase 2.4: per-area coverage gate. See
      // `.agents/notes/implemented/testing/2026-08-15-coverage-gate.md`.
      thresholds: {
        // Core agent loop — 70% (ratchet target: 85%).
        "src/lib/agent.ts": { lines: 70, functions: 70, statements: 70, branches: 65 },
        "src/lib/agent/*.ts": { lines: 70, functions: 70, statements: 70, branches: 65 },
        // Tools — 65% (heavy integration surface; mock-friendly).
        "src/tools/*.ts": { lines: 65, functions: 65, statements: 65, branches: 60 },
        // Routes — 60% (HTTP shape; integration-tested via SSE).
        "src/routes/*.ts": { lines: 60, functions: 60, statements: 60, branches: 55 },
        // Lib helpers — 65%.
        "src/lib/*.ts": { lines: 65, functions: 65, statements: 65, branches: 60 },
        // Safety — 80% (small surface; high value).
        "src/lib/safety/*.ts": { lines: 80, functions: 80, statements: 80, branches: 75 }
      }
    }
  }
});
