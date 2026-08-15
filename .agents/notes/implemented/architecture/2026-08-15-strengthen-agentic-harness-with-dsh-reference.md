# Strengthen the agentic harness using dsh as reference

Status: implemented (in progress — multi-phase)
Date: 2026-08-15
Scope: architecture

## Context

Recreate UI's backend agent loop (`server/src/lib/agent.ts` plus 25
focused modules under `server/src/lib/agent/`) is structurally clean
but operationally weak. It works for the demo path and ships, but a
recent self-audit surfaced three concrete failure modes:

1. **No real coverage of agent behavior.** Existing tests mock the
   LLM and assert on internal data structures. They cannot detect
   regressions in prompt assembly, tool ordering, or recovery flows
   against a real provider. A model regression or schema drift in
   `reasoning-translator.ts` ships undetected.
2. **No extension seams for behavior change.** Tools, prompts, and
   the loop itself are hardcoded modules. Adding a new capability
   (e.g. "pause for human approval before destructive shell") requires
   editing `agent.ts` rather than mounting a plugin.
3. **No architectural history.** Six months from now the rationale
   for any one of the 25 modules is reconstructable only from git
   blame and tribal memory.

DeepSeek's `dsh` (at `C:\Users\Rafael\deepseek-harness\`) is the
canonical reference. It addresses each failure with:

- **Snapshot tests** of real agent transcripts — replayable, keyless.
- **Capability seams** (Service Definition / Provider / Consumer) and
  a Cordis-based plugin tree.
- **An ADR directory** (`.agents/notes/`) with
  `implemented/proposed/rejected` partitions.

We adopt the pattern in three phases. This note records the
decision; subsequent notes will record each phase as it lands.

## Decision

Execute a three-phase upgrade of the agentic harness, **in place
inside Recreate UI** (no sibling package), with **surgical edits
only** (no rewrite of existing modules), under the **full dsh-style
notes discipline** adopted in the companion note
[`2026-08-15-adopt-dsh-style-notes-discipline`](./2026-08-15-adopt-dsh-style-notes-discipline.md).

### Phase 1 — foundations (low cost, high leverage)

1. `.agents/notes/` scaffolded and meta-ADR written *(this note and
   its companion)*.
2. **Snapshot testing harness** for the agent loop: record real
   transcripts as fixtures, replay against them. Keyless by default;
   provider tests self-skip when no API key is configured.
3. **`turn` / `step` formalization** in `agent.ts`: wrap the existing
   iteration loop in named turn-open / step-open / step-close /
   turn-close boundaries. Surgical — no behavior change, only
   observability.

### Phase 2 — structural seams (medium effort)

4. **Capability seam pattern** for tools: convert `Tool` from a flat
   class into `Service Definition / Provider / Consumer` triples.
   Risk and approval become policy events, not hard properties.
5. **In-process event bus** for `agent/*`, `tools/*`, `session/*`
   domains. ~300 LOC, no Cordis vendoring. Waterfall listeners for
   interception; serial listeners for observation.
6. **Plan mode as logged state.** Promote the existing
   `plan-tasks.ts` tool into a first-class mode with
   `plan/enter`, `plan/step`, `plan/exit` events that persist to
   `SessionEvent`.
7. **Coverage gate** in CI: v8 coverage already enabled in
   `server/vitest.config.ts`; add a per-package threshold (start at
   70%, ratchet to 85% after Phase 2).

### Phase 3 — pluginization (high commitment)

8. **Lightweight DI/plugin layer** in place of Cordis vendoring. A
   `PluginContext` class with typed services, scoped registration,
   and effect cleanup. ~500 LOC. Captures 90% of Cordis's value at
   ~10% of the dependency weight.
9. **Workflow engine** + worker thread provider. Long-running tool
   chains (e.g. multi-step codegen, migration verification) get a
   durable, recoverable execution surface.
10. **Self-modification package.** The agent can inspect and mount
    its own plugins at runtime, with the existing approval flow
    gating each mount/unmount.
11. **JSON-RPC SDK** for external clients. The existing SSE/REST
    surface becomes a secondary transport; JSON-RPC over WebSocket
    becomes the canonical automation channel.

### Constraints carried forward from the user

- **In-place.** All changes under `server/src/`. No new sibling
  package, no monorepo migration.
- **Surgical edits only.** Existing modules are not rewritten. New
  seams, events, and the DI layer are *added around* them.
- **Full notes discipline.** Every Phase 2 and Phase 3 change ships
  with an ADR. Phase 1 changes ship with an ADR when they touch
  public surface or invariants.

## Consequences

**Easier:**

- Future agent regressions are caught by snapshot replay before merge.
- New capabilities arrive as plugins, not as edits to `agent.ts`.
- Architectural intent survives across sessions and contributors.

**Harder:**

- Phase 3 (workflow engine, self-modification, JSON-RPC SDK) is
  multi-week work. We gate it on Phase 1 + 2 landing cleanly.
- The full notes discipline adds a real per-PR time tax (15–30
  minutes per ADR). Absorbed as the cost of the discipline.

**Follow-ups:**

- Phase 1.3 (snapshot harness) requires a small fixture recorder
  and a replay harness. See the dedicated ADR to be drafted before
  implementation.
- Phase 2.5 (event bus) requires a decision on sync vs. async
  dispatch semantics. See the ADR to be drafted before implementation.
- A `.agents/notes/rejected/` seed note explaining why we *didn't*
  vendor Cordis wholesale (we kept the pattern, replaced the
  dependency).

## Alternatives considered

- **Vendor Cordis wholesale.** Rejected for now. Cordis is a large
  framework; vendoring is the only realistic adoption path and the
  package surface is overkill for a personal-machine single-user
  deployment. The lightweight DI layer in Phase 3.1 captures the
  value at a fraction of the dependency weight. (May revisit if
  the DI layer proves insufficient.)
- **Bilingual docs everywhere.** Rejected as overkill. We mirror
  only `Scope: architecture` and `Scope: process` notes that affect
  a public surface; internal `simplification/` and `testing/` notes
  stay English-only.
- **100% per-file coverage gate.** Rejected. dsh's gate is
  appropriate for their surface; for a 25-module agent loop with
  frequent LLM-coupled changes, brittle. Start at 70%, ratchet.
- **Rewrite `agent.ts` from scratch.** Rejected by user direction
  ("surgical edits only"). Phase 1.3 introduces turn/step as an
  *additive* boundary; the existing iteration loop is wrapped, not
  replaced.
- **Stay with mock-only unit tests.** Rejected. Mock tests cannot
  catch prompt-assembly or tool-order regressions against a real
  provider, which is the most common failure mode we have observed.