/**
 * search_memory tool — lets the agent search past conversations and tool
 * outputs for relevant context using keyword-based retrieval.
 */

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { retrieveRelevantContext, formatRetrievedContext } from "../lib/agent/context-retrieval.js";
import { getLocalUser } from "../lib/db.js";

export class SearchMemoryTool extends Tool {
  definition: ToolDefinition = {
    name: "search_memory",
    description: "Search past conversations and tool outputs for relevant context. Use when you need to recall previous work, decisions, or solutions from earlier sessions. Returns relevant snippets from conversation summaries and tool outputs.",
    category: "web",
    riskLevel: "none",
    requiresApproval: false,
    parameters: {
      query: {
        type: "string",
        description: "What to search for — describe the topic, technology, or problem",
        required: true
      },
      scope: {
        type: "string",
        description: "Search scope: 'workspace' (current workspace only) or 'all' (all conversations)",
        required: false
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 5)",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const query = params.query as string;
    if (!query || query.trim().length < 3) {
      return { success: false, error: "Query must be at least 3 characters." };
    }

    const scope = (params.scope as string) ?? "workspace";
    const limit = typeof params.limit === "number" ? Math.min(params.limit, 10) : 5;

    try {
      const user = await getLocalUser();
      const contexts = await retrieveRelevantContext({
        userId: user.id,
        query,
        workspaceId: scope === "workspace" ? context.workspaceRoot : undefined,
        excludeConversationId: context.conversationId,
        limit
      });

      if (contexts.length === 0) {
        return {
          success: true,
          output: "No relevant past context found for this query.",
          data: { query, resultCount: 0 }
        };
      }

      const formatted = formatRetrievedContext(contexts);
      return {
        success: true,
        output: formatted,
        data: { query, resultCount: contexts.length }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to search memory"
      };
    }
  }
}
