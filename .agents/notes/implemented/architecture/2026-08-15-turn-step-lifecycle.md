# Turn / step lifecycle formalization

Status: implemented
Date: 2026-08-15
Scope: architecture

## Context

The current `Agent.stream()` method emits a flat sequence of
`AgentExecutionEvent`s — `start`, `thinking`, `tool_call`,
`assistant`, `step`, `done`, `error` — with two implicit concepts
buried inside:

- A **turn** is one call to `stream()`. It opens when `stream()` is
  invoked and closes when the agent decides the work is done.
- A **step** is one iteration of the `for` loop on line 349 of
  `agent.ts`. Each step is one model request plus any tool calls it
  emits.

Today neither boundary is a first-class event. The `start` event
is the closest thing to a turn marker but it carries `model` /
`conversationId` data, not turn metadata. The `step` event is the
closest thing to a step marker but it carries the full step payload
(successively appended reasoning, tool calls, results) rather than
a lightweight boundary marker.

This makes three things hard:

1. **Observability.** Telemetry cannot distinguish "turn opened"
   from "first step started"; UIs cannot render a turn container
   without scanning event types for the implicit boundary.
2. **Reconstruction from the log.** A consumer rebuilding turn /
   step structure from the event stream has to reverse-engineer
   boundaries from `start` + first-`step` and `done` + last-`step`.
3. **Future event bus.** Phase 2.2 introduces an in-process event
   bus with waterfall listeners (e.g. `agent/pre-step`). Listeners
   need named boundaries to attach to.

## Decision

Add two new event types to `AgentExecutionEvent`:

- `turn/start` — emitted exactly once at the top of `stream()`,
  before the existing `start` event. Carries `conversationId`,
  `model`, `mode`, `userPrompt`, `iterationBudget`. Identical data
  to today's `start` event plus the mode-specific budget, kept for
  forward compatibility.
- `turn/end` — emitted exactly once at the bottom of `stream()`,
  *before* the existing `done` event. Carries `status`, `response`,
  `steps`, `iterations`, plus the new fields already on `done`.
- `step/start` — emitted at the top of each iteration in the `for`
  loop, *before* compaction logic, after the per-iteration stall
  threshold check. Carries `iteration` and `seedMessageCount`.

The existing `start`, `step`, `done` events are **unchanged** and
remain on the wire. `turn/start` and `step/start` are *additive
leading edges*; `turn/end` is an additive *pre-decessor* to `done`.
No event is renamed or removed.

Snapshot fixtures gain one `step/start` event per iteration (placed
before the first `thinking` event of that iteration) and one
`turn/start` event at the top (immediately before the existing
`start`). Existing fixtures are refreshed in `record` mode.

### Wire contract

The event order within a single turn becomes:

```
turn/start
start
step/start (iteration=1)
thinking (iteration=1)
tool_call (iteration=1) ...
assistant (iteration=1, final=false)
step (iteration=1)
step/start (iteration=2)
...
done
turn/end
```

### Surgical edits only

- One type-union extension (`AgentExecutionEvent`).
- Three `yield` insertions in `agent.ts`.
- Zero changes to the existing iteration body, exit conditions,
  tool orchestration, or LLM client wiring.

## Consequences

**Easier:**

- Turn and step boundaries become observable; UI rendering, trace
  tooling, and the future event bus all gain a stable seam.
- Snapshot fixtures gain a deterministic "anchor" — replay
  comparison no longer depends on inferring boundaries from event
  types.

**Harder:**

- Every existing fixture must be re-recorded or hand-patched to
  include `step/start` events. Three committed fixtures as of
  this note; re-record once via `SNAPSHOT_MODE=record`.
- The `AgentExecutionEvent` union grows by 2 variants. Type
  narrowing in consumers (frontend, telemetry) requires `case`
  additions. Audit checklist: every consumer with `switch (event.type)`
  needs two more `case` arms.

**Follow-ups:**

- Phase 2.2 (event bus) attaches waterfall listeners to
  `step/start` and `turn/end`.
- Phase 2.3 (plan mode as logged state) attaches `plan/enter` and
  `plan/exit` to the `turn/end` listener.

## Alternatives considered

- **Rename `start` → `turn/start`.** Rejected: breaks wire
  compatibility with the frontend and any saved transcripts.
  Additive is safer for a personal-machine app with no versioned
  protocol.
- **Emit `step/end` and rename `step` → `step/start`.** Rejected:
  the existing `step` event carries the full step payload
  (reasoning, tool calls, results) — semantics mismatch. `step` is
  the *commit*, not the *boundary*.
- **Make turn/step explicit React-style context objects.** Rejected
  for now: the wire format is event-sourced and async-generator
  driven. Wrapping the loop in a context object adds complexity
  without immediate payoff. Revisit when Phase 2.2 (event bus)
  lands.