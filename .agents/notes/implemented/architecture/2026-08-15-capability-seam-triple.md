# Capability seam triple (Service Definition / Provider / Consumer)

Status: implemented
Date: 2026-08-15
Scope: architecture

## Context

The current `Tool` class conflates three concerns into one class:

1. **Service Definition** — metadata (name, description, parameters,
   category) that the LLM and UI consume.
2. **Service Provider** — execution logic (the `execute` method,
   filesystem / network / subprocess access).
3. **Policy** — `riskLevel` and `requiresApproval` are hardcoded on
   the same `ToolDefinition` object.

This creates three concrete problems:

- **Policy cannot be set per-registration.** Today, `riskLevel:
  "write"` is part of the tool class definition. A user wanting to
  run `execute_command` with a stricter policy in plan mode has no
  way to do so without subclassing and replacing the tool.
- **Definition cannot be reused across providers.** The `read_file`
  tool's parameter schema is identical whether reading from local
  filesystem or a remote sandbox. Today the entire class is
  duplicated.
- **Consumers cannot react to policy events.** When `requiresApproval:
  true` triggers, the existing `ToolOrchestrator` blocks on a Promise;
  there's no bus event, no observability hook, no audit trail.

## Decision

Introduce a three-role capability seam. The existing `Tool` class
continues to work — it is *automatically wrapped* as a Provider — so
no tool subclass needs to change. New registrations can use the
explicit triple form.

### Types

```typescript
// Service Definition: pure metadata. No execution, no policy.
type CapabilityDefinition<TParams = unknown, TResult = unknown> = {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  category: ToolCategory;
  resultShape?: (result: TResult) => "generic" | "terminal" | "diff";
};

// Service Provider: implements execution.
interface CapabilityProvider<TParams = unknown, TResult = unknown> {
  readonly definition: CapabilityDefinition<TParams, TResult>;
  execute(params: TParams, context: ToolExecutionContext): Promise<TResult>;
}

// Policy: a separate object, registered alongside the provider.
type CapabilityPolicy = {
  riskLevel: "none" | "read" | "write" | "destructive" | "network";
  requiresApproval: boolean;
  /** Optional: tools/pre-execute interceptors can mutate params. */
  preExecuteHook?: (params: unknown) => Promise<unknown> | unknown;
};

// Registration entry: combines all three.
type CapabilityEntry = {
  provider: CapabilityProvider;
  policy: CapabilityPolicy;
};
```

### Registry

`CapabilityRegistry` is the new home for tools. It exposes:

- `register(provider, policy?)` — explicit form.
- `registerTool(tool)` — backward-compat shim that wraps a `Tool`
  instance as a Provider, defaulting its policy to `{ riskLevel:
  tool.definition.riskLevel, requiresApproval: tool.definition.requiresApproval }`.
- `get(name)` — returns `{ provider, policy }` or `undefined`.
- `list()` — returns all entries (used by the prompt builder and UI).
- `listByRisk(min)` — convenience filter.

`ToolRegistry` (the existing class) becomes a thin wrapper that
delegates to `CapabilityRegistry`. The `toolRegistry` global export
keeps working; new code uses `capabilityRegistry`.

### Bus integration

When the orchestrator runs a tool, the bus emits:

- `tools/tool/call` — before execution, with the call + resolved
  policy. Waterfall listeners can rewrite params or veto.
- `tools/tool/result` — after execution, with the call + result.
- `tools/policy/decision` — when `requiresApproval` triggers,
  emitted with the approval request. Listeners can auto-approve
  (e.g., based on patterns).

These events ride the Phase 2.2 `AgentEventBus`.

### Backward compatibility

The 22 existing tool classes (`ReadFileTool`, `ShellTool`, etc.) are
unchanged. The `registerAllTools()` function in
`server/src/tools/index.ts` is updated to call
`capabilityRegistry.registerTool(tool)` instead of
`toolRegistry.register(tool)`. No tool subclass needs editing.

The orchestrator reads from the new registry but exposes the same
`executeTool` / `approveTool` API.

## Consequences

**Easier:**

- A new mode (e.g., "strict plan") can register a stricter policy
  layer that overrides per-tool policies without touching tool code.
- The bus has a canonical place for tool observability — audit,
  rate-limit, and shadow-runner observers attach once.
- A future sandbox provider can replace a single provider entry
  without touching consumers.

**Harder:**

- Two registries (the new `CapabilityRegistry` and the existing
  `ToolRegistry` shim) live side-by-side. Maintenance hazard until
  the shim is removed (deferred to Phase 3.1 when the DI layer
  replaces both).
- The wrapping of `Tool` → `CapabilityProvider` is a lossy adapter
  (it captures `riskLevel` and `requiresApproval` from the
  definition). New providers should use the explicit form.

**Follow-ups:**

- Phase 3.1 (DI layer) collapses `CapabilityRegistry` and
  `ToolRegistry` into one.
- Audit log: a serial listener on `tools/tool/call` +
  `tools/tool/result` writes to a durable log.
- A `dry-run` provider for `execute_command` (plan mode):
  registers alongside the real provider under a separate name.

## Alternatives considered

- **Edit every tool class.** Rejected: violates the user's
  "surgical edits only" directive and adds churn for no immediate
  benefit. The wrap-as-provider pattern captures 90% of the value.
- **Drop the existing `Tool` class entirely.** Rejected: same
  reason; the existing class is fine, the issue is the missing
  seam.
- **Use Cordis providers.** Rejected: see the meta-ADR for Phase 1
  — we evaluate a lightweight DI layer (Phase 3.1) instead.
- **Make policy a bus-emitted event the orchestrator must consume.**
  Rejected: keeps policy visible at registration time, which the
  prompt builder needs (e.g., to label tools as "approval
  required" in the UI).