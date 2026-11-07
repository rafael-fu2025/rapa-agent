// Sandbox resolution entry point.
//
// Tools call `resolveSandboxMode` to determine the active mode:
//   1. `context.sandboxMode` — populated from AgentConfig by the agent
//      bootstrap (wired by the coordinator in a later wave),
//   2. `RAPA_SANDBOX_MODE` env var — operator escape hatch,
//   3. "native" default.
//
// `resolveSandboxBackend` maps the mode to a memoized backend singleton.
// "off" returns null: no wrapping AND no sandbox policy.

import type { SandboxBackend, SandboxMode } from "./types.js";

export type { SandboxBackend, SandboxMode } from "./types.js";
export { SandboxUnavailableError } from "./docker.js";
export { terminateProcessTree, spawnTreeKillable } from "./native.js";

import { getNativeSandbox } from "./native.js";
import { getDockerSandbox } from "./docker.js";

function isSandboxMode(value: unknown): value is SandboxMode {
  return value === "native" || value === "docker" || value === "off";
}

/**
 * Resolve the effective sandbox mode for a tool execution context.
 * Falls back to the RAPA_SANDBOX_MODE env var, then "native".
 */
export function resolveSandboxMode(context?: { sandboxMode?: SandboxMode }): SandboxMode {
  if (isSandboxMode(context?.sandboxMode)) {
    return context.sandboxMode;
  }
  const raw = process.env.RAPA_SANDBOX_MODE?.trim().toLowerCase();
  if (isSandboxMode(raw)) {
    return raw;
  }
  return "native";
}

let nativeBackend: SandboxBackend | undefined;
let dockerBackend: SandboxBackend | undefined;

/**
 * Map a sandbox mode to its backend. Returns null for "off" (no sandboxing).
 * Backends are process-wide singletons so probe results are memoized.
 */
export function resolveSandboxBackend(mode: SandboxMode): SandboxBackend | null {
  if (mode === "off") return null;
  if (mode === "docker") {
    dockerBackend ??= getDockerSandbox();
    return dockerBackend;
  }
  nativeBackend ??= getNativeSandbox();
  return nativeBackend;
}

// ---------------------------------------------------------------------------
// Native-fallback acknowledgement.
//
// When Docker mode is configured but the backend is unavailable, the first
// affected command returns a validation error ("Docker sandbox unavailable —
// approve to run natively"). Once that error has been surfaced for the
// process, subsequent commands run natively (with the privilege-escalation
// policy still enforced) instead of erroring forever. This is the "sandboxMode
// treated as native for that call" contract — never a silent bypass on the
// first occurrence.
// ---------------------------------------------------------------------------

let nativeFallbackAcknowledged = false;

/** Record that a sandbox-unavailable error has been surfaced to the caller. */
export function acknowledgeNativeFallback(): void {
  nativeFallbackAcknowledged = true;
}

/** Whether a previous sandbox-unavailable error unlocked the native fallback. */
export function isNativeFallbackAcknowledged(): boolean {
  return nativeFallbackAcknowledged;
}

/** Test hook: clear the acknowledgement. */
export function resetNativeFallbackForTests(): void {
  nativeFallbackAcknowledged = false;
}
