/**
 * Plan-mode state + bus integration tests.
 *
 * See `.agents/notes/implemented/architecture/2026-08-15-plan-mode-as-logged-state.md`.
 */

import { describe, expect, it } from "vitest";

import { PlanModeState } from "../plan-mode-state.js";

describe("PlanModeState", () => {
  it("starts inactive", () => {
    const state = new PlanModeState();
    expect(state.phase).toBe("inactive");
    expect(state.isActive()).toBe(false);
  });

  it("transitions inactive → entering → active", () => {
    const state = new PlanModeState();
    state.enter("explicit", 1000);
    expect(state.phase).toBe("entering");
    expect(state.isActive()).toBe(true);
    expect(state.enteredAt).toBe(1000);

    state.activate(1050);
    expect(state.phase).toBe("active");
  });

  it("addStep records steps in order", () => {
    const state = new PlanModeState();
    state.enter("explicit");
    state.activate();
    state.addStep({ title: "Read agent.ts", status: "pending" });
    state.addStep({ title: "Draft turn/step plan", status: "pending" });
    expect(state.steps).toEqual([
      { title: "Read agent.ts", status: "pending" },
      { title: "Draft turn/step plan", status: "pending" }
    ]);
  });

  it("addStep is ignored when not in plan mode", () => {
    const state = new PlanModeState();
    state.addStep({ title: "x", status: "pending" });
    expect(state.steps).toEqual([]);
  });

  it("exit marks phase 'exiting' then reset returns to 'inactive'", () => {
    const state = new PlanModeState();
    state.enter("explicit");
    state.activate();
    state.addStep({ title: "a", status: "pending" });
    state.exit("completed", 2000);
    expect(state.phase).toBe("exiting");
    expect(state.exitReason).toBe("completed");
    expect(state.exitedAt).toBe(2000);

    state.reset();
    expect(state.phase).toBe("inactive");
  });

  it("exit is no-op when plan mode was never entered", () => {
    const state = new PlanModeState();
    state.exit("completed");
    expect(state.phase).toBe("inactive");
  });

  it("snapshot returns current state for telemetry", () => {
    const state = new PlanModeState();
    state.enter("default", 100);
    state.activate();
    state.addStep({ title: "x", status: "done" });
    state.exit("completed", 500);
    const snap = state.snapshot();
    expect(snap.phase).toBe("exiting");
    expect(snap.stepCount).toBe(1);
    expect(snap.enteredAt).toBe(100);
    expect(snap.exitedAt).toBe(500);
  });
});