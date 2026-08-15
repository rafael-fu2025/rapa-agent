# Architectural Notes — Recreate UI

This directory holds **architectural decision records (ADRs)** for Recreate UI, modeled on [DeepSeek Harness's `.agents/notes/`](../deepseek-harness/.agents/notes/README.md) discipline.

## When to write a note

Per `AGENTS.md`, **non-trivial changes MUST include an Agent Note in the same change**. Routine/local edits are exempt.

A change is *non-trivial* if it:
- Adds, removes, or restructures a public module, route, or schema
- Changes an invariant, contract, or default behavior
- Introduces a new dependency (or replaces one with a hand-roll)
- Affects the agent loop, tool execution, persistence, or auth boundary
- Adds or removes a CLI flag, env var, or migration
- Touches anything in `server/src/lib/agent/`, `server/src/routes/`, or `server/prisma/schema.prisma`

When in doubt, write one. A 30-line note costs less than a confused reviewer.

## Directory layout

```
notes/
  README.md                       # this file
  implemented/                    # decisions in the codebase today
  proposed/                       # decisions under consideration, not yet merged
  rejected/                       # decisions explicitly considered and turned down
```

Each partition has the same shape:

```
<partition>/
  architecture/                   # structural changes (modules, layers, seams)
  feature/                        # user-visible capabilities
  process/                        # workflow / tooling / CI
  simplification/                 # removal or consolidation
  testing/                        # test strategy, fixtures, harnesses
```

## File naming

```
YYYY-MM-DD-<kebab-case-topic>.md
YYYY-MM-DD-<kebab-case-topic>.zh.md   # bilingual mirror (when scope="full")
YYYY-MM-DD-<kebab-case-topic>.i18n.yaml  # translation metadata (when scope="full")
```

The `YYYY-MM-DD` is the **decision date** (date the change merged), not the date drafted.

## Note template

```markdown
# <Title>

Status: implemented | proposed | rejected
Date: YYYY-MM-DD
Scope: process | architecture | feature | simplification | testing

## Context

What is the situation that motivates this change? Reference the
problem, prior state, and any relevant constraints (perf, cost,
backward-compat, security, user experience).

## Decision

What did we choose to do, and why? State the decision in one paragraph
before justifying it. Reference the code locations affected.

## Consequences

What becomes easier? What becomes harder? What follow-ups are required?
If the change is staged, list the phases explicitly.

## Alternatives considered

What other options were on the table? For each: one-line rationale for
rejection. Rejected alternatives may also get their own `rejected/` note
when the reasoning is non-trivial.
```

## Lifecycle

1. **Draft** in `proposed/<topic>/` while the change is being designed.
2. **Promote** to `implemented/<topic>/` once the change merges.
3. **Reject** by moving the proposal to `rejected/<topic>/` with a short
   paragraph explaining the rejection. Do not delete — the absence of a
   decision is information.
4. **Archive** when a note's content is no longer current. Renamed with
   `.archived-YYYY-MM-DD.md` suffix. Never edit an archived note; the
   historical record is the point.

## Bilingual discipline

For `Scope: process` notes that change team workflow, **and** for any
`Scope: architecture` note that affects a public surface, mirror the
note into Chinese at `.zh.md`. The `.i18n.yaml` file lists translation
provenance and review status.

For purely internal notes (`Scope: simplification`, `testing`), English
is sufficient.

## Cross-references

- Root [AGENTS.md](../../AGENTS.md) — the rule that drives this directory.
- Root [CODEBASE_ANALYSIS.md](../../CODEBASE_ANALYSIS.md) — codebase map.
- DeepSeek Harness notes — `C:\Users\Rafael\deepseek-harness\.agents\notes\`
  (canonical reference for the format and discipline).