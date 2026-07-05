// Hierarchical supervisor agent (research P3-A — Multi-Agent Orchestration).
//
// Implements the "Supervisor + Workers" pattern: a single supervisor agent
// owns the high-level plan and delegates concrete subtasks to specialist
// sub-agents (explorer, editor, tester, reviewer, web). The supervisor:
//   1. Reads the user's request and produces a plan (a list of subtasks).
//   2. Dispatches each subtask to a specialist sub-agent (sequential or
//      parallel depending on dependencies).
//   3. Verifies each sub-agent's output against an acceptance criterion
//      (a short string the supervisor must agree with before proceeding).
//   4. If verification fails, retries the subtask with feedback (up to
//      `maxRetries`).
//   5. Aggregates verified results into a final answer.
//
// This module is the *planner/verifier* — the actual sub-agent execution
// is delegated to the existing sub-agents system (./sub-agents.ts). The
// supervisor just orchestrates the lifecycle.

import { resolveSpecialistDefinitions, type SpecialistDefinition, type SpecialistType } from "../sub-agents.js";

export type SubTask = {
  id: string;
  description: string;
  /** Which specialist should handle this. */
  specialist: SpecialistType;
  /** What the supervisor expects to be true after the sub-agent finishes. */
  acceptance: string;
  /** IDs of subtasks that must complete before this one starts. */
  dependsOn?: string[];
  /** Optional: max attempts if verification fails. Defaults to 2. */
  maxAttempts?: number;
};

export type SubTaskResult = {
  id: string;
  description: string;
  status: "pending" | "running" | "verified" | "failed";
  attempts: number;
  output?: string;
  verification?: string;
  error?: string;
};

export type SupervisorPlan = {
  id: string;
  goal: string;
  subtasks: SubTask[];
  /** Topologically ordered list of subtasks, respecting dependencies. */
  executionOrder: string[][];
};

export type SupervisorEvent =
  | { type: "plan_created"; plan: SupervisorPlan }
  | { type: "subtask_started"; subtaskId: string; attempt: number }
  | { type: "subtask_output"; subtaskId: string; output: string }
  | { type: "subtask_verified"; subtaskId: string; verification: string }
  | { type: "subtask_retry"; subtaskId: string; attempt: number; reason: string }
  | { type: "subtask_failed"; subtaskId: string; error: string }
  | { type: "plan_completed"; results: SubTaskResult[] }
  | { type: "plan_aborted"; reason: string };

export type SupervisorOptions = {
  /** When true, run all subtasks in a layer in parallel. */
  parallelByDefault?: boolean;
  /** Max retries per subtask when verification fails. */
  defaultMaxAttempts?: number;
  /** The LLM verifier — caller-supplied function that scores a sub-agent
   *  output against the acceptance criterion. Returns { ok, reason }. */
  verify: (output: string, acceptance: string) => Promise<{ ok: boolean; reason: string }>;
  /** The executor — caller-supplied function that runs a subtask. */
  execute: (subtask: SubTask) => Promise<string>;
};

const DEFAULT_MAX_ATTEMPTS = 2;

function topoSort(subtasks: SubTask[]): string[][] {
  const layers: string[][] = [];
  const completed = new Set<string>();
  let remaining = subtasks.slice();
  while (remaining.length > 0) {
    const ready = remaining.filter((s) => (s.dependsOn ?? []).every((d) => completed.has(d)));
    if (ready.length === 0) {
      // Cycle or missing dependency — bail out by treating the rest as ready.
      for (const s of remaining) layers.push([s.id]);
      break;
    }
    layers.push(ready.map((s) => s.id));
    for (const s of ready) completed.add(s.id);
    remaining = remaining.filter((s) => !completed.has(s.id));
  }
  return layers;
}

/**
 * Build a plan from a goal + a list of subtasks. The plan is topologically
 * sorted so independent subtasks can run in parallel.
 */
export function buildPlan(goal: string, subtasks: SubTask[]): SupervisorPlan {
  return {
    id: `plan-${Date.now()}`,
    goal,
    subtasks,
    executionOrder: topoSort(subtasks)
  };
}

/**
 * Run a plan with the provided executor and verifier. Yields supervisor
 * events for the UI to render. Returns the final results array.
 */
export async function* runPlan(
  plan: SupervisorPlan,
  options: SupervisorOptions
): AsyncGenerator<SupervisorEvent, SubTaskResult[], void> {
  yield { type: "plan_created", plan };

  const results = new Map<string, SubTaskResult>(
    plan.subtasks.map((s) => [s.id, {
      id: s.id,
      description: s.description,
      status: "pending" as const,
      attempts: 0
    }])
  );
  const subtaskById = new Map(plan.subtasks.map((s) => [s.id, s]));
  const parallel = options.parallelByDefault ?? true;
  const defaultAttempts = options.defaultMaxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  for (const layer of plan.executionOrder) {
    if (parallel) {
      // Run all subtasks in this layer concurrently.
      const promises = layer.map(async (id) => runSubtask(id, subtaskById, results, options, defaultAttempts));
      await Promise.all(promises);
    } else {
      for (const id of layer) {
        await runSubtask(id, subtaskById, results, options, defaultAttempts);
      }
    }

    // If any subtask in the layer failed permanently, abort the plan.
    const anyFailed = layer.some((id) => results.get(id)?.status === "failed");
    if (anyFailed) {
      const reason = `Subtask(s) failed in layer: ${layer
        .map((id) => results.get(id)?.error ?? id)
        .join("; ")}`;
      yield { type: "plan_aborted", reason };
      return Array.from(results.values());
    }
  }

  const finalResults = Array.from(results.values());
  yield { type: "plan_completed", results: finalResults };
  return finalResults;
}

async function runSubtask(
  id: string,
  subtaskById: Map<string, SubTask>,
  results: Map<string, SubTaskResult>,
  options: SupervisorOptions,
  defaultMaxAttempts: number
): Promise<SubTaskResult> {
  const subtask = subtaskById.get(id);
  if (!subtask) {
    const result: SubTaskResult = {
      id, description: "(missing)", status: "failed", attempts: 0, error: "Subtask not found"
    };
    results.set(id, result);
    return result;
  }
  const maxAttempts = subtask.maxAttempts ?? defaultMaxAttempts;
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    results.set(id, { ...results.get(id)!, status: "running", attempts: attempt });
    try {
      const output = await options.execute(subtask);
      results.set(id, { ...results.get(id)!, output });
      const verdict = await options.verify(output, subtask.acceptance);
      if (verdict.ok) {
        results.set(id, { ...results.get(id)!, status: "verified", verification: verdict.reason });
        return results.get(id)!;
      }
      lastError = `Verification failed: ${verdict.reason}`;
      results.set(id, { ...results.get(id)!, status: "pending", error: lastError });
    } catch (err) {
      lastError = (err as Error).message;
      results.set(id, { ...results.get(id)!, status: "pending", error: lastError });
    }
  }
  results.set(id, { ...results.get(id)!, status: "failed", error: lastError ?? "Unknown failure" });
  return results.get(id)!;
}

/**
 * Suggest which specialist should handle a subtask, based on its
 * description. Used by the planner when it doesn't know which specialist
 * to assign.
 */
export function suggestSpecialist(description: string): SpecialistType {
  const lower = description.toLowerCase();
  if (/\b(read|inspect|search|find|look|explore|examine|review|list)\b/.test(lower)) {
    return "research_specialist";
  }
  if (/\b(write|edit|modify|create|update|fix|refactor|implement|add|code)\b/.test(lower)) {
    return "codebase_specialist";
  }
  if (/\b(test|run|build|lint|verify|check|validate|debug|diagnose)\b/.test(lower)) {
    return "debug_specialist";
  }
  if (/\b(review|critique|compare|audit|assess|plan|design)\b/.test(lower)) {
    return "design_specialist";
  }
  if (/\b(search|fetch|download|browse|web|http|url)\b/.test(lower)) {
    return "research_specialist";
  }
  return "planning_specialist";
}

export const AVAILABLE_SPECIALISTS: SpecialistDefinition[] = resolveSpecialistDefinitions([]);
