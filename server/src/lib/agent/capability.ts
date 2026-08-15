/**
 * Capability seam triple — Service Definition / Provider / Policy.
 *
 * See `.agents/notes/implemented/architecture/2026-08-15-capability-seam-triple.md`.
 *
 * The existing `Tool` class is wrapped as a Provider automatically
 * (see `wrapToolAsProvider`), so all 22 existing tool subclasses
 * keep working without modification.
 */

import { Tool, type ToolCategory, type ToolDefinition, type ToolExecutionContext, type ToolParameter, type ToolResult } from "../tools.js";

export type ToolRiskLevel = "none" | "read" | "write" | "destructive" | "network";
// ToolCategory is re-exported from tools.ts to keep one source of truth.

/**
 * Service Definition — pure metadata. No execution, no policy.
 */
export interface CapabilityDefinition<TParams = unknown, TResult = unknown> {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  category: ToolCategory;
  /**
   * Hints at how the UI should render the result. Mirrors dsh's
   * `tool-execution-pipeline` cookbook: `generic` for plain text,
   * `terminal` for shell output, `diff` for edits.
   */
  resultShape?: (result: TResult) => "generic" | "terminal" | "diff";
}

/**
 * Service Provider — execution interface.
 *
 * Generics are *invariant* in the registry: a Provider<Params, Result>
 * is stored as Provider<unknown, unknown> in the CapabilityEntry so
 * different generics can coexist.
 */
export interface CapabilityProvider<TParams = unknown, TResult = unknown> {
  readonly definition: CapabilityDefinition<TParams, TResult>;
  execute(params: TParams, context: ToolExecutionContext): Promise<TResult>;
}

export type AnyCapabilityProvider = CapabilityProvider<unknown, unknown>;

/**
 * Policy — set per-registration, not hardcoded into the tool.
 */
export interface CapabilityPolicy {
  riskLevel: ToolRiskLevel;
  requiresApproval: boolean;
  /**
   * Optional synchronous or async function to mutate params
   * before execution. Receives the raw params from the LLM.
   */
  preExecuteHook?: (params: unknown) => Promise<unknown> | unknown;
}

/**
 * Registry entry — what `get()` returns.
 */
export interface CapabilityEntry<TParams = unknown, TResult = unknown> {
  provider: CapabilityProvider<TParams, TResult>;
  policy: CapabilityPolicy;
}

/**
 * The new registry. Replaces the role of `ToolRegistry` going
 * forward; `ToolRegistry` becomes a thin shim for backward compat.
 */
export class CapabilityRegistry {
  private entries = new Map<string, CapabilityEntry>();

  /**
   * Explicit triple form — Provider + Policy.
   */
  register<TParams, TResult>(
    provider: CapabilityProvider<TParams, TResult>,
    policy: CapabilityPolicy
  ): void {
    const name = provider.definition.name;
    if (this.entries.has(name)) {
      throw new Error(`Capability "${name}" already registered`);
    }
    this.entries.set(name, {
      provider: provider as AnyCapabilityProvider,
      policy
    });
  }

  /**
   * Backward-compat shim — wrap an existing `Tool` instance as a
   * Provider with default policy extracted from its definition.
   */
  registerTool(tool: Tool): void {
    const def = tool.definition;
    const provider = wrapToolAsProvider(tool);
    this.register(provider, {
      riskLevel: def.riskLevel ?? "read",
      requiresApproval: def.requiresApproval ?? false
    });
  }

  get(name: string): CapabilityEntry | undefined {
    return this.entries.get(name);
  }

  list(): CapabilityEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Filter entries by minimum risk level. Used by `runAgent` /
   * plan-mode policy layers to skip tools above a threshold.
   */
  listByRisk(max: ToolRiskLevel): CapabilityEntry[] {
    const order: Record<ToolRiskLevel, number> = {
      none: 0,
      read: 1,
      write: 2,
      network: 3,
      destructive: 4
    };
    return this.list().filter((e) => order[e.policy.riskLevel] <= order[max]);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Test helper. */
  clear(): void {
    this.entries.clear();
  }

  /** Test helper: number of registered entries. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Bulk-populate from the legacy `toolRegistry`. Each registered
   * Tool is wrapped as a Provider; `riskLevel` and `requiresApproval`
   * on its `definition` are extracted into Policy. Idempotent — a
   * second call replaces existing entries.
   *
   * Call this once, after `registerAllTools()` has run. Future code
   * (orchestrator, policy layers, observers) reads from
   * `capabilityRegistry` instead of `toolRegistry`.
   */
  rebuildFromToolRegistry(tools: { list(): ToolDefinition[]; get(name: string): Tool | undefined }): void {
    this.entries.clear();
    for (const def of tools.list()) {
      const tool = tools.get(def.name);
      if (!tool) continue;
      const provider = wrapToolAsProvider(tool);
      this.entries.set(def.name, {
        provider,
        policy: {
          riskLevel: def.riskLevel ?? "read",
          requiresApproval: def.requiresApproval ?? false
        }
      });
    }
  }
}

/**
 * Helper for the orchestrator: resolve a capability entry by name.
 * Returns `undefined` if the tool is not registered.
 */
export function lookupCapability(name: string): CapabilityEntry | undefined {
  return capabilityRegistry.get(name);
}

/**
 * Helper for prompt building: list all capabilities the LLM should
 * see. Filters by mode when provided.
 */
export function listCapabilitiesForMode(mode: "chat" | "plan" | "agent"): CapabilityEntry[] {
  const all = capabilityRegistry.list();
  if (mode === "chat") {
    return all.filter((e) => e.provider.definition.category === "web" || e.provider.definition.category === "system");
  }
  if (mode === "plan") {
    const denied = new Set(["execute_command", "write_file", "edit_file"]);
    return all.filter((e) => !denied.has(e.provider.definition.name));
  }
  return all;
}

/**
 * Wrap a `Tool` instance as a `CapabilityProvider`. The Tool's
 * `definition` (minus `riskLevel` and `requiresApproval`, which
 * move to Policy) becomes the Provider's `definition`. The Tool's
 * `execute` method becomes the Provider's `execute`.
 */
export function wrapToolAsProvider(tool: Tool): CapabilityProvider {
  const def = tool.definition as ToolDefinition & { riskLevel?: ToolRiskLevel; requiresApproval?: boolean };
  const providerDef: CapabilityDefinition = {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    category: def.category
  };
  return {
    definition: providerDef,
    async execute(params: unknown, context: ToolExecutionContext): Promise<ToolResult> {
      return tool.execute(params as Record<string, unknown>, context);
    }
  };
}

/**
 * Process-wide capability registry. Module-level singleton.
 * Tools register into this on `registerAllTools()`.
 */
export const capabilityRegistry = new CapabilityRegistry();