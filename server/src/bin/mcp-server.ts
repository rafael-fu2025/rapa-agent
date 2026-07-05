#!/usr/bin/env node
// MCP server entry point — stdio transport.
//
// Usage (from an MCP client config):
//   {
//     "mcpServers": {
//       "rapa": {
//         "command": "node",
//         "args": ["path/to/recreate-ui/server/dist/bin/mcp-server.js"]
//       }
//     }
//   }
//
// Or, for development:
//   npx tsx server/src/bin/mcp-server.ts

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "../tools/index.js";
import { createMcpServer, MCP_PROTOCOL_VERSION } from "../mcp/server.js";

async function main() {
  registerAllTools();
  const workspaceRoot = process.env.RAPA_WORKSPACE_ROOT ?? process.cwd();
  const mcp = await createMcpServer({ workspaceRoot });
  const transport = new StdioServerTransport();
  // eslint-disable-next-line no-console
  console.error(`[rapa-mcp] starting stdio transport, workspace=${workspaceRoot}, protocol=${MCP_PROTOCOL_VERSION}`);
  await mcp.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[rapa-mcp] fatal:", err);
  process.exit(1);
});
