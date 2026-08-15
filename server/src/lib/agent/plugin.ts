/**
 * Lightweight plugin / DI layer.
 *
 * See `.agents/notes/implemented/architecture/2026-08-15-lightweight-plugin-di-layer.md`.
 *
 * Three primitives:
 *   - `PluginContext`: typed service container with provide/inject/effect
 *   - `definePlugin`: typed factory that turns a setup fn into a Plugin
 *   - `PluginLoader`: ordered plugin mount + reverse-ordered dispose
 */

/**
 * Branded service key. Stores the value's type so `inject<T>(key)`
 * returns `T` without a runtime type assertion.
 */
export interface ServiceKey<T> {
  readonly __serviceName: string;
  readonly __phantom?: T;
}

export function serviceKey<T>(name: string): ServiceKey<T> {
  return { __serviceName: name };
}

/**
 * The context each plugin receives. Mutations to the context during
 * plugin setup are visible to plugins that mount later.
 */
export interface PluginContext {
  /** Register a service under a typed key. Returns a disposer. */
  provide<T>(key: ServiceKey<T>, value: T): () => void;

  /** Resolve a service by key. Throws if the key is missing. */
  inject<T>(key: ServiceKey<T>): T;

  /** Resolve a service by key, returning `undefined` if missing. */
  tryInject<T>(key: ServiceKey<T>): T | undefined;

  /**
   * Run a setup function that returns a disposer. The disposer is
   * called in LIFO order when the owning context (or its parent) is
   * unmounted.
   */
  effect(setup: () => () => void): () => void;

  /**
   * Create a child context. Disposers from the child are called
   * when the child is unmounted; the parent's disposers are
   * unaffected.
   */
  child(): PluginContext;

  /** Read-only snapshot of registered keys (for diagnostics). */
  keys(): string[];
}

/**
 * A plugin is a function `(ctx, options?) => void`. The body
 * typically calls `provide`, `effect`, or mounts other plugins
 * via `child`.
 */
export type Plugin<TOptions = void> = (ctx: PluginContext, options?: TOptions) => void;

class ContextImpl implements PluginContext {
  private services = new Map<string, unknown>();
  private disposers: Array<() => void> = [];
  private childDisposers: Array<() => void> = [];

  provide<T>(key: ServiceKey<T>, value: T): () => void {
    const name = key.__serviceName;
    if (this.services.has(name)) {
      throw new Error(`Service "${name}" already provided`);
    }
    this.services.set(name, value);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.services.delete(name);
    };
  }

  inject<T>(key: ServiceKey<T>): T {
    const value = this.services.get(key.__serviceName);
    if (value === undefined) {
      throw new Error(`Service "${key.__serviceName}" not provided`);
    }
    return value as T;
  }

  tryInject<T>(key: ServiceKey<T>): T | undefined {
    return this.services.get(key.__serviceName) as T | undefined;
  }

  effect(setup: () => () => void): () => void {
    const dispose = setup();
    this.disposers.push(dispose);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const idx = this.disposers.indexOf(dispose);
      if (idx >= 0) this.disposers.splice(idx, 1);
      dispose();
    };
  }

  child(): PluginContext {
    const child = new ContextImpl();
    // Forward parent lookups: if the child lacks a service, defer
    // to the parent. Disposers stay separate.
    const parent = this;
    const childCtx: PluginContext = {
      provide: child.provide.bind(child),
      inject: <T>(key: ServiceKey<T>): T => child.tryInject(key) ?? parent.inject(key),
      tryInject: <T>(key: ServiceKey<T>): T | undefined => child.tryInject(key) ?? parent.tryInject(key),
      effect: child.effect.bind(child),
      child: child.child.bind(child),
      keys: child.keys.bind(child)
    };
    this.childDisposers.push(() => child.unmount());
    return childCtx;
  }

  keys(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Internal: dispose all effects in reverse registration order.
   * Used by `PluginLoader.mount().unmount()` and by `child()` teardown.
   */
  unmount(): void {
    for (const d of this.disposers.reverse()) {
      try { d(); } catch (err) { console.error("[PluginContext] effect threw during unmount:", err); }
    }
    this.disposers = [];
    for (const d of this.childDisposers.reverse()) {
      try { d(); } catch (err) { console.error("[PluginContext] child threw during unmount:", err); }
    }
    this.childDisposers = [];
    this.services.clear();
  }
}

/**
 * `definePlugin` — turn a setup function into a reusable Plugin.
 *
 * The returned function IS the Plugin (not a factory). For
 * parameterization, capture options in the closure when defining
 * the plugin:
 *
 *     const myPlugin = definePlugin<MyOpts>((ctx, opts) => {
 *       ctx.provide(MyKey, opts);
 *     });
 *     loader.use(myPlugin, { debug: true });
 */
export function definePlugin<TOptions = void>(
  setup: (ctx: PluginContext, options: TOptions) => void
): Plugin<TOptions> {
  return (ctx, options) => {
    setup(ctx, options as TOptions);
  };
}

/**
 * `PluginLoader` — mounts plugins in registration order; the
 * returned context unmounts them in reverse.
 */
export class PluginLoader {
  private registrations: Array<{ plugin: Plugin<any>; options?: unknown }> = [];

  use<TOptions>(plugin: Plugin<TOptions>, options?: TOptions): this {
    this.registrations.push({ plugin: plugin as Plugin<any>, options });
    return this;
  }

  mount(): PluginContext & { unmount(): void } {
    const ctx = new ContextImpl();
    for (const reg of this.registrations) {
      try {
        reg.plugin(ctx as PluginContext, reg.options);
      } catch (err) {
        console.error(`[PluginLoader] plugin threw during mount:`, err);
        throw err;
      }
    }
    return ctx as PluginContext & { unmount(): void };
  }
}