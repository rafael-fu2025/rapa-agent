import { describe, it, expect, beforeEach } from "vitest";
import { LoopDetector } from "../loop-detector.js";
import type { AgentStep } from "../types.js";

describe("LoopDetector", () => {
  let detector: LoopDetector;

  beforeEach(() => {
    detector = new LoopDetector();
  });

  it("returns no loop for clean sequential executions", () => {
    const step1: AgentStep = {
      iteration: 1,
      reasoning: "reading a",
      toolCalls: [{ id: "1", name: "read_file", parameters: { path: "a.ts" } }],
      toolResults: [{ success: true, output: "contents of a" }],
      timestamp: new Date()
    };
    const res1 = detector.recordAndAnalyze(step1);
    expect(res1.detected).toBe(false);

    const step2: AgentStep = {
      iteration: 2,
      reasoning: "writing a",
      toolCalls: [{ id: "2", name: "write_file", parameters: { path: "a.ts", content: "x" } }],
      toolResults: [{ success: true }],
      timestamp: new Date()
    };
    const res2 = detector.recordAndAnalyze(step2);
    expect(res2.detected).toBe(false);
  });

  it("detects repeated failures on the same file", () => {
    const failedStep = (num: number): AgentStep => ({
      iteration: num,
      reasoning: "editing bad",
      toolCalls: [{ id: String(num), name: 'edit_file', parameters: { path: 'src/app.ts' } }],
      toolResults: [{ success: false, error: 'target text not found' }],
      timestamp: new Date()
    });

    const res1 = detector.recordAndAnalyze(failedStep(1));
    expect(res1.detected).toBe(false);

    const res2 = detector.recordAndAnalyze(failedStep(2));
    expect(res2.detected).toBe(true);
    expect(res2.loopType).toBe("stalled_failure");
    expect(res2.action).toBe("nudge");

    const res3 = detector.recordAndAnalyze(failedStep(3));
    expect(res3.detected).toBe(true);
    expect(res3.action).toBe("rollback_hint");
  });

  it("detects redundant reading without modification", () => {
    const readStep = (num: number): AgentStep => ({
      iteration: num,
      reasoning: "reading again",
      toolCalls: [{ id: String(num), name: 'read_file', parameters: { path: 'src/main.ts' } }],
      toolResults: [{ success: true, output: "contents" }],
      timestamp: new Date()
    });

    detector.recordAndAnalyze(readStep(1));
    detector.recordAndAnalyze(readStep(2));
    const res3 = detector.recordAndAnalyze(readStep(3));
    expect(res3.detected).toBe(true);
    expect(res3.loopType).toBe("redundant_read");
    expect(res3.action).toBe("escalate");
  });

  it("detects cyclic oscillation between two files", () => {
    const makeStep = (num: number, path: string): AgentStep => ({
      iteration: num,
      reasoning: "checking",
      toolCalls: [{ id: String(num), name: 'edit_file', parameters: { path } }],
      toolResults: [{ success: true }],
      timestamp: new Date()
    });

    detector.recordAndAnalyze(makeStep(1, 'fileA.ts'));
    detector.recordAndAnalyze(makeStep(2, 'fileB.ts'));
    detector.recordAndAnalyze(makeStep(3, 'fileA.ts'));
    const res4 = detector.recordAndAnalyze(makeStep(4, 'fileB.ts'));

    expect(res4.detected).toBe(true);
    expect(res4.loopType).toBe("oscillation");
  });
});
