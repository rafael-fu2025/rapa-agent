/**
 * Workflow engine — SKELETON.
 *
 * See `.agents/notes/proposed/architecture/2026-08-15-workflow-engine.md`
 * (status: proposed). This file seeds the API for the next
 * contributor; the executor, worker-thread provider, and
 * checkpoint persistence are not yet implemented.
 *
 * The intent: a typed DAG of tasks, topological execution,
 * checkpoint per task, bus events for observability.
 */

import type { AgentEventBus } from "./event-bus.js";

export type WorkflowTaskStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface WorkflowTask<TInput = unknown, TOutput = unknown> {
  id: string;
  /** Task IDs this one depends on. Topological order: dependencies run first. */
  dependsOn: string[];
  run: (input: TInput, ctx: WorkflowContext) => Promise<TOutput>;
}

export interface WorkflowDefinition<TOutput = Record<string, unknown>> {
  name: string;
  tasks: WorkflowTask[];
  /** Optional entry-point task; defaults to the first task with no dependencies. */
  entryTaskId?: string;
  /** Optional output mapping from task results; defaults to the entry task's output. */
  outputOf?: (results: Record<string, unknown>) => TOutput;
}

export interface WorkflowContext {
  /** Read-only access to the agent's bus (for emitting task events). */
  readonly events: AgentEventBus;
  /** Abort signal for cancellation. */
  readonly signal: AbortSignal;
  /** Checkpoint persistence hook. */
  checkpoint(taskId: string, result: unknown): Promise<void>;
}

/**
 * WorkflowRunner — SKELETON.
 *
 * The actual implementation will:
 * 1. Topologically sort the DAG.
 * 2. For each ready task, run it (optionally on a worker thread).
 * 3. Emit `workflow/task/start`, `workflow/task/end` on the bus.
 * 4. Persist a checkpoint after every task completion.
 * 5. Honor the abort signal between tasks.
 *
 * Not yet implemented.
 */
export class WorkflowRunner<TOutput = Record<string, unknown>> {
  constructor(
    private readonly definition: WorkflowDefinition<TOutput>,
    private readonly bus: AgentEventBus,
    private readonly abortSignal: AbortSignal = new AbortController().signal
  ) {}

  async run(): Promise<TOutput> {
    throw new Error(
      "WorkflowRunner.run() is not yet implemented. " +
      "See `.agents/notes/proposed/architecture/2026-08-15-workflow-engine.md`."
    );
  }

  /** Future: serialize the in-flight state for crash recovery. */
  snapshot(): unknown {
    throw new Error("not implemented");
  }
}