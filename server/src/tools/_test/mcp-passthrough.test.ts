// Tests for MCP context economy (Item 12): mcp_list_servers returns
// names + one-line descriptions only (no inputSchema blobs), and the new
// mcp_search_tools matches by keyword with capped, summarized schemas.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db.js", () => ({
  prisma: {
    agentMcpServer: {
      findMany: vi.fn(),
      findUnique: vi.fn()
    }
  },
  getLocalUser: vi.fn()
}));

vi.mock("../../mcp/client.js", () => ({
  createMcpClientConnection: vi.fn(),
  loadMcpToolsForUser: vi.fn()
}));

import { createMcpClientConnection, loadMcpToolsForUser } from "../../mcp/client.js";
import { getLocalUser, prisma } from "../../lib/db.js";
import {
  McpListServersTool,
  McpSearchToolsTool,
  summarizeToolArguments
} from "../mcp-passthrough.js";

const mockedConnection = vi.mocked(createMcpClientConnection);
const mockedLoadTools = vi.mocked(loadMcpToolsForUser);
const mockedGetLocalUser = vi.mocked(getLocalUser);
const mockedFindMany = vi.mocked(prisma.agentMcpServer.findMany);

const context = {
  workspaceRoot: "C:/tmp/ws",
  userId: "user-1",
  conversationId: "conv-1",
  mode: "agent" as const
};

function fakeConnection(tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> | "error") {
  return {
    listTools: async () => {
      if (tools === "error") throw new Error("server unreachable");
      return tools;
    },
    close: async () => {}
  } as never;
}

function schemaWithProperties(properties: Record<string, unknown>) {
  return { type: "object", properties, required: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetLocalUser.mockResolvedValue({ id: "user-1", email: "t@t" } as never);
});

describe("mcp_list_servers (trimmed payload)", () => {
  it("returns tool names + one-line descriptions only — no inputSchema blobs", async () => {
    mockedFindMany.mockResolvedValue([
      { id: "s1", name: "files", transport: "stdio", endpoint: "", enabled: true, config: null, authType: "none" }
    ] as never);
    mockedConnection.mockResolvedValue(fakeConnection([
      {
        name: "read_block",
        description: "Reads a block",
        inputSchema: schemaWithProperties({ path: { type: "string" }, offset: { type: "number" } })
      },
      {
        name: "write_block",
        description: "Writes a block",
        inputSchema: schemaWithProperties({ path: { type: "string" } })
      }
    ]));

    const result = await new McpListServersTool().execute({}, context);

    expect(result.success).toBe(true);
    const data = result.data as {
      servers: Array<{ name: string; toolCount: number; tools: Array<Record<string, unknown>>; error?: string }>;
      count: number;
      hint?: string;
    };
    expect(data.count).toBe(1);
    expect(data.servers[0].toolCount).toBe(2);
    expect(data.servers[0].tools).toEqual([
      { name: "read_block", description: "Reads a block" },
      { name: "write_block", description: "Writes a block" }
    ]);
    for (const tool of data.servers[0].tools) {
      expect("inputSchema" in tool).toBe(false);
      expect(Object.keys(tool).sort()).toEqual(["description", "name"]);
    }
    expect(data.hint).toContain("mcp_search_tools");
    expect(data.hint).toContain("mcp_call_tool");
  });

  it("reports unreachable servers with an error and omits the hint when no tools exist", async () => {
    mockedFindMany.mockResolvedValue([
      { id: "s1", name: "broken", transport: "stdio", endpoint: "", enabled: true, config: null, authType: "none" }
    ] as never);
    mockedConnection.mockResolvedValue(fakeConnection("error"));

    const result = await new McpListServersTool().execute({}, context);

    const data = result.data as {
      servers: Array<{ name: string; toolCount: number; error?: string }>;
      hint?: string;
    };
    expect(data.servers[0].error).toContain("server unreachable");
    expect(data.servers[0].toolCount).toBe(0);
    expect(data.hint).toBeUndefined();
  });
});

describe("summarizeToolArguments", () => {
  it("renders top-level properties as a name:type list", () => {
    const summary = summarizeToolArguments(schemaWithProperties({
      path: { type: "string" },
      limit: { type: "number" },
      recursive: { type: "boolean" }
    }));
    expect(summary).toBe("path:string, limit:number, recursive:boolean");
  });

  it("falls back to 'any' for properties without a type and to '' without properties", () => {
    expect(summarizeToolArguments(schemaWithProperties({ weird: { description: "no type" } }))).toBe("weird:any");
    expect(summarizeToolArguments({ type: "object" })).toBe("");
    expect(summarizeToolArguments(null)).toBe("");
    expect(summarizeToolArguments("not an object")).toBe("");
  });

  it("caps the summary at 500 characters", () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 120; i += 1) {
      properties[`veryLongPropertyName${i}`] = { type: "string", description: "x" };
    }
    const summary = summarizeToolArguments(schemaWithProperties(properties));
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("mcp_search_tools", () => {
  const servers = [
    {
      serverName: "files",
      tools: [
        { name: "read_block", description: "Reads a block of text", inputSchema: schemaWithProperties({ path: { type: "string" } }) },
        { name: "write_block", description: "Writes a block of text", inputSchema: schemaWithProperties({ path: { type: "string" }, content: { type: "string" } }) }
      ]
    },
    {
      serverName: "search",
      tools: [
        { name: "web_query", description: "Runs a web search query", inputSchema: schemaWithProperties({ q: { type: "string" } }) }
      ]
    }
  ];

  it("matches tool names and descriptions case-insensitively across servers", async () => {
    mockedLoadTools.mockResolvedValue(servers);

    const byName = await new McpSearchToolsTool().execute({ query: "READ_BLOCK" }, context);
    const byDescription = await new McpSearchToolsTool().execute({ query: "web search" }, context);

    const nameData = byName.data as { matches: Array<{ server: string; name: string; arguments: string }>; count: number };
    expect(nameData.count).toBe(1);
    expect(nameData.matches[0]).toMatchObject({ server: "files", name: "read_block", arguments: "path:string" });

    const descData = byDescription.data as { matches: Array<{ name: string }>; count: number };
    expect(descData.count).toBe(1);
    expect(descData.matches[0].name).toBe("web_query");
  });

  it("returns a friendly message when no MCP servers are configured", async () => {
    mockedLoadTools.mockResolvedValue([]);

    const result = await new McpSearchToolsTool().execute({ query: "anything" }, context);

    const data = result.data as { matches: unknown[]; count: number; message?: string };
    expect(result.success).toBe(true);
    expect(data.matches).toEqual([]);
    expect(data.message).toContain("No MCP servers are configured");
  });

  it("caps results at 20 matches and flags truncation", async () => {
    const many: typeof servers = [
      {
        serverName: "files",
        tools: Array.from({ length: 25 }, (_, i) => ({
          name: `block_tool_${i}`,
          description: "Matches the query",
          inputSchema: schemaWithProperties({ path: { type: "string" } })
        }))
      }
    ];
    mockedLoadTools.mockResolvedValue(many);

    const result = await new McpSearchToolsTool().execute({ query: "query" }, context);

    const data = result.data as { matches: unknown[]; count: number; returned: number; truncated?: boolean };
    expect(data.count).toBe(25);
    expect(data.returned).toBe(20);
    expect(data.matches).toHaveLength(20);
    expect(data.truncated).toBe(true);
  });

  it("rejects a missing or oversized query", async () => {
    const noQuery = await new McpSearchToolsTool().execute({}, context);
    expect(noQuery.success).toBe(false);
    expect(noQuery.error).toContain("query is required");

    const tooLong = await new McpSearchToolsTool().execute({ query: "q".repeat(201) }, context);
    expect(tooLong.success).toBe(false);
    expect(tooLong.error).toContain("at most 200");
  });
});
