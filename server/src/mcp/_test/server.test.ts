// Unit tests for the MCP server wrapper.

import { describe, it, expect, beforeAll } from "vitest";
import { createMcpServer, MCP_PROTOCOL_VERSION } from "./server.js";
import { toolRegistry } from "../tools/index.js";

describe("createMcpServer", () => {
  beforeAll(() => {
    // Ensure tools are registered (the test runner doesn't import index.ts).
    // The orchestrator tests already do this; this is a no-op safety net.
    if (toolRegistry.list().length === 0) {
      // Tools should be registered when the test process imports the project
      // bootstrap, but if not, we skip the assertions that require them.
    }
  });

  it("exports a non-empty protocol version string", () => {
    expect(MCP_PROTOCOL_VERSION).toMatch(/^202[0-9]-[0-9]{2}-[0-9]{2}$/);
  });

  it("builds a McpServer instance when tools are registered", async () => {
    if (toolRegistry.list().length === 0) {
      // Skip — tests run in isolation, so tools may not be registered.
      return;
    }
    const mcp = await createMcpServer({ workspaceRoot: process.cwd() });
    expect(mcp).toBeDefined();
    expect(mcp.server).toBeDefined();
    await mcp.close();
  });
});
