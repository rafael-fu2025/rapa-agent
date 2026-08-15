# Lightweight plugin / DI layer

Status: implemented
Date: 2026-08-15
Scope: architecture

## Context

The agent loop now has first-class extension points:

- **Bus events** (Phase 2.2) — listeners can observe or intercept.
- **Capability seams** (Phase 2.1) — new tools register without
  editing `agent.ts`.
- **Plan mode state** (Phase 2.3) — first-class state machine.

But none of these have a way to *bundle* related extensions into a
reusable, mountable unit. A future contributor who wants to add
audit logging today has to:

1. Edit `server/src/index.ts` to construct the audit logger.
2. Edit `server/src/lib/agent.ts` (or wrap an existing method) to
   subscribe to bus events.
3. Wire the logger into the Fastify shutdown hook.
4. Repeat for every new feature.

After two or three such features, the bootstrap file becomes a
configuration zoo. The same observation drove dsh to vendor Cordis.

## Decision

Introduce a tiny DI / plugin layer at `server/src/lib/plugin.ts`.
Three primitives:

- **`PluginContext`** — a typed container with `provide`,
  `inject`, and `effect` methods. Disposers are returned from each
  registration.
- **`definePlugin`** — a typed factory that returns a `Plugin`
  function. The plugin's body calls `provide` / `effect` on the
  passed context.
- **`PluginLoader`** — loads a list of plugins in order, returns
  the assembled context. Disposes in reverse.

### API

```typescript
type ServiceKey<T> = { __brand: T };
function serviceKey<T>(name: string): ServiceKey<T> { return name as never; }

interface PluginContext {
  provide<T>(key: ServiceKey<T>, value: T): () => void;
  inject<T>(key: ServiceKey<T>): T;
  effect(setup: () => () => void): () => void;
  child(): PluginContext;
}

type Plugin<TOptions = void> = (ctx: PluginContext, options?: TOptions) => void;

function definePlugin<TOptions>(
  setup: (ctx: PluginContext, options: TOptions) => void
): (options?: TOptions) => Plugin<TOptions> { ... }

class PluginLoader {
  use<TOptions>(plugin: Plugin<TOptions>, options?: TOptions): this;
  mount(): PluginContext;
}
```

### Why not Cordis?

Cordis is a 5,000+ LOC framework with deep effects, forking
contexts, scope isolation, and a YAML-driven config layer. We need
~150 LOC of "register a service, register a cleanup, dispose" — 3%
of Cordis. The remaining 97% (e.g., scope realms, async fork,
config-as-code) does not earn its complexity for a personal-machine
single-user app.

This is a deliberate trade — the dsh meta-ADR
(`2026-07-26-dependencies-over-hand-rolling.md`) favours maintained
deps *when they delete owned code*. A 150-LOC primitive is below
the threshold of "should be a dep".

### What we lose

- Scope isolation per-conversation: a single global context
  per-process is fine for a single-user app. (Per-conversation
  isolation comes from the Agent's own context, which the plugin
  can read.)
- YAML-driven composition: deferred. Phase 3.2 may add it.
- Async effects: deferred; existing bus + plan-mode code is
  sync-friendly. Async setup can be added by changing `effect`'s
  return type to `Promise<() => void>` if a real need surfaces.

## Consequences

**Easier:**

- A new cross-cutting concern (audit log, telemetry, mode-switch
  prompt) ships as one plugin file: define + register.
- Plugins can be tested in isolation: construct a `PluginContext`,
  mount the plugin, assert on the services it provides and the
  effects it registers.
- Plugin un-mount reverses effects in LIFO order — observers
  attached during plugin mount are detached on unmount, no leaks.

**Harder:**

- Two abstractions (`PluginContext` and the existing `Agent` class)
  for "I have things I want to be replaceable". The mental model:
  the Agent *is* a service the plugin context provides.
- The plugin layer is process-global by default. Per-conversation
  scoping needs an explicit `child()` call.

**Follow-ups:**

- Phase 3.3 (self-modification) wires the agent loop to inspect
  and mount its own plugins via the loader.
- A future ADR may swap the impl for Cordis if scope isolation
  becomes a real need (multi-user hosted deployment).

## Alternatives considered

- **Vendor Cordis wholesale.** Rejected: see the meta-ADR.
- **Use TypeDI, InversifyJS, or tsyringe.** Rejected: each adds
  decorators or interfaces that don't match our plain-function
  style. ~150 LOC own-roll is shorter than the dep upgrade path.
- **Just use the existing `events` bus + global module state.**
  Rejected: no effect cleanup; plugins can't be tested in
  isolation; no way to scope per-conversation.