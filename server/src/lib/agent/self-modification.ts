/**
 * Self-modification — SKELETON.
 *
 * See `.agents/notes/proposed/architecture/2026-08-15-self-modification.md`
 * (status: proposed). The runtime — plugin name resolution,
 * approval-gated tool wrappers, bus events — is not yet implemented.
 *
 * The intent: the agent can mount and unmount its own plugins
 * through `mount_plugin` and `unmount_plugin` tools, both gated by
 * the existing approval flow.
 */

import type { AgentEventBus } from "./event-bus.js";
import type { Plugin, PluginLoader } from "./plugin.js";

/**
 * Manifest schema for a mountable plugin. The agent constructs one
 * of these from its conversation context (e.g., user says "I need
 * a watcher for new files in /data").
 */
export interface PluginManifest<TOptions = unknown> {
  name: string;
  version: string;
  source: "builtin" | "user" | "fetched";
  /** Options to pass to the plugin on mount. */
  options?: TOptions;
  /** Human-readable description used in the approval prompt. */
  description: string;
}

/**
 * PluginRegistry — name → Plugin factory. Populated at boot from
 * `definePlugin` calls; agents read from it to resolve manifests.
 *
 * SKELETON: only the type and lookup API are defined.
 */
export class PluginRegistry {
  private plugins = new Map<string, () => Plugin<unknown>>();

  register(name: string, factory: () => Plugin<unknown>): void {
    this.plugins.set(name, factory);
  }

  resolve(manifest: PluginManifest): Plugin<unknown> | undefined {
    const factory = this.plugins.get(manifest.name);
    return factory?.();
  }

  list(): string[] {
    return Array.from(this.plugins.keys());
  }
}

/**
 * `mountPlugin` — SKELETON. The real implementation will:
 * 1. Resolve the manifest via `PluginRegistry`.
 * 2. Emit `agent/plugin/mount` on the bus.
 * 3. Call `loader.use(plugin, options)`.
 * 4. Track the disposer so `unmountPlugin` can reverse it.
 *
 * Approval is enforced by the caller (the tool wrapper for
 * `mount_plugin` uses the existing approval flow).
 */
export async function mountPlugin(
  manifest: PluginManifest,
  loader: PluginLoader,
  bus: AgentEventBus
): Promise<{ disposer: () => void } | { error: string }> {
  // SKELETON: not yet implemented.
  throw new Error(
    "mountPlugin() is not yet implemented. " +
    "See `.agents/notes/proposed/architecture/2026-08-15-self-modification.md`."
  );
}

/**
 * `unmountPlugin` — SKELETON.
 */
export async function unmountPlugin(
  name: string,
  loader: PluginLoader,
  bus: AgentEventBus
): Promise<{ unmounted: true } | { error: string }> {
  throw new Error(
    "unmountPlugin() is not yet implemented. " +
    "See `.agents/notes/proposed/architecture/2026-08-15-self-modification.md`."
  );
}