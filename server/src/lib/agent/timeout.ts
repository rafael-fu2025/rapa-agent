// Per-tool timeout helper.
//
// Replaces unbounded waits with a Promise.race-style wrapper. Critical for
// shell and network tools that can hang indefinitely. See research doc T2 and
// MavikLabs 2026 timeout guide.

export class ToolTimeoutError extends Error {
  readonly name = "ToolTimeoutError";
  readonly toolName: string;
  readonly timeoutMs: number;

  constructor(toolName: string, timeoutMs: number) {
    super(`Tool ${toolName} timed out after ${timeoutMs}ms`);
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

/** Default per-tool timeout budgets (milliseconds). */
export const DEFAULT_TOOL_TIMEOUTS_MS: Record<string, number> = {
  // Fast lookups
  read_file: 5_000,
  list_directory: 5_000,
  search_files: 10_000,
  search_content: 10_000,
  git_status: 5_000,
  git_diff: 5_000,
  git_log: 5_000,
  git_branch: 5_000,
  // Network
  web_search: 15_000,
  fetch_url: 30_000,
  // Slow operations
  execute_command: 120_000,
  read_lints: 30_000,
  run_tests: 300_000
};

export const FALLBACK_TOOL_TIMEOUT_MS = 30_000;

export function getToolTimeoutMs(toolName: string): number {
  return DEFAULT_TOOL_TIMEOUTS_MS[toolName] ?? FALLBACK_TOOL_TIMEOUT_MS;
}

/**
 * Race a promise against a timeout. Rejects with ToolTimeoutError on expiry.
 * The wrapped promise is NOT cancelled (Node has no general cancellation), but
 * its result is dropped. Callers should make tool implementations abort-aware.
 */
export function withTimeout<T>(
  toolName: string,
  promise: Promise<T>,
  timeoutMs: number = getToolTimeoutMs(toolName)
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ToolTimeoutError(toolName, timeoutMs));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
