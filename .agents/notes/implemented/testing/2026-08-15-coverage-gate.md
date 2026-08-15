# Coverage gate (v8, per-package thresholds)

Status: implemented
Date: 2026-08-15
Scope: testing

## Context

`server/vitest.config.ts` already runs v8 coverage on every
`npm test` invocation (the `coverage` block under `test`). The
config reports a coverage table but does **not fail** when coverage
drops. Coverage today is informational only.

dsh's pattern (`.agents/notes/implemented/testing/2026-07-31-coverage-exempt-heavy-suites.md`)
is a per-package 100% gate that fails the build if any file drops
below threshold. We reject 100% as too brittle for an LLM-coupled
agent loop (see the meta-ADR for the upgrade plan), but accept the
*shape* of the gate.

## Decision

Add a per-area coverage gate to `vitest.config.ts`. Start at
**70%** across the four core areas and ratchet by 5% per quarter
until we hit **85%** as a steady-state target.

### Areas

| Area | Path | Initial threshold |
|---|---|---|
| Core agent loop | `src/lib/agent.ts` + `src/lib/agent/*.ts` | 70% |
| Tools | `src/tools/*.ts` | 65% |
| Routes | `src/routes/*.ts` | 60% |
| Lib helpers | `src/lib/*.ts` | 65% |
| Safety | `src/lib/safety/*.ts` | 80% (small surface, high-value) |

### Exemptions

The `src/lib/agent/_test/**` files are excluded from coverage
measurement (already true).

`src/index.ts` (the bootstrap) is excluded — wiring code, not
behavior.

### Ratchet policy

After this ADR lands, run `npm run test:coverage`. If the lowest
area is ≥85%, bump the threshold to 75%. If ≥75%, bump to 80%. The
`scripts/check-coverage.mjs` helper reports the current minimum
and suggests the next ratchet.

## Consequences

**Easier:**

- Coverage regressions surface in CI before merge, not months later.
- Per-area granularity catches "we forgot to test tools but agent
  loop is fine" — the wrong signal a flat threshold would give.

**Harder:**

- Adding a new file under `src/lib/agent/` inherits the 70%
  threshold; new contributors must write tests for ~70% of new
  code. We absorb this as the cost of "tests describe behavior".
- The ratchet policy is a manual step today. Phase 3.2 may
  automate it.

**Follow-ups:**

- A `npm run coverage:report` script that produces a markdown
  coverage summary for ADR attachments.
- A `coverage:diff` script that compares current coverage against
  the last green build's coverage and fails if any line went from
  covered → uncovered.

## Alternatives considered

- **Per-file 100% gate.** Rejected: brittle; mock-heavy tests
  inflate line coverage without proving correctness.
- **No gate, just report.** Rejected: the only signal that exists
  is human review, which doesn't scale.
- **Block on coverage decrease only.** Considered for Phase 3.2:
  fail if any file's coverage dropped vs the last green run.
  Deferred — the threshold gate is simpler and catches the same
  regressions on net-new code.