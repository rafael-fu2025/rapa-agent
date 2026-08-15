# Snapshot testing harness for the agent loop

Status: implemented
Date: 2026-08-15
Scope: testing

## Context

The existing tests under `server/src/lib/agent/_test/` mock the LLM
and assert on internal data structures (envelopes, parsed responses,
budget state). This catches *unit* regressions but not *behavior*
regressions — the failure modes that matter most:

- Prompt assembly silently drops a tool description.
- `response-parser` accepts a malformed JSON shape a real provider
  emits under load.
- `reasoning-translator` mistranslates a `reasoning_effort: "max"`
  for Gemini into an unsupported parameter and the call fails.
- `tool-orchestrator` reorders read-only tools and breaks the
  per-step determinism assumption that powers the UI.

These regress only against a real provider. Mock tests cannot reach
them. dsh's pattern is **snapshot replay**: record a real transcript
once, then run the agent against a fixture in CI.

## Decision

Build a snapshot harness under `server/src/lib/agent/snapshot/` with
two side-by-side modes:

### Mode A — `replay` (default, keyless)

- Load a JSON fixture from `server/src/lib/agent/_snapshots/`.
- Replace `LLMClient.streamChat` with a `ReplayLLMClient` that emits
  the fixture's recorded model responses in order, never touching
  the network.
- Run the agent loop end-to-end against this mocked LLM, capturing
  the full `AgentExecutionEvent` stream.
- Diff the captured events against the fixture's expected events.
  Failure ⇒ test fails with a normalized diff.

Replay runs on every CI build, every PR, every local `npm test`.
Network-free. Deterministic. Fast (sub-second per fixture).

### Mode B — `verify` (real-provider smoke)

- Run the agent loop against a real LLM (current provider from env).
- Compare the captured events against the fixture.
- **Self-skip when no API key is configured** — same pattern as
  dsh's `test:e2e`.

`verify` is opt-in: `SNAPSHOT_MODE=verify npm test` (or a dedicated
`npm run test:smoke`). It exists to catch fixture rot — when the
real provider's behavior drifts but no one has re-recorded.

### Recording (`record` mode)

A third mode, `SNAPSHOT_MODE=record`, runs the agent against the
real LLM and **overwrites** the fixture file. Used by humans (or an
agent) to refresh a stale fixture. Never run in CI.

### Fixture format

```jsonc
{
  "name": "plan-mode-basic",
  "version": 1,
  "recorded_at": "2026-08-15T13:00:00Z",
  "recorded_with": {
    "provider": "gemini",
    "model": "gemini-2.5-pro"
  },
  "input": {
    "mode": "plan",
    "userPrompt": "Plan a refactor of agent.ts into turn/step",
    "seedHistory": [],
    "workspaceRoot": "<tmp>"
  },
  "events": [
    // First event is always "start"; each LLM request is followed by
    // a single "assistant" or tool-call sequence.
    { "type": "start", "conversationId": "...", "model": "..." },
    { "type": "step/start", "iteration": 1 },
    { "type": "thinking", "iteration": 1, "reasoning": "..." },
    { "type": "assistant", "iteration": 1, "final": false, "content": "..." },
    { "type": "tool_call", "iteration": 1, "status": "running", "call": {...} },
    { "type": "tool_call", "iteration": 1, "status": "completed", "call": {...}, "result": {...} },
    { "type": "step", "step": { ... } },
    // ... etc
    { "type": "done", "status": "completed", "response": "...", "steps": [...] }
  ],
  "assertions": [
    // Optional structured assertions evaluated after event-sequence diff.
    { "kind": "tool_called", "name": "plan_tasks", "min": 1 },
    { "kind": "no_tool_called", "name": "execute_command" },
    { "kind": "iteration_count", "max": 5 }
  ]
}
```

### Comparison rules

- Timestamps are stripped (`recorded_at` is informational only).
- Reasoning strings are compared **as substrings** — the recorder
  keeps the first 200 chars; replay asserts a `startsWith` match.
  Full reasoning comparison would over-couple to model temperature.
- `tokenUsage` is **not** compared (provider-dependent, brittle).
- `conversationId` is replaced with a constant in replay.
- Everything else is a deep equal.

### First fixture

`plan-mode-basic.json` — a plan-mode run that:
1. Reads the existing `agent.ts`.
2. Calls `plan_tasks` to draft a 3-step refactor plan.
3. Returns the plan as a final assistant message.
4. Performs **zero** write operations.

This fixture exercises:
- Prompt assembly with `mode: "plan"`.
- A `plan_tasks` tool invocation end-to-end.
- Plan mode's no-write constraint.
- The single-iteration termination path.

## Consequences

**Easier:**

- Regressions in prompt assembly, response parsing, and tool
  orchestration are caught against recorded real-provider behavior.
- CI runs without an API key by default; smoke runs are opt-in.
- Future contributors (human or agent) see what the loop *actually
  does* by reading fixtures, not by reading code.

**Harder:**

- Fixtures drift. Re-recording is manual and requires judgment.
  Mitigation: the `verify` smoke surfaces drift; humans review diffs.
- Reasoning comparison is lossy by design (substring). May miss a
  real regression in reasoning wording. Acceptable trade-off.
- Disk footprint: each fixture is a few KB. Trivial.

**Follow-ups:**

- A `npm run test:smoke` script that runs `verify` mode across all
  fixtures when `DEEPSEEK_API_KEY` (or equivalent) is set.
- A `npm run test:record` script for fixture refresh.
- Per-fixture `@mode` declaration so `verify` only runs fixtures
  whose recorded provider matches the configured one.

## Alternatives considered

- **msw / nock for HTTP replay.** Rejected: the LLM client wraps
  streaming, retries, and API-key failover; mocking at the HTTP
  layer leaks those concerns into every test. Replay at the
  `LLMClient` boundary is sharper.
- **Golden-file LLM call recorder in a separate process.** Rejected:
  the harness needs to run inside the existing test runner to share
  fixtures, helpers, and report formats.
- **Record against *every* provider.** Rejected: too expensive. One
  fixture per scenario, recorded against the cheapest viable
  provider, with `verify` smoke as the provider-drift detector.