// Anti-Stall, Oscillation & Cyclic Loop Detection Engine.
//
// Monitors tool call trajectories across steps to detect:
// 1. Oscillation: alternating back and forth between tools/files (A -> B -> A -> B).
// 2. Deadlock / Stalled Errors: repeating identical failures on the same file/command.
// 3. Redundant Reading: reading the exact same file 3+ times without any modifications.

import type { AgentStep, ToolCall } from "./types.js";

export type LoopType = "oscillation" | "stalled_failure" | "redundant_read" | "none";

export type LoopDetectionResult = {
  detected: boolean;
  loopType: LoopType;
  action: "none" | "nudge" | "escalate" | "rollback_hint";
  message?: string;
  target?: string;
};

export type StepFingerprint = {
  stepIndex: number;
  toolNames: string[];
  primaryTarget: string;
  hasFailure: boolean;
  errorMessage?: string;
};

export class LoopDetector {
  private history: StepFingerprint[] = [];
  private consecutiveFailuresOnTarget: Map<string, number> = new Map();
  private readCountsSinceMutation: Map<string, number> = new Map();

  reset(): void {
    this.history = [];
    this.consecutiveFailuresOnTarget.clear();
    this.readCountsSinceMutation.clear();
  }

  recordAndAnalyze(step: AgentStep): LoopDetectionResult {
    const toolCalls = step.toolCalls ?? [];
    const toolResults = step.toolResults ?? [];
    if (toolCalls.length === 0) {
      return { detected: false, loopType: 'none', action: 'none' };
    }

    const primaryTool = toolCalls[0];
    const target = this.extractTarget(primaryTool);
    const failedIndex = toolResults.findIndex(r => r.success === false);
    const hasFailure = failedIndex !== -1;
    const failedCall = failedIndex !== -1 ? toolCalls[failedIndex] : undefined;
    const errorMessage = failedIndex !== -1 ? toolResults[failedIndex].error : undefined;

    const fingerprint: StepFingerprint = {
      stepIndex: step.iteration,
      toolNames: toolCalls.map(tc => tc.name),
      primaryTarget: target,
      hasFailure,
      errorMessage
    };

    this.history.push(fingerprint);
    if (this.history.length > 12) {
      this.history.shift();
    }

    const isMutation = toolCalls.some(tc =>
      ['write_file', 'edit_file', 'replace_in_file', 'append_file', 'delete_file'].includes(tc.name)
    );

    if (isMutation) {
      this.readCountsSinceMutation.clear();
    }

    if (hasFailure && target) {
      const failedToolName = failedCall?.name ?? primaryTool.name;
      const failKey = `${failedToolName}:${target}`;
      const currentFails = (this.consecutiveFailuresOnTarget.get(failKey) ?? 0) + 1;
      this.consecutiveFailuresOnTarget.set(failKey, currentFails);

      if (currentFails >= 3) {
        return {
          detected: true,
          loopType: "stalled_failure",
          action: "rollback_hint",
          target,
          message: `Loop Guard: Tool '${failedToolName}' has failed ${currentFails} times in a row on '${target}'. Stop repeating the same action. Switch strategy: read the full file with read_file, use write_file for a complete rewrite, or revisit your assumptions.`
        };
      } else if (currentFails === 2) {
        return {
          detected: true,
          loopType: "stalled_failure",
          action: "nudge",
          target,
          message: `Loop Warning: '${failedToolName}' failed twice on '${target}'. Error: ${errorMessage ?? 'unknown'}. Carefully inspect the file content before attempting another edit.`
        };
      }
    } else if (!hasFailure && target) {
      this.consecutiveFailuresOnTarget.delete(`${primaryTool.name}:${target}`);
    }

    const isRead = toolCalls.some(tc => tc.name === "read_file");
    if (isRead && target && !isMutation) {
      const readCount = (this.readCountsSinceMutation.get(target) ?? 0) + 1;
      this.readCountsSinceMutation.set(target, readCount);

      if (readCount >= 3) {
        return {
          detected: true,
          loopType: "redundant_read",
          action: "escalate",
          target,
          message: `Loop Guard: You have read '${target}' ${readCount} times without modifying it or running other actions. Stop re-reading. Take concrete action: apply changes with edit_file or move to the next task step.`
        };
      }
    }

    if (this.history.length >= 4) {
      const h = this.history;
      const n = h.length;
      const step1 = h[n - 4];
      const step2 = h[n - 3];
      const step3 = h[n - 2];
      const step4 = h[n - 1];

      const isOscillating =
        step1.primaryTarget === step3.primaryTarget &&
        step2.primaryTarget === step4.primaryTarget &&
        step1.primaryTarget !== step2.primaryTarget &&
        step1.primaryTarget.length > 0 &&
        step2.primaryTarget.length > 0;

      if (isOscillating) {
        return {
          detected: true,
          loopType: 'oscillation',
          action: 'escalate',
          target: `${step3.primaryTarget} <-> ${step4.primaryTarget}`,
          message: `Loop Guard: Oscillation detected between '${step3.primaryTarget}' and '${step4.primaryTarget}'. Stop toggling between these files. Step back, synthesize the root cause, and implement a unified fix.`
        };
      }
    }

    return { detected: false, loopType: 'none', action: 'none' };
  }

  private extractTarget(call: ToolCall): string {
    const p = call.parameters ?? {};
    if (typeof p.path === 'string' && p.path) return p.path;
    if (typeof p.filePath === 'string' && p.filePath) return p.filePath;
    if (typeof p.target_file === 'string' && p.target_file) return p.target_file;
    if (typeof p.command === 'string' && p.command) return p.command.slice(0, 40);
    if (typeof p.query === 'string' && p.query) return p.query;
    return call.name;
  }
}
