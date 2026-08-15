/**
 * Plan-mode state — first-class state on Agent with bus events.
 *
 * See `.agents/notes/implemented/architecture/2026-08-15-plan-mode-as-logged-state.md`.
 */

export type PlanModePhase = "inactive" | "entering" | "active" | "exiting";

export interface PlanStep {
  title: string;
  status: string;
}

export class PlanModeState {
  phase: PlanModePhase = "inactive";
  enteredAt: number | undefined;
  exitedAt: number | undefined;
  /** Steps committed via `plan_tasks`, in order. */
  steps: PlanStep[] = [];
  /** Why the agent entered plan mode. */
  entryReason: "explicit" | "default" | undefined;
  /** Why plan mode exited (only set when phase reaches "inactive"). */
  exitReason: "completed" | "switched_to_agent" | "interrupted" | undefined;

  isActive(): boolean {
    return this.phase === "active" || this.phase === "entering";
  }

  enter(reason: "explicit" | "default", now = Date.now()): void {
    if (this.phase !== "inactive") return;
    this.phase = "entering";
    this.enteredAt = now;
    this.entryReason = reason;
    this.steps = [];
    this.exitReason = undefined;
  }

  activate(now = Date.now()): void {
    if (this.phase !== "entering") return;
    this.phase = "active";
    if (!this.enteredAt) this.enteredAt = now;
  }

  addStep(step: PlanStep): void {
    if (this.phase !== "active" && this.phase !== "entering") return;
    this.steps.push(step);
  }

  exit(reason: "completed" | "switched_to_agent" | "interrupted", now = Date.now()): void {
    if (this.phase !== "active" && this.phase !== "entering") return;
    this.phase = "exiting";
    this.exitedAt = now;
    this.exitReason = reason;
  }

  reset(now = Date.now()): void {
    this.phase = "inactive";
    if (!this.enteredAt) this.enteredAt = now;
    if (!this.exitedAt) this.exitedAt = now;
  }

  /** Snapshot for telemetry / log reconstruction. */
  snapshot(): { phase: PlanModePhase; stepCount: number; enteredAt?: number; exitedAt?: number } {
    return {
      phase: this.phase,
      stepCount: this.steps.length,
      enteredAt: this.enteredAt,
      exitedAt: this.exitedAt
    };
  }
}