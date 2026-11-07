// §3.1 — MCP tool passthrough in agent mode.
//
// Bridges registered MCP servers (via the `AgentMcpServer` Prisma table)
// into the agent's tool set. Rather than registering each MCP tool as
// a separate Tool class (which would require dynamic tool registration
// and conflict with the static tool registry), we expose:
//
//   - `mcp_list_servers`     — list user's MCP servers and their tools
//     (names + one-line descriptions only — full JSON schemas would burn
//     the model's context; use `mcp_search_tools` to look up argument
//     summaries by keyword)
//   - `mcp_search_tools`     — keyword search across servers' tools,
//     returning `name:type` argument summaries (capped) so the model
//     learns how to call without ingesting full schemas
//   - `mcp_call_tool`        — call a specific (server, tool) pair
// Tools are discovered lazily: `mcp_search_tools` finds tools by
// keyword and `mcp_call_tool` executes them, so full tool schemas never
// enter the model's context.

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { prisma, getLocalUser } from "../lib/db.js";
import { Suggest } from "../lib/suggestions.js";
import {
  createMcpClientConnection,
  loadMcpToolsForUser,
  type McpServerConfig
} from "../mcp/client.js";

const MAX_PARAMS_BYTES = 50_000;
// Item 12 — context-economy caps for the discovery tools.
const MCP_SCHEMA_SUMMARY_CHARS = 500;
const MCP_QUERY_MAX_CHARS = 200;
const MCP_SEARCH_MATCH_LIMIT = 20;

function mcpConfigFromRow(row: {
  id: string;
  name: string;
  endpoint: string;
  transport: string;
  config: unknown;
  authType: string;
}): McpServerConfig {
  const config = (row.config as Record<string, unknown> | null) ?? {};
  return {
    id: row.id,
    name: row.name,
    transport: (row.transport === "stdio" || row.transport === "sse" || row.transport === "streamableHttp"
      ? row.transport
      : "streamableHttp") as McpServerConfig["transport"],
    ...(typeof config.command === "string" ? { command: config.command } : {}),
    ...(Array.isArray(config.args) ? { args: config.args as string[] } : {}),
    ...(typeof config.env === "object" && config.env !== null ? { env: config.env as Record<string, string> } : {}),
    ...(typeof config.headers === "object" && config.headers !== null ? { headers: config.headers as Record<string, string> } : {}),
    ...(row.endpoint ? { endpoint: row.endpoint } : {})
  };
}


/**
 * Render the top-level properties of an MCP tool's input schema as a
 * compact `name:type` list, capped so a sprawling schema cannot blow up
 * the tool result. Enough for the model to construct a call; full detail
 * stays on the MCP server.
 */
export function summarizeToolArguments(inputSchema: unknown): string {
  const properties = inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)
    ? (inputSchema as { properties?: unknown }).properties
    : undefined;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return "";
  const parts = Object.entries(properties as Record<string, unknown>).map(([name, spec]) => {
    const type = spec && typeof spec === "object" && !Array.isArray(spec) && typeof (spec as { type?: unknown }).type === "string"
      ? (spec as { type: string }).type
      : "any";
    return `${name}:${type}`;
  });
  const summary = parts.join(", ");
  return summary.length > MCP_SCHEMA_SUMMARY_CHARS
    ? `${summary.slice(0, MCP_SCHEMA_SUMMARY_CHARS - 1)}…`
    : summary;
}

export class McpListServersTool extends Tool {
  definition: ToolDefinition = {
    name: "mcp_list_servers",
    description: "List the user's configured MCP servers along with each server's exposed tools (names and one-line descriptions). Use this to discover what MCP capabilities are available; use mcp_search_tools to find tools by keyword and mcp_call_tool to invoke them.",
    category: "system",
    riskLevel: "read",
    parameters: {
      serverName: {
        type: "string",
        description: "Optional filter — only return tools for this server name",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    const user = await getLocalUser();
    const filter = typeof params.serverName === "string" ? params.serverName.trim() : undefined;

    const rows = await prisma.agentMcpServer.findMany({
      where: { userId: user.id, enabled: true, ...(filter ? { name: filter } : {}) }
    });

    // Item 12 — context economy: names + one-line descriptions only. The
    // full inputSchema JSON used to ride on every listing and could consume
    // a large share of the model's context window for a single discovery call.
    const servers: Array<{ name: string; transport: string; endpoint: string; toolCount: number; tools: Array<{ name: string; description: string }>; error?: string }> = [];

    for (const row of rows) {
      try {
        const conn = await createMcpClientConnection(mcpConfigFromRow(row));
        const tools = await conn.listTools();
        servers.push({
          name: row.name,
          transport: row.transport,
          endpoint: row.endpoint,
          toolCount: tools.length,
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description || ""
          }))
        });
        await conn.close();
      } catch (err) {
        servers.push({
          name: row.name,
          transport: row.transport,
          endpoint: row.endpoint,
          toolCount: 0,
          tools: [],
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const hasTools = servers.some((server) => server.toolCount > 0);
    return {
      success: true,
      data: {
        servers,
        count: servers.length,
        ...(hasTools ? { hint: "use mcp_search_tools to find tools by keyword; call them via mcp_call_tool" } : {})
      }
    };
  }
}

export class McpSearchToolsTool extends Tool {
  definition: ToolDefinition = {
    name: "mcp_search_tools",
    description: "Search the user's configured MCP servers for tools matching a keyword (matches tool names and descriptions). Returns each match with an argument summary (name:type list) so you can call it via mcp_call_tool without fetching full JSON schemas.",
    category: "system",
    riskLevel: "read",
    parameters: {
      query: {
        type: "string",
        description: "Case-insensitive keyword to match against MCP tool names and descriptions (1-200 chars)",
        required: true
      }
    }
  };

  async execute(params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    const query = typeof params.query === "string" ? params.query.trim() : "";
    if (!query) {
      return { success: false, error: "query is required" };
    }
    if (query.length > MCP_QUERY_MAX_CHARS) {
      return { success: false, error: `query must be at most ${MCP_QUERY_MAX_CHARS} characters` };
    }

    const user = await getLocalUser();
    const servers = await loadMcpToolsForUser(user.id);
    if (servers.length === 0) {
      return {
        success: true,
        data: {
          query,
          matches: [],
          count: 0,
          message: "No MCP servers are configured. Register one via Settings → MCP Servers, or use mcp_list_servers to see what's available."
        }
      };
    }

    const needle = query.toLowerCase();
    const matches: Array<{ server: string; name: string; description: string; arguments: string }> = [];
    let total = 0;
    for (const server of servers) {
      for (const tool of server.tools) {
        const name = tool.name ?? "";
        const description = tool.description ?? "";
        if (!name.toLowerCase().includes(needle) && !description.toLowerCase().includes(needle)) continue;
        total += 1;
        if (matches.length < MCP_SEARCH_MATCH_LIMIT) {
          matches.push({
            server: server.serverName,
            name,
            description,
            arguments: summarizeToolArguments(tool.inputSchema)
          });
        }
      }
    }

    return {
      success: true,
      data: {
        query,
        matches,
        count: total,
        returned: matches.length,
        ...(total > matches.length ? { truncated: true } : {})
      }
    };
  }
}

export class McpCallTool extends Tool {
  definition: ToolDefinition = {
    name: "mcp_call_tool",
    description: "Call a tool exposed by a registered MCP server. Use mcp_list_servers to discover available (server, tool) pairs.",
    category: "system",
    riskLevel: "network",
    requiresApproval: true,
    parameters: {
      server: {
        type: "string",
        description: "Name of the MCP server",
        required: true
      },
      tool: {
        type: "string",
        description: "Name of the tool on the MCP server",
        required: true
      },
      arguments: {
        type: "object",
        description: "Arguments to pass to the MCP tool. Use mcp_search_tools to look up the tool's argument summary (name:type list) for the expected shape.",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    const serverName = typeof params.server === "string" ? params.server.trim() : "";
    const toolName = typeof params.tool === "string" ? params.tool.trim() : "";
    const args = params.arguments;

    if (!serverName) return { success: false, error: "server is required" };
    if (!toolName) return { success: false, error: "tool is required" };

    const argsJson = args !== undefined ? JSON.stringify(args) : "{}";
    if (argsJson.length > MAX_PARAMS_BYTES) {
      return {
        success: false,
        error: `arguments exceed ${MAX_PARAMS_BYTES} bytes when serialized (got ${argsJson.length})`
      };
    }

    const user = await getLocalUser();
    const row = await prisma.agentMcpServer.findUnique({
      where: { userId_name: { userId: user.id, name: serverName } }
    });
    if (!row || !row.enabled) {
      return Suggest.generic(
        { success: false, error: `MCP server "${serverName}" is not configured or is disabled` },
        "Use mcp_list_servers to see the configured servers, or register a new one via Settings → MCP Servers."
      );
    }

    let result;
    try {
      const conn = await createMcpClientConnection(mcpConfigFromRow(row));
      try {
        result = await conn.callTool(toolName, args && typeof args === "object" ? (args as Record<string, unknown>) : {});
      } finally {
        await conn.close();
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : `MCP call to ${serverName}/${toolName} failed`
      };
    }

    return {
      success: !result.isError,
      data: {
        server: serverName,
        tool: toolName,
        content: result.content,
        isError: result.isError
      },
      ...(result.isError ? { error: typeof result.content[0]?.text === "string" ? result.content[0].text : "MCP tool returned an error" } : {})
    };
  }
}

