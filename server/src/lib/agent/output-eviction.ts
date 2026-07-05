/**
 * Tool output eviction — saves large tool results to disk and replaces them
 * in the agent's history with a compact preview + file path.
 *
 * This prevents a single `read_file` on a large codebase from consuming the
 * entire context budget. The agent can re-read the evicted file if needed.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

export const EVICTION_THRESHOLD_CHARS = 8_000;
export const EVICTION_PREVIEW_CHARS = 2_000;
export const EVICTION_DIR = ".rapa/evicted";

export type EvictableResult = {
  success: boolean;
  data?: unknown;
  error?: string;
  output?: string;
  [key: string]: unknown;
};

/**
 * Returns true when a tool result's output or data string exceeds the
 * eviction threshold and should be offloaded to disk.
 */
export function shouldEvictResult(result: EvictableResult, threshold = EVICTION_THRESHOLD_CHARS): boolean {
  const outputLen = typeof result.output === "string" ? result.output.length : 0;
  const dataLen = typeof result.data === "string" ? result.data.length : 0;

  // Also check data.content for read_file-style results
  let contentLen = 0;
  if (result.data && typeof result.data === "object" && !Array.isArray(result.data)) {
    const record = result.data as Record<string, unknown>;
    if (typeof record.content === "string") {
      contentLen = record.content.length;
    }
  }

  return outputLen > threshold || dataLen > threshold || contentLen > threshold;
}

/**
 * Evict a large tool result to disk. Writes the full content to a file in
 * the workspace's .rapa/evicted/ directory and returns a new result with a
 * compact preview + file path.
 */
export async function evictResult(
  result: EvictableResult,
  workspacePath: string,
  toolName: string
): Promise<EvictableResult> {
  const evictionDir = join(workspacePath, EVICTION_DIR);

  try {
    await mkdir(evictionDir, { recursive: true });
  } catch {
    // Directory may already exist or workspace may be read-only
    return result;
  }

  const timestamp = Date.now().toString(36);
  const filename = `${toolName}-${timestamp}.txt`;
  const filePath = join(evictionDir, filename);
  const relativePath = relative(workspacePath, filePath);

  // Determine which content to evict
  let evictedContent = "";
  let evictedField = "";
  let charCount = 0;

  if (typeof result.output === "string" && result.output.length > EVICTION_THRESHOLD_CHARS) {
    evictedContent = result.output;
    evictedField = "output";
    charCount = result.output.length;
  } else if (typeof result.data === "string" && result.data.length > EVICTION_THRESHOLD_CHARS) {
    evictedContent = result.data;
    evictedField = "data";
    charCount = result.data.length;
  } else if (result.data && typeof result.data === "object" && !Array.isArray(result.data)) {
    const record = result.data as Record<string, unknown>;
    if (typeof record.content === "string" && record.content.length > EVICTION_THRESHOLD_CHARS) {
      evictedContent = record.content;
      evictedField = "data.content";
      charCount = record.content.length;
    }
  }

  if (!evictedContent) return result;

  try {
    await writeFile(filePath, evictedContent, "utf-8");
  } catch {
    return result;
  }

  const preview = evictedContent.slice(0, EVICTION_PREVIEW_CHARS);
  const evictionNotice =
    `[Content evicted to disk — ${charCount} chars saved to ${relativePath}. ` +
    `Use read_file to access full content if needed.]\n\n` +
    `Preview (first ${Math.min(EVICTION_PREVIEW_CHARS, charCount)} chars):\n${preview}`;

  // Build the new result with the eviction notice replacing the large content
  const newResult: EvictableResult = { ...result };

  if (evictedField === "output") {
    newResult.output = evictionNotice;
  } else if (evictedField === "data") {
    newResult.data = evictionNotice;
  } else if (evictedField === "data.content" && result.data && typeof result.data === "object") {
    const record = { ...(result.data as Record<string, unknown>) };
    record.content = evictionNotice;
    record.evictedPath = relativePath;
    record.evictedCharCount = charCount;
    newResult.data = record;
  }

  return newResult;
}
