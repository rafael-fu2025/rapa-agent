/**
 * LifecycleObserver — a simple bus consumer that tracks agent turn
 * and step lifecycle metrics.
 *
 * Demonstrates the event bus's serial listener pattern. Future
 * observers (telemetry, audit, mode-switch prompts) follow the same
 * shape: take an `Agent`, attach listeners, expose a small API for
 * consumers to read the observed state.
 *
 * See `.agents/notes/implemented/architecture/2026-08-15-in-process-event-bus.md`.
 */

import type { Agent } from "../agent.js";
import type { AgentEventBus } from "./event-bus.js";

export interface TurnRecord {
  conversationId: string;
  mode: string;
  iterationBudget: number;
  startedAt: number;
  endedAt?: number;
  status?: "completed" | "max_iterations" | "failed" | "interrupted" | "aborted";
  iterations?: number;
  elapsedMs?: number;
}

export interface StepRecord {
  iteration: number;
  startedAt: number;
}

/**
 * Observe a single Agent's lifecycle. Call `attach(agent)` once,
 * then read `turns` and `steps` to inspect what happened. The
 * observer stores one record per event and never blocks the bus.
 */
export class LifecycleObserver {
  readonly turns: TurnRecord[] = [];
  readonly steps: StepRecord[] = [];
  private disposers: Array<() => void> = [];

  attach(agent: Agent): void {
    this.disposers.push(
      agent.events.on("agent/turn/start", (p) => {
        this.turns.push({
          conversationId: p.conversationId,
          mode: p.mode,
          iterationBudget: p.iterationBudget,
          startedAt: Date.now()
        });
      }),
      agent.events.on("agent/turn/end", (p) => {
        const current = this.turns[this.turns.length - 1];
        if (current) {
          current.endedAt = Date.now();
          current.status = p.status;
          current.iterations = p.iterations;
          current.elapsedMs = p.elapsedMs;
        }
      }),
      agent.events.on("agent/step/start", (p) => {
        this.steps.push({ iteration: p.iteration, startedAt: Date.now() });
      })
    );
  }

  detach(): void {
    for (const off of this.disposers) off();
    this.disposers = [];
  }

  /** Summary helper for tests and diagnostics. */
  summary(): { turns: number; steps: number; lastTurnDurationMs?: number } {
    const lastTurn = this.turns[this.turns.length - 1];
    return {
      turns: this.turns.length,
      steps: this.steps.length,
      lastTurnDurationMs: lastTurn?.elapsedMs
    };
  }
}

// Re-export for convenience — consumers importing this module get
// the bus type without a separate import.
export type { AgentEventBus };