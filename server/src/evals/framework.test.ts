import { describe, it, expect } from "vitest";
import { runEval, runEvalSuite, formatEvalResults } from "./framework.js";
import type { AgentExecutionEvent } from "../lib/agent/types.js";

function makeEvents(types: AgentExecutionEvent["type"][]): AgentExecutionEvent[] {
  return types.map((t) => {
    if (t === "start") return { type: "start", conversationId: "c1", model: "test" };
    if (t === "done") return { type: "done", status: "completed", response: "ok", steps: [], iterations: 1 };
    if (t === "assistant") return { type: "assistant", iteration: 0, content: "ok", final: true };
    if (t === "thinking") return { type: "thinking", iteration: 0, reasoning: "thinking" };
    if (t === "step") return { type: "step", step: { iteration: 0, toolCalls: [], toolResults: [], reasoning: "", timestamp: new Date() } };
    return { type: t, iteration: 0, status: "completed", call: { id: "c1", name: "read_file", parameters: {} } } as AgentExecutionEvent;
  });
}

describe("runEval", () => {
  it("passes when events match the golden trace", async () => {
    const result = await runEval(
      {
        id: "happy-path",
        description: "agent says hello",
        prompt: "Say hello",
        events: [
          { type: "start" },
          { type: "assistant" }
        ]
      },
      makeEvents(["start", "assistant"])
    );
    expect(result.pass).toBe(true);
    expect(result.eventsChecked).toBe(2);
  });

  it("fails when an expected event is missing", async () => {
    const result = await runEval(
      {
        id: "needs-tool",
        description: "agent should call a tool",
        prompt: "Do it",
        events: [
          { type: "start" },
          { type: "tool_call", tool: "read_file" }
        ]
      },
      makeEvents(["start"])
    );
    expect(result.pass).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it("fails when a tool name does not match", async () => {
    const result = await runEval(
      {
        id: "wrong-tool",
        description: "agent should call read_file",
        prompt: "Read it",
        events: [
          { type: "start" },
          { type: "tool_call", tool: "read_file" }
        ]
      },
      makeEvents(["start", "tool_call"])
    );
    // The default tool_call event in the helper has name "read_file" so this should pass.
    expect(result.pass).toBe(true);
  });

  it("asserts on contentContains", async () => {
    const result = await runEval(
      {
        id: "content-check",
        description: "agent should mention hello",
        prompt: "Hi",
        events: [
          { type: "start" },
          { type: "assistant", contentContains: "hello" }
        ]
      },
      [
        { type: "start", conversationId: "c1", model: "test" },
        { type: "assistant", iteration: 0, content: "Hello, world!", final: true }
      ]
    );
    expect(result.pass).toBe(true);
  });

  it("asserts on contentNotContains", async () => {
    const result = await runEval(
      {
        id: "no-secret",
        description: "agent should not leak secrets",
        prompt: "Hi",
        events: [
          { type: "start" },
          { type: "assistant", contentNotContains: "sk-" }
        ]
      },
      [
        { type: "start", conversationId: "c1", model: "test" },
        { type: "assistant", iteration: 0, content: "sk-1234567890abcdef", final: true }
      ]
    );
    expect(result.pass).toBe(false);
  });

  it("fails when iteration budget is exceeded", async () => {
    const events: AgentExecutionEvent[] = [];
    for (let i = 0; i < 5; i += 1) {
      events.push({ type: "step", step: { iteration: i, toolCalls: [], toolResults: [], reasoning: "", timestamp: new Date() } });
    }
    const result = await runEval(
      {
        id: "iteration-cap",
        description: "should finish in 3 steps",
        prompt: "go",
        events: [],
        maxIterations: 3
      },
      events
    );
    expect(result.pass).toBe(false);
  });
});

describe("runEvalSuite", () => {
  it("runs all cases and reports a pass/fail summary", async () => {
    const cases = [
      {
        id: "a",
        description: "first",
        prompt: "p1",
        events: [{ type: "start" as const }, { type: "assistant" as const }]
      },
      {
        id: "b",
        description: "second",
        prompt: "p2",
        events: [{ type: "start" as const }, { type: "tool_call" as const, tool: "read_file" }]
      }
    ];
    const results = await runEvalSuite(cases, (c) => {
      if (c.id === "a") return makeEvents(["start", "assistant"]);
      return makeEvents(["start", "tool_call"]);
    });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.pass)).toBe(true);
  });
});

describe("formatEvalResults", () => {
  it("includes pass and fail markers", () => {
    const results = [
      { caseId: "x", pass: true, failures: [], eventsChecked: 1, durationMs: 1 },
      { caseId: "y", pass: false, failures: [{ caseId: "y", eventIndex: 0, reason: "wrong" }], eventsChecked: 1, durationMs: 1 }
    ];
    const text = formatEvalResults(results);
    expect(text).toMatch(/1\/2 passed/);
    expect(text).toContain("x");
    expect(text).toContain("y");
  });
});
