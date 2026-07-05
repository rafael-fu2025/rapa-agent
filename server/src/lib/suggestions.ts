// Shared error-recovery suggestion helpers.
//
// §4.5 of the upgrade plan: when a tool fails, populate the `suggestions`
// field on the result with 1-3 short imperative hints. The agent loop
// already includes `errorCategory` in the trace; the new `suggestions`
// field is for the LLM to read directly.

import type { ToolResult } from "./tools.js";

/**
 * Attach suggestions to a failure result. Returns a fresh ToolResult
 * so the original failure object is not mutated. Use this in `if (!ok)
 * return withSuggestions(fail, [...])` blocks.
 */
export function withSuggestions(
  result: ToolResult,
  suggestions: string[]
): ToolResult {
  if (suggestions.length === 0) return result;
  return { ...result, suggestions: dedupe(suggestions).slice(0, 5) };
}

/**
 * Common suggestion bundles for the most common failure shapes.
 * Each helper accepts a failure result and returns the same result
 * with a `suggestions` array attached.
 */
export const Suggest = {
  /** ENOENT — file not found. Suggest listing the parent or searching. */
  fileNotFound(result: ToolResult, attemptedPath: string): ToolResult {
    return withSuggestions(result, [
      `Call list_directory on the parent of "${attemptedPath}" to confirm the filename.`,
      `Or call search_files with a glob like "**/${attemptedPath.split(/[\\/]/).pop()}" to locate the file.`
    ]);
  },

  /** EACCES / permission denied. */
  permissionDenied(result: ToolResult, target: string): ToolResult {
    return withSuggestions(result, [
      `Verify the agent's user has read/write permission on "${target}".`,
      `If the workspace is owned by another user, run chown/chmod or restart the server as the correct user.`
    ]);
  },

  /** Edit file — "match not found" / "0 occurrences" / "multiple matches". */
  editNotFound(result: ToolResult, oldText: string): ToolResult {
    return withSuggestions(result, [
      "Call read_file on the target file to see its current content; the file may have changed since you last read it.",
      "Re-read the surrounding lines and try edit_file again with a smaller, more unique snippet of oldText.",
      "If the file is large, narrow oldText to a single line or a unique identifier inside it."
    ]);
  },

  /** Edit file — "N occurrences" — match was ambiguous. */
  editAmbiguous(result: ToolResult, occurrences: number): ToolResult {
    return withSuggestions(result, [
      `oldText matched ${occurrences} places in the file. Make it more specific so it matches exactly once.`,
      "Include the line above and below the intended target to disambiguate."
    ]);
  },

  /** Shell command timed out. */
  shellTimeout(result: ToolResult, command: string): ToolResult {
    return withSuggestions(result, [
      `The command "${truncate(command, 60)}" exceeded the timeout.`,
      "For long-running commands, use start_process to launch it in the background, then poll with get_process_output.",
      "Or raise the `timeout` parameter (in milliseconds) and retry."
    ]);
  },

  /** Shell command not found. */
  commandNotFound(result: ToolResult, command: string): ToolResult {
    return withSuggestions(result, [
      `The command "${truncate(command, 60)}" is not on PATH.`,
      "Check the project's README for the install instructions, or use a different command available in the workspace."
    ]);
  },

  /** HTTP 403/401. */
  httpForbidden(result: ToolResult, url: string): ToolResult {
    return withSuggestions(result, [
      `The URL "${truncate(url, 80)}" returned a 403/401.`,
      "Check the request headers (Authorization, User-Agent) — the host may require auth or block non-browser clients.",
      "If the host expects a browser, use a browser_* tool to navigate and read the page."
    ]);
  },

  /** HTTP 429 — rate limit. */
  httpRateLimit(result: ToolResult, url: string): ToolResult {
    return withSuggestions(result, [
      `The URL "${truncate(url, 80)}" returned 429 (rate limited).`,
      "Wait a few seconds and retry, or switch to a different provider/key if one is configured."
    ]);
  },

  /** Generic fallback. */
  generic(result: ToolResult, hint: string): ToolResult {
    return withSuggestions(result, [hint]);
  }
};

function dedupe(suggestions: string[]): string[] {
  return Array.from(new Set(suggestions));
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
