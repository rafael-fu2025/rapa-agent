// MCP routes (research P2-B).
//
// Exposes Rapa's tools as an MCP server over HTTP (Streamable HTTP transport
// is the modern default per MCP spec 2025-11-25). External MCP clients can
// POST JSON-RPC requests to `/api/mcp/serve` and connect to remote MCP
// servers via `/api/mcp/remote/*`.
//
// The /serve endpoint is transport-agnostic — it accepts Streamable HTTP
// requests and returns Streamable HTTP responses. Legacy SSE clients should
// be upgraded by their operator; we keep the SSE fallback for the next
// 6 months while the spec stabilises.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getLocalUser, prisma } from "../lib/db.js";
import { createMcpServer, MCP_PROTOCOL_VERSION } from "../mcp/server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createMcpClientConnection,
  getOrCreateMcpConnection,
  loadMcpToolsForUser,
  type McpServerConfig
} from "../mcp/client.js";
import { randomUUID } from "node:crypto";

const REMOTE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const remoteCallSchema = z.object({
  serverName: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.record(z.unknown()).default({})
});

const remoteConfigSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(["stdio", "sse", "streamableHttp"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  autoConnect: z.boolean().optional()
});

/**
 * Compute the active workspace root for a user (or fall back to cwd).
 * Used to scope the MCP server's filesystem tools.
 */
async function resolveWorkspaceRoot(userId: string, workspaceId: string | undefined): Promise<string> {
  if (workspaceId) {
    const ws = await prisma.workspace.findFirst({
      where: { id: workspaceId, userId }
    });
    if (ws) return ws.path;
  }
  return process.env.DEFAULT_WORKSPACE_ROOT ?? process.cwd();
}

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {

  // ---- Streamable HTTP transport endpoint -------------------------------
  // The MCP SDK is transport-agnostic — we instantiate a fresh server
  // per request to keep things stateless. (Stateful session support can
  // be added later via the `mcp-session-id` header.)
  app.post("/mcp/serve", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await getLocalUser();
    const workspaceRoot = await resolveWorkspaceRoot(user.id, undefined);
    const mcp = await createMcpServer({ workspaceRoot });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        // Stash transport for future DELETE/GET requests if needed.
        // For now we keep things stateless — the SDK accepts the request
        // and the transport is closed when the response ends.
        app.log.debug({ sessionId }, "MCP session initialized");
      }
    });

    reply.header("Mcp-Session-Id", transport.sessionId ?? "");
    reply.header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);

    await mcp.connect(transport);
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      // Transport closes itself when the response ends. Just disconnect
      // the server to release resources.
      await mcp.close().catch(() => undefined);
    }
    return reply;
  });

  // Discovery: what tools would Rapa expose to an MCP client?
  app.get("/mcp/tools", async (request, reply) => {
    const querySchema = z.object({ workspaceId: z.string().optional() });
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid query", issues: parsed.error.issues });
    }
    const user = await getLocalUser();
    const workspaceRoot = await resolveWorkspaceRoot(user.id, parsed.data.workspaceId);
    const mcp = await createMcpServer({ workspaceRoot });
    // The MCP SDK doesn't expose a public "list tools" method on McpServer,
    // so we use the underlying Server instance's registered tools via a
    // listTools call. For simplicity we hand-roll a snapshot of what the
    // registry advertises — this is what tools/list would return.
    const { toolRegistry } = await import("../tools/index.js");
    const tools = toolRegistry.list().map((t) => ({
      name: t.name,
      description: t.description,
      category: t.category,
      riskLevel: t.riskLevel,
      requiresApproval: t.requiresApproval,
      parameters: t.parameters
    }));
    await mcp.close().catch(() => undefined);
    return {
      serverInfo: { name: "rapa-agent", version: "0.1.0" },
      protocolVersion: MCP_PROTOCOL_VERSION,
      toolCount: tools.length,
      tools
    };
  });

  // ---- Remote MCP server management ------------------------------------
  app.get("/mcp/remote/servers", async () => {
    const user = await getLocalUser();
    const servers = await prisma.agentMcpServer.findMany({
      where: { userId: user.id },
      orderBy: [{ enabled: "desc" }, { updatedAt: "desc" }]
    });
    return { servers };
  });

  app.post("/mcp/remote/connect", async (request, reply) => {
    const parsed = remoteConfigSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }
    const user = await getLocalUser();
    const data = parsed.data;
    if (!REMOTE_ID_PATTERN.test(data.name)) {
      return reply.code(400).send({ message: "Server name must match [a-zA-Z0-9_-]{1,64}" });
    }

    // Persist server config to DB (idempotent on name).
    const config: McpServerConfig = {
      id: data.name,
      name: data.name,
      transport: data.transport,
      command: data.command,
      args: data.args,
      env: data.env,
      headers: data.headers,
      autoConnect: data.autoConnect
    };
    const server = await prisma.agentMcpServer.upsert({
      where: { id: `mcp-${user.id}-${data.name}` },
      create: {
        id: `mcp-${user.id}-${data.name}`,
        userId: user.id,
        name: data.name,
        endpoint: data.command ?? "",
        transport: data.transport,
        enabled: data.autoConnect !== false,
        config: config as never
      },
      update: {
        endpoint: data.command ?? "",
        transport: data.transport,
        enabled: data.autoConnect !== false,
        config: config as never
      }
    });

    // Try to connect and list tools so the user can verify.
    try {
      const conn = await getOrCreateMcpConnection(config);
      const tools = await conn.listTools(true);
      return { server, connected: true, toolCount: tools.length, tools: tools.map((t) => t.name) };
    } catch (err) {
      return reply.code(502).send({
        server,
        connected: false,
        error: (err as Error).message
      });
    }
  });

  app.post("/mcp/remote/list-tools", async (request, reply) => {
    const schema = z.object({ serverName: z.string().min(1) });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }
    const user = await getLocalUser();
    const server = await prisma.agentMcpServer.findFirst({
      where: { userId: user.id, name: parsed.data.serverName }
    });
    if (!server) return reply.code(404).send({ message: "MCP server not found" });
    const config = server.config as unknown as McpServerConfig;
    try {
      const conn = await getOrCreateMcpConnection(config);
      const tools = await conn.listTools(true);
      return { server: server.name, tools };
    } catch (err) {
      return reply.code(502).send({ message: (err as Error).message });
    }
  });

  app.post("/mcp/remote/call", async (request, reply) => {
    const parsed = remoteCallSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }
    const user = await getLocalUser();
    const server = await prisma.agentMcpServer.findFirst({
      where: { userId: user.id, name: parsed.data.serverName }
    });
    if (!server) return reply.code(404).send({ message: "MCP server not found" });
    const config = server.config as unknown as McpServerConfig;
    try {
      const conn = await getOrCreateMcpConnection(config);
      const result = await conn.callTool(parsed.data.tool, parsed.data.arguments);
      return { server: server.name, tool: parsed.data.tool, result };
    } catch (err) {
      return reply.code(502).send({ message: (err as Error).message });
    }
  });

  app.post("/mcp/remote/disconnect", async (request, reply) => {
    const schema = z.object({ serverName: z.string().min(1) });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }
    const user = await getLocalUser();
    const server = await prisma.agentMcpServer.findFirst({
      where: { userId: user.id, name: parsed.data.serverName }
    });
    if (!server) return reply.code(404).send({ message: "MCP server not found" });
    await prisma.agentMcpServer.update({
      where: { id: server.id },
      data: { enabled: false }
    });
    const { closeAllMcpConnections } = await import("../mcp/client.js");
    await closeAllMcpConnections();
    return { ok: true, server: server.name };
  });

  // Aggregate all remote tools for the current user — used by the agent
  // loop to extend the tool registry.
  app.get("/mcp/remote/aggregate", async () => {
    const user = await getLocalUser();
    const servers = await loadMcpToolsForUser(user.id);
    return { servers };
  });
}
