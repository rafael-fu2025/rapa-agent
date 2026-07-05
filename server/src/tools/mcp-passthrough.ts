// §3.1 — MCP tool passthrough in agent mode.
//
// Bridges registered MCP servers (via the `AgentMcpServer` Prisma table)
// into the agent's tool set. Rather than registering each MCP tool as
// a separate Tool class (which would require dynamic tool registration
// and conflict with the static tool registry), we expose:
//
//   - `mcp_list_servers`     — list user's MCP servers and their tools
//   - `mcp_call_tool`        — call a specific (server, tool) pair
//   - `getAgentMcpToolsForUser(userId)` — returns ToolDefinition[] that
//     can be merged into the agent's tool list. Each entry is a
//     "synthetic" tool definition (no Tool class); the agent's tool
//     orchestrator routes calls to these via the `mcp:` prefix in
//     allowedToolNames.
//
// This keeps the change additive: existing tools work unchanged.

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { prisma, getLocalUser } from "../lib/db.js";
import { Suggest } from "../lib/suggestions.js";
import {
  createMcpClientConnection,
  type McpServerConfig,
  type McpToolDescriptor
} from "../mcp/client.js";

const MAX_PARAMS_BYTES = 50_000;

function sanitizeToolName(raw: string): string {
  // Convert "MCP tool name" to a Rapa-friendly snake_case id.
  return raw.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64);
}

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
 * Build a ToolDefinition-shaped description of an MCP tool, prefixed
 * with `mcp_<sanitizedServerName>_`. The agent sees the tool with this
 * name; the orchestrator sees the `mcp:` prefix in allowedToolNames and
 * routes the call to `mcpCallToolByName` below.
 */
function mcpToolToDefinition(serverName: string, tool: McpToolDescriptor): ToolDefinition {
  const safeServer = sanitizeToolName(serverName);
  const safeTool = sanitizeToolName(tool.name);
  return {
    name: `mcp_${safeServer}__${safeTool}`,
    description: `[MCP:${serverName}] ${tool.description || tool.name}`,
    category: "system",
    riskLevel: "network",
    // The MCP tool's input schema is arbitrary JSON; we accept any object
    // and forward it as-is to the MCP server.
    parameters: {
      __mcpRaw: {
        type: "object",
        description: "Pass-through arguments for the MCP tool. See the MCP server's tool schema for the expected shape."
      }
    }
  };
}

export class McpListServersTool extends Tool {
  definition: ToolDefinition = {
    name: "mcp_list_servers",
    description: "List the user's configured MCP servers along with each server's exposed tools. Use this to discover what MCP capabilities are available before calling mcp_call_tool.",
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

    const servers: Array<{ name: string; transport: string; endpoint: string; tools: McpToolDescriptor[]; error?: string }> = [];

    for (const row of rows) {
      try {
        const conn = await createMcpClientConnection(mcpConfigFromRow(row));
        const tools = await conn.listTools();
        servers.push({
          name: row.name,
          transport: row.transport,
          endpoint: row.endpoint,
          tools
        });
        await conn.close();
      } catch (err) {
        servers.push({
          name: row.name,
          transport: row.transport,
          endpoint: row.endpoint,
          tools: [],
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    return { success: true, data: { servers, count: servers.length } };
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
        description: "Arguments to pass to the MCP tool. See the tool's inputSchema (from mcp_list_servers) for the expected shape.",
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

/**
 * Return a list of synthetic ToolDefinitions for every MCP tool the user
 * has registered. The agent's tool orchestrator can merge these into
 * its available set; when the LLM calls one, the orchestrator sees the
 * `mcp:` prefix in allowedToolNames and routes through `dispatchMcpCall`.
 */
export async function getAgentMcpToolsForUser(userId: string): Promise<ToolDefinition[]> {
  let rows;
  try {
    rows = await prisma.agentMcpServer.findMany({
      where: { userId, enabled: true }
    });
  } catch {
    return [];
  }
  const out: ToolDefinition[] = [];
  for (const row of rows) {
    let tools: McpToolDescriptor[];
    try {
      const conn = await createMcpClientConnection(mcpConfigFromRow(row));
      try {
        tools = await conn.listTools();
      } finally {
        await conn.close();
      }
    } catch {
      // Skip unreachable servers — the LLM can still call mcp_list_servers
      // to see they're offline.
      continue;
    }
    for (const t of tools) {
      out.push(mcpToolToDefinition(row.name, t));
    }
  }
  return out;
}
