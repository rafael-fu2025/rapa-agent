// §4.2 — present_file tool.
//
// Surfaces one or more workspace files as structured "presentation cards"
// that the frontend renders with action buttons (open, copy path, etc.).
// The tool result is enriched with metadata (size, mtime, type) and a
// `presentedFiles` array that the frontend agent-steps-viewer looks for.
//
// This avoids the model having to describe a file in prose. Instead the
// tool returns a structured envelope the UI knows how to render.

import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { containsPathTraversal, isWithinWorkspace, resolveWorkspacePath, toWorkspaceRelativePath } from "./filesystem.js";

export type PresentedFile = {
  /** Workspace-relative path. */
  path: string;
  /** Absolute path on disk. */
  fullPath: string;
  /** File name without directory. */
  name: string;
  /** File extension, lower-case, including the leading dot. */
  ext: string;
  /** File size in bytes. */
  size: number;
  /** Last-modified time, ISO 8601. */
  mtime: string;
  /** True if `path` points to a directory. */
  isDirectory: boolean;
  /** Optional human-readable label provided by the agent. */
  label?: string;
  /** Optional one-line description provided by the agent. */
  description?: string;
};

const ARCHIVE_EXTS = new Set([".zip", ".tar", ".tar.gz", ".tgz", ".gz", ".7z", ".rar"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif"]);
const DOCUMENT_EXTS = new Set([".md", ".markdown", ".txt", ".rtf", ".pdf"]);
const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".rs", ".go", ".java", ".kt", ".swift",
  ".c", ".cpp", ".cc", ".h", ".hpp", ".cs", ".php",
  ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd",
  ".html", ".css", ".scss", ".less", ".vue", ".svelte",
  ".json", ".yaml", ".yml", ".toml", ".xml", ".ini", ".env",
  ".sql", ".graphql", ".proto", ".lua"
]);

/** Coarse content type used by the frontend to pick an icon. */
export function classifyExtension(ext: string): "image" | "archive" | "document" | "code" | "other" {
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ARCHIVE_EXTS.has(ext)) return "archive";
  if (DOCUMENT_EXTS.has(ext)) return "document";
  if (CODE_EXTS.has(ext)) return "code";
  return "other";
}

type PresentFileInput = {
  path: string;
  label?: string;
  description?: string;
};

function normalizeInput(value: unknown): PresentFileInput | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? { path: trimmed } : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const pathValue = typeof record.path === "string" ? record.path.trim() : "";
  if (!pathValue) return null;
  return {
    path: pathValue,
    label: typeof record.label === "string" ? record.label.trim() || undefined : undefined,
    description: typeof record.description === "string" ? record.description.trim() || undefined : undefined
  };
}

function normalizeFilesParam(value: unknown): PresentFileInput[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeInput).filter((v): v is PresentFileInput => v !== null);
}

export class PresentFileTool extends Tool {
  definition: ToolDefinition = {
    name: "present_file",
    description: "Surface one or more workspace files as interactive cards in the chat. Each card shows the file's name, size, type icon, and action buttons (open, copy path). Use this when you have produced or modified a file the user should examine — e.g. \"I've written the script, here it is:\" then present_file(['scripts/run.ts']).",
    category: "filesystem",
    riskLevel: "read",
    parameters: {
      files: {
        type: "array",
        description: "One or more files to present",
        required: true,
        items: {
          type: "object",
          description: "A file descriptor: { path, label?, description? }",
          properties: {
            path: {
              type: "string",
              description: "Workspace-relative path to the file",
              required: true
            },
            label: {
              type: "string",
              description: "Optional human-readable label (e.g. 'Main script')"
            },
            description: {
              type: "string",
              description: "Optional one-line description of what the file does"
            }
          }
        }
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const inputs = normalizeFilesParam(params.files);
    if (inputs.length === 0) {
      return {
        success: false,
        error: "At least one file is required. Pass `files: [{ path: \"...\" }]`."
      };
    }
    if (inputs.length > 12) {
      return {
        success: false,
        error: "present_file accepts at most 12 files per call. Split into multiple calls."
      };
    }

    const presented: PresentedFile[] = [];
    const notFound: string[] = [];

    for (const input of inputs) {
      if (containsPathTraversal(input.path)) {
        return {
          success: false,
          error: `Access denied: path "${input.path}" contains traversal sequences`
        };
      }
      const fullPath = resolveWorkspacePath(input.path, context.workspaceRoot);
      if (!isWithinWorkspace(fullPath, context.workspaceRoot)) {
        return {
          success: false,
          error: `Access denied: path "${input.path}" is outside the workspace`
        };
      }

      let stats;
      try {
        stats = await stat(fullPath);
      } catch {
        notFound.push(input.path);
        continue;
      }

      presented.push({
        path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
        fullPath,
        name: basename(fullPath),
        ext: extname(fullPath).toLowerCase(),
        size: stats.size,
        mtime: stats.mtime.toISOString(),
        isDirectory: stats.isDirectory(),
        ...(input.label ? { label: input.label } : {}),
        ...(input.description ? { description: input.description } : {})
      });
    }

    if (presented.length === 0) {
      return {
        success: false,
        error: `None of the requested files exist: ${notFound.join(", ")}`
      };
    }

    return {
      success: true,
      data: {
        // Frontend convention: this is the array the agent-steps-viewer
        // looks for to render FilePresentationCards.
        presentedFiles: presented,
        // Convenience breakdown for the LLM.
        count: presented.length,
        // Surface "not found" alongside so the model can adjust.
        notFound: notFound.length > 0 ? notFound : undefined
      }
    };
  }
}
