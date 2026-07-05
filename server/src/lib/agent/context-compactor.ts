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

import type { AgentMessage } from "./types.js";
import { PROVIDER_HISTORY_CHAR_BUDGET } from "./types.js";

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
): Promise<{ compactedHistory: AgentMessage[]; summary: string }> {
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
    return { compactedHistory: history, summary: existingSummary ?? "" };
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
    return { compactedHistory: history, summary: existingSummary ?? "" };
  }

  // Build the compacted history: summary system message + recent turns
  const summaryMessage: AgentMessage = {
    role: "system",
    content: `[Compacted context — older turns summarized]\n${summary}`
  };

  return {
    compactedHistory: [summaryMessage, ...toKeep],
    summary
  };
}
