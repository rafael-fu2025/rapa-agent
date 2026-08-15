# Workflow engine + worker thread provider

Status: proposed
Date: 2026-08-15
Scope: architecture

## Context

Some agent tasks span many steps and minutes — multi-file refactors,
test-suite + fix loops, data migrations with verification. Today
each of these is one `Agent.stream()` call with `maxIterations` up to
50. Long streams have three problems:

1. **No mid-run checkpoint.** A crash mid-refactor loses all
   progress; the next run starts over.
2. **No worker isolation.** A long-running tool (e.g., a test
   suite) holds the event loop, blocking UI updates.
3. **No DAG control.** The agent's iteration is a linear loop. A
   "run tests → fix failures → re-run tests" loop needs explicit
   state machines, not free-form LLM decisions.

dsh's answer is a workflow engine (`packages/workflow/`) with a
worker-thread provider. The engine accepts a DAG of tasks; the
worker thread executes one task at a time and reports back via the
bus.

## Proposed shape

- `Workflow` — a typed DAG of `Task` nodes with edges.
- `WorkflowRunner` — topological execution, with state persistence
  on every node completion.
- `WorkerThreadProvider` — runs a node's `execute()` on a Node
  `worker_thread` so the main loop stays responsive.
- Bus events: `workflow/start`, `workflow/task/start`,
  `workflow/task/end`, `workflow/end`.

This ADR is **proposed** because Phase 3.2 is multi-day work and
falls outside this session's scope. The skeleton below seeds the
shape for the next contributor.

## Consequences (when implemented)

**Easier:**

- Long-running workflows survive crashes via checkpoint files.
- Tool-heavy workflows offload CPU to a worker.
- DAG control makes "test then fix" loops deterministic.

**Harder:**

- Worker-thread sandboxing for Node 22+ is still evolving; we may
  need to fall back to `child_process` for some tool types.
- DAG construction from natural language ("refactor agent.ts into
  turn/step") needs careful prompt work — out of scope here.

## Alternatives considered

- **Use Node's built-in `worker_threads` directly.** This is the
  recommended path; dsh wraps it in a provider for ergonomic
  reasons (cancellation, lifecycle hooks).
- **Use Temporal / Inngest for orchestration.** Rejected: external
  dependency for an in-process concern; cost-of-vendoring too high
  for one use case.
- **State-machine DSL.** Considered, deferred. The DAG model is
  simpler and covers the immediate need.