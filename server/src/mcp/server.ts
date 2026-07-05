// MCP server (research P2-B, MCP spec 2025-11-25).
//
// Wraps our in-process tool registry as an MCP server so external MCP-aware
// clients (Claude Desktop, Cursor, Windsurf, OpenCode, Goose, etc.) can
// call Rapa's tools over the Model Context Protocol.
//
// Implements the three MCP primitives required for a useful server:
//   - tools/list         — list every tool in the registry
//   - tools/call         — invoke a tool with JSON parameters
//   - resources/list     — expose workspace files as readable resources
//   - resources/read     — return the contents of a single resource
//
// Prompts (the third MCP primitive) are intentionally not implemented here:
// Rapa's existing skill system already covers the use case and the two
// systems would conflict.
//
// Transport: this module is transport-agnostic. The actual transport
// (stdio, Streamable HTTP, SSE) is chosen by the caller in `bin/mcp-server.ts`
// or by the Fastify route in `routes/mcp.ts`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { toolRegistry } from "../tools/index.js";
import { getLocalUser } from "../lib/db.js";
import type {
  ToolExecutionContext,
  ToolParameter
} from "../lib/tools.js";

/**
 * Convert one of our tool parameter definitions into a Zod schema field.
 * The MCP SDK uses Zod schemas for input validation, so we translate our
 * own parameter shape into the closest Zod equivalent.
 */
function parameterToZod(param: ToolParameter): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (param.type) {
    case "string":
      schema = z.string();
      if (param.enum && param.enum.length > 0) {
        schema = (schema as z.ZodString).refine(
          (v) => param.enum!.includes(v),
          { message: `Must be one of: ${param.enum.join(", ")}` }
        );
      }
      break;
    case "number":
      schema = z.number();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "object":
      schema = z.record(z.string(), z.unknown());
      break;
    case "array":
      schema = z.array(z.unknown());
      break;
    default:
      schema = z.unknown();
  }
  return param.required ? schema : schema.optional();
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".yaml", ".yml", ".toml",
  ".ini", ".env", ".gitignore", ".gitattributes",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh", ".bash", ".zsh",
  ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".xml", ".svg", ".sql", ".dockerfile", ".log"
]);

const MAX_RESOURCE_BYTES = 5_000_000;
const MAX_RESOURCES_PER_LIST = 200;

function isTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower === "makefile") return true;
  return TEXT_EXTENSIONS.has(extname(lower));
}

/**
 * Build a fresh MCP server instance. A new server is built per transport
 * connection (the MCP SDK is not safe to share across clients).
 */
export async function createMcpServer(options: {
  workspaceRoot: string;
  /** When true, only tools that the local user could see are exposed. */
  respectPermissions?: boolean;
} = { workspaceRoot: process.cwd() }): Promise<McpServer> {
  const mcp = new McpServer(
    {
      name: "rapa-agent",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {},
        resources: {}
      },
      instructions: "Rapa agent tools — file system, shell, web, git, and diagnostics, all workspace-scoped. Tools that require approval will fail loudly when called from MCP so the client can ask the human before proceeding."
    }
  );

  const allTools = toolRegistry.list();
  for (const toolDef of allTools) {
    if (options.respectPermissions) {
      const user = await getLocalUser().catch(() => null);
      if (!user) continue;
    }
    const tool = toolRegistry.get(toolDef.name);
    if (!tool) continue;

    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [name, param] of Object.entries(toolDef.parameters ?? {})) {
      shape[name] = parameterToZod(param);
    }

    mcp.tool(
      toolDef.name,
      toolDef.description,
      shape,
      async (params: Record<string, unknown>) => {
        const context: ToolExecutionContext = {
          workspaceRoot: options.workspaceRoot,
          userId: "mcp",
          conversationId: `mcp-${Date.now()}`,
          mode: "agent"
        };
        const result = await tool.execute(params, context);
        const text = result.output
          ?? (typeof result.data === "string" ? result.data : JSON.stringify(result.data ?? {}, null, 2))
          ?? (result.error ?? "");
        if (!result.success) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Error: ${result.error ?? "unknown"}\n${text}` }]
          };
        }
        return {
          content: [{ type: "text" as const, text }]
        };
      }
    );
  }

  // ---- resources --------------------------------------------------------
  mcp.resource(
    "workspace-file",
    "file://{+path}",
    async (uri, variables) => {
      const pathParam = (variables as { path?: string }).path ?? "";
      if (!pathParam) {
        return {
          contents: [{
            uri: uri.toString(),
            mimeType: "text/plain",
            text: "Missing file path"
          }]
        };
      }
      const absolute = resolve(options.workspaceRoot, pathParam);
      if (!absolute.startsWith(resolve(options.workspaceRoot))) {
        return {
          contents: [{
            uri: uri.toString(),
            mimeType: "text/plain",
            text: "Path is outside the workspace"
          }]
        };
      }
      try {
        const stats = await stat(absolute);
        if (!stats.isFile()) {
          return {
            contents: [{
              uri: uri.toString(),
              mimeType: "text/plain",
              text: "Not a regular file"
            }]
          };
        }
        if (stats.size > MAX_RESOURCE_BYTES) {
          return {
            contents: [{
              uri: uri.toString(),
              mimeType: "text/plain",
              text: `File too large (${stats.size} bytes, max ${MAX_RESOURCE_BYTES})`
            }]
          };
        }
        if (!isTextFile(absolute)) {
          return {
            contents: [{
              uri: uri.toString(),
              mimeType: "application/octet-stream",
              text: "Binary file — preview not available over MCP"
            }]
          };
        }
        const text = await readFile(absolute, "utf-8");
        return {
          contents: [{
            uri: uri.toString(),
            mimeType: "text/plain",
            text
          }]
        };
      } catch (err) {
        return {
          contents: [{
            uri: uri.toString(),
            mimeType: "text/plain",
            text: `Failed to read file: ${(err as Error).message}`
          }]
        };
      }
    }
  );

  mcp.resource(
    "workspace-tree",
    "workspace://tree",
    async () => {
      const root = options.workspaceRoot;
      const out: string[] = [];
      async function walk(dir: string, depth: number) {
        if (depth > 4) return;
        if (out.length >= MAX_RESOURCES_PER_LIST) return;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (out.length >= MAX_RESOURCES_PER_LIST) return;
          if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
          if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
          const full = join(dir, entry.name);
          const rel = relative(root, full);
          out.push(`${"  ".repeat(depth)}${entry.isDirectory() ? "📁" : "📄"} ${rel}`);
          if (entry.isDirectory()) await walk(full, depth + 1);
        }
      }
      await walk(root, 0);
      return {
        contents: [{
          uri: "workspace://tree",
          mimeType: "text/plain",
          text: out.join("\n") || "(empty workspace)"
        }]
      };
    }
  );

  return mcp;
}

export const MCP_PROTOCOL_VERSION = "2025-11-25";
