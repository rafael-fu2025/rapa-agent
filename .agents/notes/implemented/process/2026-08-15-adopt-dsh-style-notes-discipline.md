# Adopt dsh-style architectural notes discipline

Status: implemented
Date: 2026-08-15
Scope: process

## Context

Recreate UI's `agentic harness` (the Fastify backend under
`server/src/lib/agent/`) has grown to 25 focused modules with no
formal way to record architectural decisions. The current
`AGENTS.md` documents *what the code is*, but not *why it is the way
it is* or *what alternatives were considered*.

Without an ADR record, every contributor (human or agent) faces three
recurring failures:

1. **Context loss on return.** Six months from now, the reason
   `agent-loop.ts` chose `turn/step` over `iteration` will be lost.
2. **Re-litigation.** Decisions like "no Cordis vendoring" or "no
   100% coverage gate" get re-debated from scratch each time.
3. **No ground truth for rejection.** Saying "we considered X" without
   a written record means the same proposal re-surfaces in every
   review.

DeepSeek's `dsh` project solves this with `.agents/notes/` — a
partitioned ADR directory with `implemented/`, `proposed/`,
`rejected/` states and a bilingual discipline. We adopt the pattern.

## Decision

Create `.agents/notes/` at the repo root with three partitions
(`implemented/`, `proposed/`, `rejected/`), each subdivided into
`architecture/`, `feature/`, `process/`, `simplification/`, `testing/`.

Every **non-trivial** change ships with an ADR in the same PR. A
companion `.zh.md` is required when the note is `Scope: architecture`
or `Scope: process` and affects a public surface. The
`.agents/notes/README.md` defines the trigger, the format, and the
lifecycle.

The canonical reference is
`C:\Users\Rafael\deepseek-harness\.agents\notes\`; we follow the same
shape but with a lighter bilingual rule (see "Bilingual discipline"
in the README) appropriate for a personal-machine, single-user
deployment.

## Consequences

**Easier:**

- Architectural intent survives across sessions and contributors.
- Rejected options have a tombstone — "we already considered X" is
  a 1-line lookup, not a fresh debate.
- Future agents (including this one) can onboard to the architecture
  by reading notes in reverse chronological order.

**Harder:**

- Every non-trivial change requires an extra file. Time tax: 15–30
  minutes per note. We absorb this as the cost of the discipline.
- Reviewers must check the note exists, is in the right partition,
  and follows the template.

**Follow-ups:**

- Add a CI check (`scripts/check-adr.sh`) that fails the build when
  `server/src/lib/agent/**` or `server/prisma/schema.prisma` changes
  without a corresponding note.
- Seed the `rejected/` partition with the handful of decisions we
  *did* debate informally (e.g. "don't vendor Cordis wholesale",
  "no 100% coverage gate"). Future phases will add their own.

## Alternatives considered

- **In-repo wiki (e.g. `docs/adr/`).** Rejected: wikis rot; git-tracked
  ADRs survive code changes and are greppable.
- **Issue-tracker-only ADRs.** Rejected: not greppable from the
  affected code; reviewers can't enforce co-location.
- **No notes, just better `AGENTS.md`.** Rejected: AGENTS.md is the
  *current state*; ADRs are the *decision history*. They serve
  different roles.