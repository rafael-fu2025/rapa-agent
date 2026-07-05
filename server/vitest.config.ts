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
      exclude: ["src/**/*.test.ts", "src/**/*.backup.ts", "src/index.ts"]
    }
  }
});
