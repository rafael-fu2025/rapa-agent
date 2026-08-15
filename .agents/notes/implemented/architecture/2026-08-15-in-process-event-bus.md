# In-process event bus for the agent loop

Status: implemented
Date: 2026-08-15
Scope: architecture

## Context

Phase 1.4 added three new lifecycle events to the agent's wire format —
`turn/start`, `turn/end`, `step/start` — but nothing inside the
process observes them yet. The only consumer is the *external* SSE
stream consumed by the frontend. Internal subsystems (tracing, the
upcoming capability seams in Phase 2.1, the upcoming event-sourced
plan mode in Phase 2.3) need a way to react to these events *inside
the same process* without:

- Polling the SSE stream (race-prone, awkward ownership)
- Re-parsing the `AgentExecutionEvent` shape (couples observers to
  the wire format)
- Calling private methods on `Agent` (breaks encapsulation)

Today the only in-process observation is `tracing.ts` (OpenTelemetry-
style spans), which is a *trace exporter*, not a *domain event
listener*. They serve different concerns.

## Decision

Add a typed in-process event bus under
`server/src/lib/agent/event-bus.ts` with three domains and two
listener kinds.

### Three domains

| Domain | Events | Producer | Consumers |
|---|---|---|---|
| `agent/*` | `turn/start`, `turn/end`, `step/start`, `step/end` | `Agent.stream()` | tracing, telemetry, mode-switch prompts |
| `tools/*` | `tool/call`, `tool/result`, `tool/approve`, `tool/reject` | `ToolOrchestrator` | audit, rate-limit, shadow-runner |
| `session/*` | `session/start`, `session/end`, `session/error` | `Agent.run()` (wrapping `stream()`) | session-run persistence |

`session/*` is distinct from `agent/*` because one session can spawn
multiple agent runs (resume, follow-up); the session layer is the
unit of persistence.

### Two listener kinds

**Serial** (`on`):
- Each listener runs in registration order.
- Listener receives the event; return value is ignored.
- Used for observation: tracing, telemetry, audit logging.
- Listener errors are caught and logged; one bad listener does not
  stop others.

**Waterfall** (`intercept`):
- Each listener may call `next()` to delegate, or return early.
- Returning without `next()` short-circuits the chain.
- Used for modification: pre-tool argument rewriting, message
  rewriting, force-answer injection.
- Listener errors propagate to the caller (interceptors must be
  trustworthy).

### One bus per Agent

`Agent` constructs one bus during `stream()` and exposes it via a
`readonly events` field. External code attaches listeners before
calling `stream()` (or after — both are safe; listeners added mid-
stream receive subsequent events only).

The bus is **additive** — the existing `for await (const event of
agent.stream())` API continues to work unchanged. The bus is a
parallel channel, not a replacement.

### Sync-only for now

Listeners run synchronously in registration order. Async listeners
are deferred to a later phase (after we've seen a real use case that
needs them; the existing tracing.ts is sync).

### Typed events

```typescript
type AgentEvents = {
  "agent/turn/start": { conversationId: string; mode: string; iterationBudget: number };
  "agent/turn/end": { status: DoneStatus; iterations: number; elapsedMs?: number };
  "agent/step/start": { iteration: number };
  "agent/step/end": { iteration: number };
  "tools/tool/call": { call: ToolCall };
  "tools/tool/result": { call: ToolCall; result: ToolResult };
  "session/session/start": { conversationId: string };
  "session/session/end": { status: DoneStatus };
  "session/session/error": { message: string };
};
```

The bus is parameterized over an event map; consumers narrow with a
typed `on<K extends keyof Events>(kind: K, listener: ...)` signature.

## Consequences

**Easier:**

- Capability seams (Phase 2.1) can attach via `intercept()` to
  modify tool calls before execution — no `Agent` private method
  access.
- Plan mode (Phase 2.3) can listen to `agent/turn/end` to commit
  plan state.
- Future self-modification (Phase 3.3) can react to plugin mounts
  via `agent/plugin/mount` (added in a follow-up).
- Tracing becomes one observer among many, not a privileged path.

**Harder:**

- Two channels (`for await` + bus) for the same event means listeners
  must not assume "every event will reach me" if they only watch the
  bus — the SSE stream is still authoritative.
- Waterfall listeners need careful sequencing; an interceptor that
  forgets `next()` will silently drop the event.
- Bus state lives on the `Agent`; cleanup requires holding the
  agent reference (we already do).

**Follow-ups:**

- Add `agent/plugin/mount` and `agent/plugin/unmount` events when
  Phase 3.1 (DI layer) lands.
- Add `tools/pre-execute` as the canonical waterfall point for tool
  argument rewriting (replaces the inline rewriting in
  `ToolOrchestrator`).
- A `bus.observe("agent/*")` wildcard listener for telemetry, once
  we know the cardinality.

## Alternatives considered

- **Use Node's built-in `EventEmitter`.** Rejected: no waterfall
  semantics, no type safety, error semantics are footgun-prone
  (a throw in a listener crashes the emitter).
- **Use `tracing.ts` as the bus.** Rejected: tracing is an
  *exporter*, not a *listener*. Different concerns, different
  lifecycles (trace spans are scoped, bus listeners are registered
  by class).
- **Use Cordis events directly.** Rejected: Phase 3.1 evaluates a
  lightweight DI layer *instead* of Cordis. Coupling the bus to
  Cordis would re-litigate Phase 1.3.1 (vendor-or-DI).
- **Make the bus global.** Rejected: global state breaks
  per-conversation isolation, which the per-conversation workspace
  binding (AGENTS.md §5.4) relies on.