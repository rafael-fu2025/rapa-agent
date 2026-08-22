/**
 * Proactive mid-run context compaction with graduated thresholds.
 *
 * Three levels of intervention based on context usage:
 * - WARN (70%): Nudge the model to start wrapping up
 * - COMPACT (80%): Summarize older turns to reclaim space
 * - FORCE_ANSWER (95%): Stop everything, produce final answer
 *
 * The working memory file (.rapa/working-memory.md) persists on disk
 * and survives all compaction levels.
 */

import { readFile, stat } from "node:fs/promises";
import { PROVIDER_HISTORY_CHAR_BUDGET, type AgentMessage } from "./types.js";
import { resolveWorkspacePathSafe } from "../../tools/filesystem.js";

export const COMPACTION_WARN_THRESHOLD = 0.55;
export const COMPACTION_THRESHOLD = 0.65;
export const COMPACTION_FORCE_THRESHOLD = 0.85;
export const COMPACTION_KEEP_RECENT_RATIO = 0.30;
export const COMPACTION_SUMMARY_CHAR_LIMIT = 6_000;

export type CompactionAction = "none" | "warn" | "compact" | "force_answer";

/**
 * Determine what compaction action to take based on current history size.
 */
export function getCompactionAction(
  history: AgentMessage[],
  budget: number
): CompactionAction {
  if (history.length < 4) return "none";
  const cost = estimateHistoryCost(history);
  const usage = cost / budget;

  if (usage >= COMPACTION_FORCE_THRESHOLD) return "force_answer";
  if (usage >= COMPACTION_THRESHOLD) return "compact";
  if (usage >= COMPACTION_WARN_THRESHOLD) return "warn";
  return "none";
}

const COMPACTION_SYSTEM_PROMPT = [
  "You are a context compaction engine. Summarize the following older conversation",
  "turns into a compact factual record. Preserve:",
  "- User goals and requirements",
  "- Decisions made and their rationale",
  "- Files read, written, or modified (with paths)",
  "- Commands executed and their outcomes",
  "- Errors encountered and how they were resolved",
  "- Current task state (what's done, what's next)",
  "",
  "Do NOT include:",
  "- Verbatim tool output or file contents",
  "- Repetitive status updates",
  "- Greetings or filler text",
  "",
  "Return plain text only. Be factual and concise."
].join("\n");

/**
 * Estimate the total character cost of a history array.
 * Uses the same heuristic as buildProviderMessages: string length + 32 overhead.
 */
function estimateHistoryCost(history: AgentMessage[]): number {
  let total = 0;
  for (const msg of history) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    total += content.length + 32;
    if (msg.toolCalls) {
      total += JSON.stringify(msg.toolCalls).length;
    }
    if (msg.toolResults) {
      total += JSON.stringify(msg.toolResults).length;
    }
  }
  return total;
}

/**
 * Returns true when the history exceeds the compaction threshold.
 */
export function shouldCompact(
  history: AgentMessage[],
  budget: number = PROVIDER_HISTORY_CHAR_BUDGET
): boolean {
  if (history.length < 6) return false; // Don't compact tiny conversations
  const cost = estimateHistoryCost(history);
  return cost > budget * COMPACTION_THRESHOLD;
}

/**
 * Compact the history by summarizing older turns and keeping recent ones.
 *
 * @param history The current agent history
 * @param budget The character budget
 * @param llmCall A function that sends messages to the LLM and returns the response text
 * @param existingSummary An optional prior summary to build upon
 * @returns The compacted history and the new summary
 */
export async function compactHistory(
  history: AgentMessage[],
  budget: number,
  llmCall: (messages: Array<{ role: string; content: string }>) => Promise<string>,
  existingSummary?: string
): Promise<{ compactedHistory: AgentMessage[]; summary: string; dropped: AgentMessage[] }> {
  const keepBudget = budget * COMPACTION_KEEP_RECENT_RATIO;

  // Walk newest-first to find the split point
  let keptCost = 0;
  let splitIndex = history.length;

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    const cost = content.length + 32 + (msg.toolCalls ? JSON.stringify(msg.toolCalls).length : 0);
    if (keptCost + cost > keepBudget) break;
    keptCost += cost;
    splitIndex = i;
  }

  // Don't compact if there's nothing old enough to compact
  if (splitIndex >= history.length - 1) {
    return { compactedHistory: history, summary: existingSummary ?? "", dropped: [] };
  }

  const toCompact = history.slice(0, splitIndex);
  const toKeep = history.slice(splitIndex);

  // Format the old turns as a transcript for the LLM
  const transcript = toCompact.map((msg) => {
    const role = msg.role === "tool" ? "tool_result" : msg.role;
    const content = typeof msg.content === "string"
      ? msg.content.slice(0, 4000) // Cap each message for the summarization prompt
      : JSON.stringify(msg.content).slice(0, 4000);
    return `${role}: ${content}`;
  }).join("\n\n");

  const userPrompt = existingSummary
    ? `Previous summary:\n${existingSummary}\n\nNew turns to merge:\n${transcript}`
    : `Summarize these conversation turns:\n${transcript}`;

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: COMPACTION_SYSTEM_PROMPT },
    { role: "user", content: userPrompt }
  ];

  let summary: string;
  try {
    summary = await llmCall(messages);
    if (summary.length > COMPACTION_SUMMARY_CHAR_LIMIT) {
      summary = summary.slice(0, COMPACTION_SUMMARY_CHAR_LIMIT) + "…";
    }
  } catch {
    // If summarization fails, keep the original history
    return { compactedHistory: history, summary: existingSummary ?? "", dropped: [] };
  }

  // Build the compacted history: summary system message + recent turns
  const summaryMessage: AgentMessage = {
    role: "system",
    content: `[Compacted context — older turns summarized]\n${summary}`
  };

  return {
    compactedHistory: [summaryMessage, ...toKeep],
    summary,
    dropped: toCompact
  };
}

// ─── Post-compaction file restoration ────────────────────────────────────────
//
// Naive compaction is "where coding agents go to die": the summary mentions
// file paths but the actual file state the model was working from is gone,
// so the first post-compaction action is usually a redundant re-read — or
// worse, editing against remembered-but-wrong content. Re-attaching the
// most recently read files verbatim (freshest on-disk state) bridges that
// gap cheaply.

/** Files worth re-attaching after compaction. */
export const RESTORATION_MAX_FILES = 5;
/** Per-file cap on restored content. */
export const RESTORATION_MAX_FILE_CHARS = 8_000;
/** Skip restoring implausibly large files entirely. */
export const RESTORATION_MAX_FILE_BYTES = 100 * 1024;
/** Below this remaining budget a restoration stub would be useless — stop. */
export const RESTORATION_MIN_USEFUL_CHARS = 200;

/**
 * Collect the distinct `read_file` paths from the messages dropped by
 * compaction, newest-first. Tool results don't carry the tool name — they
 * are positionally aligned with the `toolCalls` of the preceding assistant
 * message — so we walk forward pairing each tool message against its caller,
 * then reverse for newest-first ordering. Paths present in `prioritize`
 * (files written this run — the agent is likely still editing them) sort
 * first. Duplicate reads collapse to one entry.
 */
export function collectRecentlyReadFiles(
  dropped: AgentMessage[],
  prioritize: Set<string> = new Set(),
  maxFiles: number = RESTORATION_MAX_FILES
): string[] {
  const normalize = (p: string) => p.replace(/^\.\//, "").replace(/\\/g, "/").toLowerCase();
  const prioritySet = new Set([...prioritize].map(normalize));

  const oldestFirst: string[] = [];
  const seen = new Set<string>();
  let callerToolCalls: Array<{ name?: unknown }> = [];
  for (const msg of dropped) {
    if (msg.role === "assistant") {
      callerToolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
      continue;
    }
    if (msg.role !== "tool" || !Array.isArray(msg.toolResults)) continue;
    const results = msg.toolResults;
    for (let j = 0; j < results.length; j += 1) {
      if (callerToolCalls[j]?.name !== "read_file") continue;
      const data = results[j]?.data;
      if (!data || typeof data !== "object") continue;
      const path = (data as { path?: unknown }).path;
      if (typeof path !== "string" || path.length === 0) continue;
      const key = normalize(path);
      if (seen.has(key)) continue;
      seen.add(key);
      oldestFirst.push(path);
    }
  }

  // Newest-first, then stable partition: prioritized (written this run)
  // first, preserving order within each partition.
  const ordered = oldestFirst.reverse();
  const prioritized = ordered.filter((p) => prioritySet.has(normalize(p)));
  const rest = ordered.filter((p) => !prioritySet.has(normalize(p)));
  return [...prioritized, ...rest].slice(0, maxFiles);
}

/**
 * Re-read the given workspace-relative paths from disk and render each as a
 * system message carrying the current on-disk state. `charBudget` bounds the
 * TOTAL restored content so restoration cannot immediately re-trip the
 * compaction threshold. Files that are missing, oversized, or outside the
 * workspace are skipped silently. Always returns `system`-role messages — a
 * synthetic `role:"tool"` message has no `tool_call_id` and would break
 * provider tool-linking rules.
 */
export async function buildFileRestorationMessages(
  paths: string[],
  workspaceRoot: string,
  charBudget: number
): Promise<AgentMessage[]> {
  if (!workspaceRoot || paths.length === 0 || charBudget <= 0) return [];

  const messages: AgentMessage[] = [];
  let remaining = charBudget;
  for (const path of paths) {
    if (remaining < RESTORATION_MIN_USEFUL_CHARS) break;
    try {
      const fullPath = await resolveWorkspacePathSafe(path, workspaceRoot);
      const stats = await stat(fullPath);
      if (!stats.isFile() || stats.size > RESTORATION_MAX_FILE_BYTES) continue;

      const content = await readFile(fullPath, "utf-8");
      const lineCount = content.split(/\r?\n/).length;
      const cap = Math.min(RESTORATION_MAX_FILE_CHARS, remaining);
      const body = content.length > cap
        ? `${content.slice(0, cap)}\n…[restored content truncated at ${cap} chars — use read_file with offset for the rest]`
        : content;

      messages.push({
        role: "system",
        content: `[File restored after context compaction — current on-disk state]\npath: ${path}\nlines: ${lineCount}\n\n${body}`
      });
      remaining -= body.length;
    } catch {
      // Missing/unreadable/escaping path — skip this file.
    }
  }
  return messages;
}
