import { describe, it, expect } from "vitest";
import { buildPlan, runPlan, suggestSpecialist, type SubTask } from "../supervisor.js";

function makeSubtasks(): SubTask[] {
  return [
    {
      id: "explore",
      description: "Find the main entry file",
      specialist: "research_specialist",
      acceptance: "Output contains 'src/index.ts'",
      dependsOn: []
    },
    {
      id: "edit",
      description: "Add a hello world function",
      specialist: "codebase_specialist",
      acceptance: "Output contains 'function hello'",
      dependsOn: ["explore"]
    },
    {
      id: "test",
      description: "Run the test suite",
      specialist: "debug_specialist",
      acceptance: "Output contains 'all tests passed'",
      dependsOn: ["edit"]
    }
  ];
}

describe("buildPlan", () => {
  it("topologically orders subtasks", () => {
    const plan = buildPlan("Ship a hello world", makeSubtasks());
    expect(plan.executionOrder).toEqual([
      ["explore"],
      ["edit"],
      ["test"]
    ]);
  });

  it("groups independent subtasks in the same layer", () => {
    const tasks: SubTask[] = [
      { id: "a", description: "a", specialist: "research_specialist", acceptance: "a" },
      { id: "b", description: "b", specialist: "research_specialist", acceptance: "b" },
      { id: "c", description: "c", specialist: "codebase_specialist", acceptance: "c", dependsOn: ["a", "b"] }
    ];
    const plan = buildPlan("test", tasks);
    expect(plan.executionOrder).toEqual([
      ["a", "b"],
      ["c"]
    ]);
  });

  it("handles missing dependencies without infinite-looping", () => {
    const tasks: SubTask[] = [
      { id: "a", description: "a", specialist: "research_specialist", acceptance: "a", dependsOn: ["ghost"] }
    ];
    const plan = buildPlan("test", tasks);
    expect(plan.executionOrder[0]).toContain("a");
  });
});

describe("runPlan", () => {
  it("completes all subtasks in order with the executor and verifier", async () => {
    const plan = buildPlan("test", makeSubtasks());
    const events: string[] = [];
    const iter = runPlan(plan, {
      parallelByDefault: false,
      execute: async (s) => `Output for ${s.id}`,
      verify: async (output, acceptance) => ({
        ok: true,
        reason: `Output matches "${acceptance}"`
      })
    });
    for await (const event of iter) {
      events.push(event.type);
    }
    expect(events).toContain("plan_created");
    expect(events).toContain("plan_completed");
  });

  it("retries a subtask when verification fails", async () => {
    const plan = buildPlan("test", makeSubtasks());
    let calls = 0;
    const events: string[] = [];
    const iter = runPlan(plan, {
      parallelByDefault: false,
      execute: async (s) => {
        calls += 1;
        return s.id === "explore" ? "src/index.ts" : "wrong output";
      },
      verify: async (output, acceptance) => ({
        ok: output.includes(acceptance.split(" ").pop() ?? ""),
        reason: output
      })
    });
    for await (const event of iter) {
      events.push(event.type);
    }
    // Plan should have aborted because the first layer's subtask failed
    // verification after the configured number of attempts.
    expect(events).toContain("plan_aborted");
    // Explore was retried at least once (default maxAttempts is 2).
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe("suggestSpecialist", () => {
  it("suggests research_specialist for read-style tasks", () => {
    expect(suggestSpecialist("Find the main entry file")).toBe("research_specialist");
  });

  it("suggests codebase_specialist for write-style tasks", () => {
    expect(suggestSpecialist("Refactor the read_file function")).toBe("codebase_specialist");
  });

  it("suggests debug_specialist for run-style tasks", () => {
    expect(suggestSpecialist("Run the linter and report errors")).toBe("debug_specialist");
  });

  it("suggests design_specialist for critique-style tasks", () => {
    expect(suggestSpecialist("Audit the security model")).toBe("design_specialist");
  });

  it("suggests research_specialist for fetch-style tasks", () => {
    expect(suggestSpecialist("Fetch the latest release notes")).toBe("research_specialist");
  });
});
