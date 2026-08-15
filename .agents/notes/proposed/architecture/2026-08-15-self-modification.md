# Self-modification package

Status: proposed
Date: 2026-08-15
Scope: architecture

## Context

Phase 3.1 introduces a lightweight plugin/DI layer. A natural next
step is letting the agent *introspect* that layer and mount new
plugins at runtime. dsh's `packages/self-modification/` does this:

- The agent reads a plugin manifest.
- The agent calls `mount_plugin(name, options)` — a tool exposed
  to it.
- The bus emits `plugin/mount` and `plugin/unmount` events.
- Existing approval flow gates the call.

This makes the agent a true self-extending system: it can adapt its
own capability surface in response to a user's request.

## Proposed shape

- New tool: `mount_plugin` and `unmount_plugin`. Both require
  approval (the existing `requiresApproval` flag handles this).
- The tools look up the plugin by name in a registered registry.
- Bus events: `agent/plugin/mount`, `agent/plugin/unmount`.
- Approval gate: `resolveToolApproval` is reused; the user sees a
  diff of what the plugin does before approving.

This ADR is **proposed**. The actual implementation requires:

1. A plugin registry indexed by name (the existing `definePlugin`
   API exposes names, but not all plugins have a static name).
2. A `plugin-manifest` schema: `{ name, version, source, options }`.
3. A `loadPlugin(manifest)` function that resolves to a `Plugin`.
4. The tool wrappers.

## Consequences (when implemented)

**Easier:**

- New capabilities arrive via conversation, not via deploys.
- The agent can adapt to user-specific workflow needs.

**Harder:**

- Self-modification is a powerful surface for prompt injection.
  Approval gating is mandatory, not optional.
- Plugin name resolution must be sandboxed — the agent cannot load
  arbitrary JS from disk.

## Alternatives considered

- **Always-auto-approve plugin mounts.** Rejected: prompt-injection
  risk. The approval gate is non-negotiable.
- **WebAssembly plugin sandbox.** Considered for Phase 3.5; deferred
  because the implementation cost is high and a JS plugin sandbox
  with approval gating is sufficient for the threat model today.
- **Plugin marketplace with code signing.** Out of scope; deferred
  to multi-user hosted deployment work.