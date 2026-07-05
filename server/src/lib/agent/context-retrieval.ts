/**
 * Semantic context retrieval — searches past conversations and tool outputs
 * using MySQL full-text search to find relevant context for the current task.
 *
 * No vector database needed — uses MySQL's built-in MATCH...AGAINST for
 * natural language full-text search over conversation summaries and tool
 * output previews.
 */

import { prisma } from "../db.js";

export type RetrievedContext = {
  source: "conversation" | "tool_call";
  conversationId: string;
  conversationTitle: string;
  content: string;
  relevanceScore: number;
  createdAt: Date;
};

/**
 * Stop words to strip from queries before full-text search.
 * MySQL has its own stop word list, but stripping common English words
 * improves relevance for short queries.
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "and", "but", "or",
  "not", "no", "so", "if", "then", "than", "that", "this", "it", "its",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "they",
  "what", "which", "who", "when", "where", "how", "all", "each", "every",
  "just", "about", "also", "very", "make", "create", "build", "add",
  "get", "use", "need", "want", "help", "please"
]);

/**
 * Extract meaningful keywords from a query string.
 */
function extractKeywords(query: string, maxKeywords = 8): string {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  // Deduplicate and take top N
  const unique = [...new Set(words)].slice(0, maxKeywords);
  return unique.join(" ");
}

/**
 * Retrieve relevant context from past conversations and tool outputs.
 */
export async function retrieveRelevantContext(params: {
  userId: string;
  query: string;
  workspaceId?: string;
  excludeConversationId?: string;
  limit?: number;
}): Promise<RetrievedContext[]> {
  const keywords = extractKeywords(params.query);
  if (!keywords) return [];

  const limit = params.limit ?? 5;
  const results: RetrievedContext[] = [];

  // Search conversation summaries
  try {
    const conversations = await prisma.conversation.findMany({
      where: {
        userId: params.userId,
        memorySummary: { not: null },
        ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
        ...(params.excludeConversationId ? { id: { not: params.excludeConversationId } } : {})
      },
      select: {
        id: true,
        title: true,
        memorySummary: true,
        createdAt: true
      },
      take: limit * 2, // Over-fetch to merge with tool results
      orderBy: { updatedAt: "desc" }
    });

    for (const conv of conversations) {
      if (!conv.memorySummary) continue;
      const summary = conv.memorySummary;
      // Simple keyword overlap scoring
      const keywordList = keywords.split(" ");
      const matches = keywordList.filter((kw) =>
        summary.toLowerCase().includes(kw)
      ).length;
      if (matches === 0) continue;

      results.push({
        source: "conversation",
        conversationId: conv.id,
        conversationTitle: conv.title,
        content: summary.slice(0, 800),
        relevanceScore: matches / keywordList.length,
        createdAt: conv.createdAt
      });
    }
  } catch {
    // Full-text index may not exist yet — fall through
  }

  // Search tool call outputs
  try {
    const toolCalls = await prisma.agentToolCall.findMany({
      where: {
        run: {
          conversation: {
            userId: params.userId,
            ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
            ...(params.excludeConversationId ? { id: { not: params.excludeConversationId } } : {})
          }
        },
        outputPreview: { not: null }
      },
      select: {
        id: true,
        name: true,
        outputPreview: true,
        completedAt: true,
        run: {
          select: {
            conversationId: true,
            conversation: {
              select: { title: true }
            }
          }
        }
      },
      take: limit * 2,
      orderBy: { completedAt: "desc" }
    });

    for (const call of toolCalls) {
      if (!call.outputPreview) continue;
      const preview = call.outputPreview;
      const keywordList = keywords.split(" ");
      const matches = keywordList.filter((kw) =>
        preview.toLowerCase().includes(kw)
      ).length;
      if (matches === 0) continue;

      results.push({
        source: "tool_call",
        conversationId: call.run.conversationId,
        conversationTitle: call.run.conversation.title,
        content: `[${call.name}] ${preview.slice(0, 600)}`,
        relevanceScore: matches / keywordList.length,
        createdAt: call.completedAt ?? new Date()
      });
    }
  } catch {
    // Schema may not have the relation — fall through
  }

  // Sort by relevance and return top N
  results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return results.slice(0, limit);
}

/**
 * Format retrieved context as a system message for injection into the
 * agent's conversation history.
 */
export function formatRetrievedContext(contexts: RetrievedContext[]): string {
  if (contexts.length === 0) return "";

  const sections = contexts.map((ctx, i) => {
    const source = ctx.source === "conversation" ? "Past conversation" : "Past tool output";
    const date = ctx.createdAt.toLocaleDateString();
    return `### ${i + 1}. ${ctx.conversationTitle} (${source}, ${date})\n${ctx.content}`;
  });

  return [
    "## Relevant Past Context",
    "The following context from previous conversations may be relevant to the current task.",
    "Use it when helpful, ignore it when not.",
    "",
    ...sections
  ].join("\n");
}
