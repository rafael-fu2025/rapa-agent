# Plan mode as logged state

Status: implemented
Date: 2026-08-15
Scope: architecture

## Context

The `mode: "plan"` config knob in `AgentConfig` currently does three
things in scattered places:

1. `prompt-builder.ts` filters tools to deny `execute_command`,
   `write_file`, `edit_file`.
2. `run-limits.ts` (via `DEFAULT_MAX_ITERATIONS_BY_MODE`) raises
   the iteration budget to 25 for plan runs.
3. The frontend (and `mode-switch-prompt.tsx`) shows a plan-mode
   banner.

There is no first-class *state* on the `Agent` for "we are in plan
mode right now". The mode is read from `this.context.mode` at
multiple call sites and re-evaluated each time. A consumer wanting to
ask "is this turn planning or executing?" has to scan the config or
the wire events for implicit cues.

This makes two things hard:

- **Observability.** A logging observer can't distinguish "user
  entered plan mode" from "user is just chatting about a plan"; both
  are `mode: "plan"` runs.
- **Reconstruction.** Given a saved session log, a future consumer
  cannot tell *when* plan mode was entered and exited within a
  longer run. (Plan mode today is a property of a whole `Agent`
  invocation, not a mid-run transition.)

## Decision

Add a first-class `PlanModeState` on the `Agent` and three bus
events: `plan/enter`, `plan/step`, `plan/exit`.

### State

```typescript
type PlanModePhase = "inactive" | "entering" | "active" | "exiting";

class PlanModeState {
  phase: PlanModePhase = "inactive";
  enteredAt?: number;
  exitedAt?: number;
  /** Plan steps committed via plan_tasks, in order. */
  steps: Array<{ title: string; status: string }> = [];
}
```

`Agent` exposes `readonly plan = new PlanModeState()`. The state
transitions are:

- `inactive → entering` — when `mode === "plan"` is detected at the
  top of `stream()`, before `turn/start`.
- `entering → active` — when the first iteration emits
  `step/start`.
- `active → exiting` — when a tool-free round produces a final
  assistant message.
- `exiting → inactive` — when `turn/end` is emitted.

### Bus events

Three new events on the existing `AgentEventBus`:

```typescript
type PlanEventMap = {
  "plan/enter": { mode: "plan"; conversationId: string; reason: "explicit" | "default" };
  "plan/step": { step: { title: string; status: string }; index: number };
  "plan/exit": { reason: "completed" | "switched_to_agent" | "interrupted"; finalStepCount: number };
};
```

These events ride the existing bus; serial listeners see them in
order, waterfall listeners can mutate (e.g., a `plan/enter`
interceptor that pre-loads context).

### Tool filtering via capability registry

Phase 2.1's `CapabilityRegistry.listByRisk("read")` already gives us
the right primitive. Plan mode restricts available tools to risk
≤ `read` (no `write`, `network`, or `destructive`). The orchestrator
already calls `getAvailableTools(mode, …)`; we replace its
hardcoded denylist with a call to `listByRisk`.

## Consequences

**Easier:**

- A future consumer (telemetry, audit, UI banner) can subscribe to
  `plan/enter` / `plan/exit` and react in real time, not by
  re-parsing the mode config.
- Plan steps (from `plan_tasks`) can be logged as `plan/step` events
  for replay; this enables plan reconstruction from logs.
- The capability registry's `listByRisk` makes "what tools are
  available in this mode" a registry-level query, not a
  prompt-builder concern.

**Harder:**

- Plan mode state lives on the `Agent`; the same `Agent` instance
  cannot switch modes mid-run without resetting state. (This is
  already true — the change just makes it explicit.)
- A regression in `listByRisk` ordering would silently change which
  tools plan mode allows. The risk ordering must stay in sync with
  `ToolRiskLevel`'s declaration order; we add a test.

**Follow-ups:**

- Phase 3.3 (self-modification): a `plan/enter` waterfall listener
  can mount a "plan-mode-only" plugin bundle.
- A `PlanLog` consumer that persists `plan/step` events to a file
  (one per conversation) for plan-mode-only audit.

## Alternatives considered

- **Add a new `mode: "planning"` to the existing `mode` union.**
  Rejected: there's only one planning shape; the phase state is
  richer than the mode string.
- **Emit `plan/enter` only once per process, at agent construction.**
  Rejected: the `Agent` is per-session; reusing an Agent instance
  across plan and non-plan runs needs per-run transitions.
- **Track plan state inside the LLM context window.** Rejected:
  same reason as the meta-ADR — model-visible ≠ logged. Plan state
  belongs on the bus, not the prompt.