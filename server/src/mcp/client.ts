// MCP client (research P2-B, MCP spec 2025-11-25).
//
// Connects to external MCP servers (stdio, HTTP+SSE, or streamable HTTP)
// and exposes their `tools/list` and `tools/call` capabilities to Rapa.
//
// Used by:
//   - The `AgentMcpServer` admin page — operators register external servers
//     and Rapa's agent can call their tools.
//   - The agent loop — if a remote MCP server is registered, its tools are
//     merged into the tool list and called just like local tools.
//
// Lifecycle:
//   - `createMcpClientConnection(serverConfig)` returns a `McpConnection`
//     with `listTools()` and `callTool()`. The caller is responsible for
//     calling `close()` when the connection is no longer needed.
//   - Connections are cached per server id; reusing an existing connection
//     avoids the cost of spawning a new child process or HTTP handshake on
//     every tool call.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import { prisma } from "../lib/db.js";
import { getLocalUser } from "../lib/db.js";
import { z } from "zod";

const CLIENT_INFO: Implementation = {
  name: "rapa-agent",
  version: "0.1.0"
};

const TOOL_CALL_TIMEOUT_MS = 60_000;

export type McpServerConfig = {
  id: string;
  name: string;
  /** Transport type — stdio spawns a child process, the others use HTTP. */
  transport: "stdio" | "sse" | "streamableHttp";
  /** For stdio: command + args. For HTTP: the base URL. */
  command?: string;
  args?: string[];
  /** For stdio: env vars to set. */
  env?: Record<string, string>;
  /** For HTTP: optional headers (e.g. Authorization). */
  headers?: Record<string, string>;
  /** Auto-connect on server boot. */
  autoConnect?: boolean;
};

export type McpToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpToolCallResult = {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
};

const mcpServerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: z.enum(["stdio", "sse", "streamableHttp"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  autoConnect: z.boolean().optional()
});

export class McpConnection {
  private client: Client;
  private transport: Transport;
  private closed = false;
  private cache: { tools: McpToolDescriptor[] } | null = null;

  constructor(private readonly config: McpServerConfig, client: Client, transport: Transport) {
    this.client = client;
    this.transport = transport;
  }

  getId(): string {
    return this.config.id;
  }

  getName(): string {
    return this.config.name;
  }

  async listTools(force = false): Promise<McpToolDescriptor[]> {
    if (this.closed) throw new Error(`MCP connection ${this.config.id} is closed`);
    if (!force && this.cache) return this.cache.tools;
    const result = await this.client.listTools();
    const tools: McpToolDescriptor[] = (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>
    }));
    this.cache = { tools };
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (this.closed) throw new Error(`MCP connection ${this.config.id} is closed`);
    const call = this.client.callTool({ name, arguments: args });
    const result = await Promise.race([
      call,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`MCP tool call ${name} timed out after ${TOOL_CALL_TIMEOUT_MS}ms`)), TOOL_CALL_TIMEOUT_MS)
      )
    ]);
    const content = Array.isArray((result as { content?: unknown[] }).content)
      ? ((result as { content: Array<{ type: string; text: string }> }).content)
      : [];
    return {
      content: content.map((c) => ({ type: c.type ?? "text", text: c.text ?? "" })),
      isError: Boolean((result as { isError?: boolean }).isError)
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.close();
    } catch {
      // Ignore.
    }
    try {
      await this.transport.close();
    } catch {
      // Ignore.
    }
  }
}

export class McpConnectionError extends Error {
  constructor(message: string, public readonly serverId: string) {
    super(message);
    this.name = "McpConnectionError";
  }
}

function buildTransport(config: McpServerConfig): Transport {
  if (config.transport === "stdio") {
    if (!config.command) {
      throw new McpConnectionError("stdio transport requires a `command`", config.id);
    }
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>
    });
  }
  if (config.transport === "sse") {
    if (!config.command) {
      throw new McpConnectionError("sse transport requires a `url` (passed as `command`)", config.id);
    }
    return new SSEClientTransport(new URL(config.command), {
      requestInit: { headers: config.headers }
    });
  }
  if (config.transport === "streamableHttp") {
    if (!config.command) {
      throw new McpConnectionError("streamableHttp transport requires a `url` (passed as `command`)", config.id);
    }
    return new StreamableHTTPClientTransport(new URL(config.command), {
      requestInit: { headers: config.headers }
    });
  }
  throw new McpConnectionError(`Unknown transport: ${String(config.transport)}`, config.id);
}

/**
 * Open a new MCP client connection to the given server. The caller is
 * responsible for closing the connection when it's no longer needed.
 */
export async function createMcpClientConnection(config: McpServerConfig): Promise<McpConnection> {
  const parsed = mcpServerConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new McpConnectionError(
      `Invalid MCP server config: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      config.id
    );
  }
  const transport = buildTransport(parsed.data);
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  await client.connect(transport);
  return new McpConnection(parsed.data, client, transport);
}

const connectionCache = new Map<string, McpConnection>();

/**
 * Get (or create) a cached MCP connection for a server. Closes any existing
 * connection for the same id first.
 */
export async function getOrCreateMcpConnection(config: McpServerConfig): Promise<McpConnection> {
  const existing = connectionCache.get(config.id);
  if (existing) {
    try {
      await existing.listTools();
      return existing;
    } catch {
      await existing.close();
      connectionCache.delete(config.id);
    }
  }
  const conn = await createMcpClientConnection(config);
  connectionCache.set(config.id, conn);
  return conn;
}

export async function closeAllMcpConnections(): Promise<void> {
  const connections = Array.from(connectionCache.values());
  connectionCache.clear();
  await Promise.allSettled(connections.map((c) => c.close()));
}

/**
 * Load all enabled MCP server configs from the DB and return a merged
 * list of their tools. Used by the agent loop to extend the tool registry
 * with remote capabilities.
 */
export async function loadMcpToolsForUser(userId: string): Promise<{
  serverName: string;
  tools: McpToolDescriptor[];
  error?: string;
}[]> {
  const servers = await prisma.agentMcpServer.findMany({
    where: { userId, enabled: true }
  });
  if (servers.length === 0) return [];
  const out: { serverName: string; tools: McpToolDescriptor[]; error?: string }[] = [];
  for (const server of servers) {
    const config: McpServerConfig = {
      id: server.id,
      name: server.name,
      transport: (server.transport as McpServerConfig["transport"]) ?? "stdio",
      command: (server.config as { command?: string } | null)?.command,
      args: (server.config as { args?: string[] } | null)?.args,
      env: (server.config as { env?: Record<string, string> } | null)?.env,
      headers: (server.config as { headers?: Record<string, string> } | null)?.headers
    };
    try {
      const conn = await getOrCreateMcpConnection(config);
      const tools = await conn.listTools();
      out.push({ serverName: server.name, tools });
    } catch (err) {
      out.push({ serverName: server.name, tools: [], error: (err as Error).message });
    }
  }
  return out;
}

/** Convenience: list MCP servers for the local user, including disabled ones. */
export async function listUserMcpServers() {
  const user = await getLocalUser();
  return prisma.agentMcpServer.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" }
  });
}
