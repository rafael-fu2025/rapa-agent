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
      // Per-area coverage gate. Thresholds are set a few points BELOW the
      // currently-measured numbers so the gate is green today but any
      // regression that deletes tests or adds large untested surface fails
      // the build. Raise each bucket toward the ratchet targets as coverage
      // grows — never lower them without a deliberate decision.
      //
      // Measured 2026-08-22 (457 tests):
      //   agent.ts 52L/64B/63F · agent/* 54L/68F · tools 36L/37F/66B
      //   lib/* 48L/73B/70F · safety 98L
      thresholds: {
        // Core agent loop (ratchet target: 85%).
        "src/lib/agent.ts": { lines: 50, functions: 60, statements: 50, branches: 60 },
        "src/lib/agent/*.ts": { lines: 52, functions: 65, statements: 52, branches: 60 },
        // Tools — heavy integration surface (ratchet target: 65%).
        "src/tools/*.ts": { lines: 33, functions: 35, statements: 33, branches: 60 },
        // Lib helpers (ratchet target: 65%).
        "src/lib/*.ts": { lines: 45, functions: 65, statements: 45, branches: 65 },
        // Safety — small surface, high value; comfortably above the gate.
        "src/lib/safety/*.ts": { lines: 80, functions: 80, statements: 80, branches: 75 }
        // NOTE: no threshold for src/routes/** yet — route handlers currently
        // execute at 0% under vitest (their pure helpers are tested directly
        // in src/routes/_test/). Add an HTTP-level harness first, then gate
        // this bucket.
      }
    }
  }
});
