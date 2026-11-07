// Agent hooks lifecycle (user-configurable event automation).
//
// Users register hooks against agent events ("tools/tool/call",
// "tools/tool/result", "agent/turn/end"). When a matching event fires, the
// hook runs a shell command or an HTTP POST — strictly fire-soft: a failing
// hook must never break the agent run.
//
// Transport contracts:
//   - shell: `target` is executed via the system shell with env vars
//     RAPA_HOOK_EVENT (event name) and RAPA_HOOK_PAYLOAD (JSON-stringified
//     payload). cwd is the run's workspaceRoot when present.
//   - http:  POST JSON {event, payload} to `target`.
//
// All dispatches are guarded upstream (`AgentConfig.hooks?.length`), so runs
// without hooks pay zero overhead.

import { execFile } from "node:child_process";
import { prisma } from "./db.js";

export type HookAction = "shell" | "http";

/** Normalized (DB-row-shaped) hook configuration passed to the agent loop. */
export type HookConfig = {
  id: string;
  name: string;
  event: string;
  /** Optional tool-name filter — hook fires only for this tool when set. */
  matchTool: string | null;
  action: HookAction;
  /** Shell command template or HTTP URL. */
  target: string;
  timeoutMs: number;
};

/**
 * Payload carried to hook targets. The known fields mirror the agent's
 * event emissions; unknown fields are preserved (hook payloads stay
 * forward-compatible with new event shapes).
 */
export type HookEventPayload = {
  call?: { id?: string; name?: string; parameters?: Record<string, unknown> };
  result?: { success?: boolean; output?: string; error?: string };
  workspaceRoot?: string;
  conversationId?: string;
  status?: string;
  iterations?: number;
  elapsedMs?: number;
};

/** Injectable I/O seams for tests — production callers omit them. */
export type HookDeps = {
  execFileFn?: typeof execFile;
  fetchFn?: typeof fetch;
};

const DEFAULT_HOOK_TIMEOUT_MS = 5000;

/**
 * Load the user's enabled hooks, oldest first. Called once per agent
 * request (per-call-site "cache") — deliberately no long-lived cache so
 * hook edits take effect immediately.
 */
export async function loadHooksForUser(userId: string): Promise<HookConfig[]> {
  try {
    const rows = await prisma.agentHook.findMany({
      where: { userId, enabled: true },
      orderBy: { createdAt: "asc" }
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      event: row.event,
      matchTool: row.matchTool,
      action: row.action === "http" ? "http" : "shell",
      target: row.target,
      timeoutMs: row.timeoutMs
    }));
  } catch (err) {
    console.warn("[hooks] failed to load hooks:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Fire a single hook. Fire-soft: every failure path is caught and logged
 * via console.warn — this function never throws.
 */
export async function dispatchHook(
  hook: HookConfig,
  event: string,
  payload: HookEventPayload,
  deps: HookDeps = {}
): Promise<void> {
  const execFileFn = deps.execFileFn ?? execFile;
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = hook.timeoutMs > 0 ? hook.timeoutMs : DEFAULT_HOOK_TIMEOUT_MS;

  try {
    if (hook.action === "http") {
      const response = await fetchFn(hook.target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, payload }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) {
        console.warn(`[hooks] http hook "${hook.name}" responded ${response.status}`);
      }
      return;
    }

    // Shell: run the command template through the system shell. The event
    // name and payload ride as env vars so templates stay a one-liner.
    const env = {
      ...process.env,
      RAPA_HOOK_EVENT: event,
      RAPA_HOOK_PAYLOAD: JSON.stringify(payload)
    };
    await new Promise<void>((resolve) => {
      execFileFn(
        hook.target,
        [],
        {
          shell: true,
          env,
          timeout: timeoutMs,
          ...(payload.workspaceRoot ? { cwd: payload.workspaceRoot } : {})
        },
        (err) => {
          if (err) {
            console.warn(`[hooks] shell hook "${hook.name}" failed:`, err.message);
          }
          resolve();
        }
      );
    });
  } catch (err) {
    console.warn(
      `[hooks] ${hook.action} hook "${hook.name}" failed:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Match and dispatch all hooks for an event, in parallel. When `hooks` is
 * provided (preloaded by the caller — the agent loop does this from
 * AgentConfig) no DB lookup happens. Usage counters are bumped best-effort
 * with a voided promise so accounting never delays dispatch.
 *
 * Returns a promise that resolves once every matched hook dispatch has
 * settled; hook failures never reject it.
 */
export async function dispatchHooksForEvent(
  userId: string,
  event: string,
  payload: HookEventPayload,
  hooks?: HookConfig[],
  deps: HookDeps = {}
): Promise<void> {
  let matched: HookConfig[];
  try {
    const candidates = hooks ?? await loadHooksForUser(userId);
    matched = candidates.filter(
      (hook) => hook.event === event
        && (!hook.matchTool || hook.matchTool === payload.call?.name)
    );
  } catch (err) {
    console.warn(`[hooks] dispatch for "${event}" failed:`, err instanceof Error ? err.message : String(err));
    return;
  }

  await Promise.all(matched.map(async (hook) => {
    await dispatchHook(hook, event, payload, deps);
    // Best-effort usage accounting — never blocks, never rejects.
    void prisma.agentHook.update({
      where: { id: hook.id },
      data: { useCount: { increment: 1 }, lastUsedAt: new Date() }
    }).catch(() => {});
  }));
}
