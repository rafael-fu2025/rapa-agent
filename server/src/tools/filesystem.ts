// File system tools

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { Suggest } from "../lib/suggestions.js";

type WorkspaceEntry = {
  path: string;
  name: string;
  type: "file" | "directory";
};

type SearchContentMatch = {
  path: string;
  line: number;
  column: number;
  text: string;
  /** Lines before the match (when contextLines > 0) */
  beforeLines?: string[];
  /** Lines after the match (when contextLines > 0) */
  afterLines?: string[];
};

type SearchOutputMode = "content" | "files_only" | "count";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo"
]);

export function isWithinWorkspace(fullPath: string, workspaceRoot: string): boolean {
  const rel = relative(resolve(workspaceRoot), resolve(fullPath)).split("\\").join("/");
  return rel === "" || (rel !== ".." && !rel.startsWith("../"));
}

export function resolveWorkspacePath(pathValue: string | undefined, workspaceRoot: string): string {
  return resolve(workspaceRoot, pathValue && pathValue.trim().length > 0 ? pathValue : ".");
}

export function toWorkspaceRelativePath(fullPath: string, workspaceRoot: string): string {
  const rel = relative(resolve(workspaceRoot), resolve(fullPath));
  return rel.length > 0 ? rel.split("\\").join("/") : ".";
}

// ---------------------------------------------------------------------------
// Symlink-aware path resolution.
//
// `isWithinWorkspace` and friends above only check the lexical (string) path.
// A path like `/workspace/safe.txt` is "within" `/workspace` even if
// `safe.txt` is actually a symlink pointing at `/etc/passwd`. This defeats
// the entire workspace boundary check.
//
// The helpers below canonicalize symlinks via `fs.realpath` so that:
//   * a path inside the workspace that symlinks OUTSIDE is rejected
//   * a path OUTSIDE the workspace that symlinks INSIDE is also rejected
//     (we only allow operations on paths that lexically and canonically live
//     inside the workspace root)
//   * for paths that don't exist yet (writes), we walk up to the first
//     existing ancestor and apply `realpath` to that.
//
// An in-memory cache prevents repeated realpath calls on the hot path. Cache
// entries are stable per process — if you need to detect external symlink
// changes, restart the server.
// ---------------------------------------------------------------------------

const realpathCache = new Map<string, string>();

async function realpathCached(p: string): Promise<string> {
  const cached = realpathCache.get(p);
  if (cached !== undefined) return cached;
  const real = await realpath(p);
  realpathCache.set(p, real);
  return real;
}

async function safeRealpath(target: string): Promise<string> {
  // If the path doesn't exist, walk up to the first existing ancestor.
  // (This lets us validate write targets that haven't been created yet.)
  let cursor = resolve(target);
  const missing: string[] = [];
  // We loop with iterative parent-stripping so the common case (target exists)
  // is one syscall. Bound the loop to prevent infinite recursion on weird
  // inputs (e.g. an empty string after resolve).
  for (let i = 0; i < 64; i++) {
    try {
      const real = await realpathCached(cursor);
      // Reattach the missing suffix verbatim — it can't introduce a symlink
      // because it's relative to a realpath'd directory.
      return missing.length === 0 ? real : join(real, ...missing);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      const parent = dirname(cursor);
      if (parent === cursor) {
        // Hit the filesystem root and still nothing — give up and use the
        // lexical path. The caller will surface its own "not found" error.
        return resolve(target);
      }
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
  return resolve(target);
}

export async function isWithinWorkspaceSymlinkSafe(
  fullPath: string,
  workspaceRoot: string
): Promise<boolean> {
  const resolvedWorkspace = resolve(workspaceRoot);
  let realWorkspace: string;
  try {
    realWorkspace = await realpathCached(resolvedWorkspace);
  } catch {
    // Workspace root itself doesn't exist — treat as "not within" so we
    // surface a meaningful error upstream rather than crashing here.
    return false;
  }

  const realTarget = await safeRealpath(fullPath);
  const rel = relative(realWorkspace, realTarget);
  if (rel.length === 0) return true;
  // Normalize separators for cross-platform safety.
  const relPosix = rel.split(sep).join("/");
  return relPosix !== ".." && !relPosix.startsWith("../");
}

export async function assertWithinWorkspaceSymlinkSafe(
  fullPath: string,
  workspaceRoot: string
): Promise<string> {
  const ok = await isWithinWorkspaceSymlinkSafe(fullPath, workspaceRoot);
  if (!ok) {
    throw new Error(
      `Path "${fullPath}" is outside the workspace root (after symlink resolution). ` +
        `Refusing to operate on paths that escape the workspace.`
    );
  }
  return fullPath;
}

export async function resolveWorkspacePathSafe(
  pathValue: string | undefined,
  workspaceRoot: string
): Promise<string> {
  const candidate = resolve(workspaceRoot, pathValue && pathValue.trim().length > 0 ? pathValue : ".");
  return assertWithinWorkspaceSymlinkSafe(candidate, workspaceRoot);
}

// Reject absolute paths and `..` traversal in user-supplied inputs. The agent
// LLM is untrusted, so this is the first cheap defense before we even hit
// the filesystem.
export function containsPathTraversal(pathValue: string): boolean {
  if (typeof pathValue !== "string") return false;
  if (pathValue.length === 0) return false;
  if (isAbsolute(pathValue)) return true;
  // Lexical `..` segments — even after symlink checks, these usually
  // indicate an attempt to escape the workspace.
  const segments = pathValue.split(/[\\/]+/);
  return segments.some((segment) => segment === "..");
}

export function clearRealpathCache(): void {
  realpathCache.clear();
}

function isIgnoredDirectory(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name);
}

function toFileError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function countLineNumberAtIndex(content: string, index: number): number {
  if (index <= 0) return 1;
  return content.slice(0, index).split(/\r?\n/).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeExtensions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => {
      const trimmed = value.trim().toLowerCase();
      return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    });
}

function collectOccurrences(haystack: string, needle: string): number[] {
  if (!needle) return [];

  const indices: number[] = [];
  let startIndex = 0;

  while (startIndex <= haystack.length) {
    const matchIndex = haystack.indexOf(needle, startIndex);
    if (matchIndex === -1) break;
    indices.push(matchIndex);
    startIndex = matchIndex + needle.length;
  }

  return indices;
}

async function walkDirectory(
  rootPath: string,
  recursive: boolean,
  workspaceRoot: string,
  entries: WorkspaceEntry[] = []
): Promise<WorkspaceEntry[]> {
  const dirEntries = await readdir(rootPath, { withFileTypes: true });

  for (const entry of dirEntries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory() && isIgnoredDirectory(entry.name)) continue;

    const entryPath = join(rootPath, entry.name);
    const relativePath = toWorkspaceRelativePath(entryPath, workspaceRoot);

    entries.push({
      path: relativePath,
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file"
    });

    if (recursive && entry.isDirectory()) {
      await walkDirectory(entryPath, true, workspaceRoot, entries);
    }
  }

  return entries;
}

async function collectSearchFileMatches(
  directory: string,
  pattern: string,
  workspaceRoot: string,
  recursive: boolean,
  matches: string[] = []
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory() && isIgnoredDirectory(entry.name)) continue;

    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        await collectSearchFileMatches(fullPath, pattern, workspaceRoot, true, matches);
      }
      continue;
    }

    if (matchFilenamePattern(entry.name, pattern)) {
      matches.push(toWorkspaceRelativePath(fullPath, workspaceRoot));
    }
  }

  return matches;
}

function matchFilenamePattern(filename: string, pattern: string): boolean {
  const regex = new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, ".*").replace(/\\\?/g, ".")}$`, "i");
  return regex.test(filename);
}

function matchesExtensionFilter(pathValue: string, extensions: string[]): boolean {
  if (extensions.length === 0) return true;
  return extensions.includes(extname(pathValue).toLowerCase());
}

async function collectContentMatches(
  rootPath: string,
  options: {
    workspaceRoot: string;
    query: string;
    caseSensitive: boolean;
    recursive: boolean;
    fileExtensions: string[];
    maxResults: number;
    regex: boolean;
    multiline: boolean;
    contextLines: number;
    offset: number;
    outputMode: SearchOutputMode;
  },
  matches: SearchContentMatch[] = []
): Promise<SearchContentMatch[]> {
  if (matches.length >= options.maxResults + options.offset) return matches;

  const stats = await stat(rootPath);
  if (stats.isFile()) {
    if (matchesExtensionFilter(rootPath, options.fileExtensions)) {
      await scanFileContent(rootPath, options, matches);
    }
    return matches;
  }

  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (matches.length >= options.maxResults + options.offset) break;
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory() && isIgnoredDirectory(entry.name)) continue;

    const fullPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (options.recursive) {
        await collectContentMatches(fullPath, options, matches);
      }
      continue;
    }

    if (!matchesExtensionFilter(fullPath, options.fileExtensions)) continue;
    await scanFileContent(fullPath, options, matches);
  }

  return matches;
}

async function scanFileContent(
  filePath: string,
  options: {
    workspaceRoot: string;
    query: string;
    caseSensitive: boolean;
    maxResults: number;
    regex: boolean;
    multiline: boolean;
    contextLines: number;
    offset: number;
    outputMode: SearchOutputMode;
  },
  matches: SearchContentMatch[]
) {
  if (matches.length >= options.maxResults + options.offset) return;

  try {
    const content = await readFile(filePath, "utf-8");
    if (content.includes("\u0000")) return;

    const fileRelativePath = toWorkspaceRelativePath(filePath, options.workspaceRoot);
    const lines = content.split(/\r?\n/);

    if (options.regex) {
      // Regex mode
      let flags = "g";
      if (!options.caseSensitive) flags += "i";
      if (options.multiline) flags += "m";

      let pattern: RegExp;
      try {
        pattern = new RegExp(options.query, flags);
      } catch {
        // Invalid regex — fall back to literal
        pattern = new RegExp(escapeRegExp(options.query), flags);
      }

      if (options.multiline) {
        // For multiline regex, match against the full content
        let match: RegExpExecArray | null;
        let lineOffset = 0;
        while ((match = pattern.exec(content)) !== null && matches.length < options.maxResults + options.offset) {
          const lineNum = content.slice(0, match.index).split(/\r?\n/).length;
          const matchLine = lines[lineNum - 1] ?? "";
          const beforeStart = Math.max(0, lineNum - 1 - options.contextLines);
          const afterEnd = Math.min(lines.length, lineNum + options.contextLines);

          matches.push({
            path: fileRelativePath,
            line: lineNum,
            column: match.index - (content.lastIndexOf("\n", match.index) + 1) + 1,
            text: matchLine,
            ...(options.contextLines > 0 ? {
              beforeLines: lines.slice(beforeStart, lineNum - 1),
              afterLines: lines.slice(lineNum, afterEnd)
            } : {})
          });
        }
      } else {
        // Single-line regex
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          if (matches.length >= options.maxResults + options.offset) return;

          const lineText = lines[lineIndex];
          let match: RegExpExecArray | null;
          // Reset lastIndex for each line
          pattern.lastIndex = 0;

          while ((match = pattern.exec(lineText)) !== null) {
            if (matches.length >= options.maxResults + options.offset) return;

            const beforeStart = Math.max(0, lineIndex - options.contextLines);
            const afterEnd = Math.min(lines.length, lineIndex + 1 + options.contextLines);

            matches.push({
              path: fileRelativePath,
              line: lineIndex + 1,
              column: match.index + 1,
              text: lineText,
              ...(options.contextLines > 0 ? {
                beforeLines: lines.slice(beforeStart, lineIndex),
                afterLines: lines.slice(lineIndex + 1, afterEnd)
              } : {})
            });

            // Prevent infinite loop on zero-length matches
            if (match[0].length === 0) pattern.lastIndex++;
          }
        }
      }
    } else {
      // Literal search mode (existing behavior)
      const needle = options.caseSensitive ? options.query : options.query.toLowerCase();

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        if (matches.length >= options.maxResults + options.offset) return;

        const lineText = lines[lineIndex];
        const haystack = options.caseSensitive ? lineText : lineText.toLowerCase();
        let searchIndex = 0;

        while (searchIndex <= haystack.length) {
          const matchIndex = haystack.indexOf(needle, searchIndex);
          if (matchIndex === -1) break;

          const beforeStart = Math.max(0, lineIndex - options.contextLines);
          const afterEnd = Math.min(lines.length, lineIndex + 1 + options.contextLines);

          matches.push({
            path: fileRelativePath,
            line: lineIndex + 1,
            column: matchIndex + 1,
            text: lineText,
            ...(options.contextLines > 0 ? {
              beforeLines: lines.slice(beforeStart, lineIndex),
              afterLines: lines.slice(lineIndex + 1, afterEnd)
            } : {})
          });

          if (matches.length >= options.maxResults + options.offset) return;
          searchIndex = matchIndex + Math.max(needle.length, 1);
        }
      }
    }
  } catch {
    // Ignore unreadable files during broad content search.
  }
}

/**
 * Try to use ripgrep (rg) for searching. Returns null if rg is not available
 * or the search fails — callers should fall back to the JS implementation.
 */
async function tryRipgrep(
  rootPath: string,
  options: {
    workspaceRoot: string;
    query: string;
    caseSensitive: boolean;
    recursive: boolean;
    fileExtensions: string[];
    maxResults: number;
    regex: boolean;
    multiline: boolean;
    contextLines: number;
    offset: number;
  }
): Promise<SearchContentMatch[] | null> {
  const args: string[] = [
    "--json",
    "--max-count", String(options.maxResults + options.offset),
  ];

  if (!options.caseSensitive) args.push("-i");
  if (!options.regex) args.push("--fixed-strings");
  if (options.multiline) args.push("--multiline", "--pcre2");
  if (options.contextLines > 0) {
    args.push("-C", String(options.contextLines));
  }
  if (!options.recursive) args.push("--max-depth", "1");
  for (const ext of options.fileExtensions) {
    args.push("--glob", `*${ext}`);
  }

  args.push("--", options.query, rootPath);

  return new Promise((resolvePromise) => {
    execFile("rg", args, {
      maxBuffer: 1024 * 1024 * 20,
      timeout: 30_000,
      cwd: options.workspaceRoot
    }, (error, stdout) => {
      if (error && !stdout) {
        // rg not found or fatal error
        resolvePromise(null);
        return;
      }

      try {
        const matches: SearchContentMatch[] = [];
        const lines = stdout.split("\n").filter(Boolean);

        for (const line of lines) {
          const parsed = JSON.parse(line) as {
            type: string;
            data?: {
              path?: { text?: string };
              line_number?: number;
              submatches?: Array<{ start: number; match: { text: string } }>;
              lines?: { text?: string };
            };
          };

          if (parsed.type === "match" && parsed.data) {
            const relPath = parsed.data.path?.text
              ? toWorkspaceRelativePath(
                  resolve(options.workspaceRoot, parsed.data.path.text),
                  options.workspaceRoot
                )
              : "";
            const lineText = (parsed.data.lines?.text ?? "").replace(/\r?\n$/, "");
            const col = parsed.data.submatches?.[0]?.start ?? 0;

            matches.push({
              path: relPath,
              line: parsed.data.line_number ?? 0,
              column: col + 1,
              text: lineText
            });
          }
        }

        resolvePromise(matches);
      } catch {
        resolvePromise(null);
      }
    });
  });
}

export class ReadFileTool extends Tool {
  definition: ToolDefinition = {
    name: "read_file",
    description: "Read the contents of a file from the workspace",
    category: "filesystem",
    riskLevel: "read",
    parameters: {
      path: {
        type: "string",
        description: "Relative path to the file from workspace root",
        required: true
      },
      offset: {
        type: "number",
        description: "Optional starting line number (1-based)",
        required: false
      },
      limit: {
        type: "number",
        description: "Optional maximum number of lines to read",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const filePath = params.path as string;
    const offset = typeof params.offset === "number" ? Math.max(1, Math.floor(params.offset)) : undefined;
    const limit = typeof params.limit === "number" ? Math.max(1, Math.floor(params.limit)) : undefined;

    if (containsPathTraversal(filePath)) {
      return { success: false, error: "Access denied: path contains traversal sequences" };
    }

    const fullPath = resolveWorkspacePath(filePath, context.workspaceRoot);

    if (!context.allowOutsideWorkspace && !(await isWithinWorkspaceSymlinkSafe(fullPath, context.workspaceRoot))) {
      return {
        success: false,
        error: "Access denied: path is outside workspace"
      };
    }

    try {
      const content = await readFile(fullPath, "utf-8");
      const lines = content.split(/\r?\n/);
      const totalLines = lines.length;

      if (offset !== undefined || limit !== undefined) {
        const start = (offset ?? 1) - 1;
        const end = limit !== undefined ? Math.min(start + limit, totalLines) : totalLines;

        return {
          success: true,
          data: {
            path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
            fullPath,
            fileSize: Buffer.byteLength(content),
            content: lines.slice(start, end).join("\n"),
            startLine: offset ?? 1,
            endLine: end,
            totalLines
          }
        };

      }

      return {
        success: true,
        data: {
          path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
          fullPath,
          fileSize: Buffer.byteLength(content),
          content,
          startLine: 1,
          endLine: totalLines,
          totalLines
        }
      };

    } catch (error) {
      const errorMessage = toFileError(error, "Failed to read file");
      if (/ENOENT|no such file/i.test(errorMessage)) {
        return Suggest.fileNotFound({ success: false, error: errorMessage }, filePath);
      }
      if (/EACCES|permission denied/i.test(errorMessage)) {
        return Suggest.permissionDenied({ success: false, error: errorMessage }, filePath);
      }
      return { success: false, error: errorMessage };
    }
  }
}

export class WriteFileTool extends Tool {
  definition: ToolDefinition = {
    name: "write_file",
    description: "Write content to a file in the workspace (creates or overwrites)",
    category: "filesystem",
    requiresApproval: true,
    parameters: {
      path: {
        type: "string",
        description: "Relative path to the file from workspace root",
        required: true
      },
      content: {
        type: "string",
        description: "Content to write to the file",
        required: true
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const filePath = params.path as string;
    const content = params.content as string;

    if (containsPathTraversal(filePath)) {
      return { success: false, error: "Access denied: path contains traversal sequences" };
    }

    const fullPath = resolveWorkspacePath(filePath, context.workspaceRoot);

    if (!(await isWithinWorkspaceSymlinkSafe(fullPath, context.workspaceRoot))) {
      return {
        success: false,
        error: "Access denied: path is outside workspace"
      };
    }

    try {
      let previousContent: string | null = null;
      try {
        previousContent = await readFile(fullPath, "utf-8");
      } catch {
        previousContent = null;
      }

      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf-8");
      return {
        success: true,
        data: {
          path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
          fullPath,
          bytesWritten: Buffer.byteLength(content),
          fileSize: Buffer.byteLength(content),
          diff: {
            before: previousContent,
            after: content
          }
        }
      };

    } catch (error) {

      const errorMessage = toFileError(error, "Failed to write file");
      if (/ENOENT|no such file/i.test(errorMessage)) {
        return Suggest.generic(
          { success: false, error: errorMessage },
          "The parent directory probably doesn't exist. Call mkdir first with `recursive: true`."
        );
      }
      if (/EACCES|permission denied/i.test(errorMessage)) {
        return Suggest.permissionDenied({ success: false, error: errorMessage }, fullPath);
      }
      return { success: false, error: errorMessage };
    }
  }
}

export class ListDirectoryTool extends Tool {
  definition: ToolDefinition = {
    name: "list_directory",
    description: "List files and directories in a given path",
    category: "filesystem",
    riskLevel: "read",
    parameters: {
      path: {
        type: "string",
        description: "Relative path to directory from workspace root (use '.' for root)",
        required: true
      },
      recursive: {
        type: "boolean",
        description: "Whether to list recursively",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const dirPath = params.path as string;
    const recursive = (params.recursive as boolean | undefined) ?? false;

    if (containsPathTraversal(dirPath)) {
      return { success: false, error: "Access denied: path contains traversal sequences" };
    }

    const fullPath = resolveWorkspacePath(dirPath, context.workspaceRoot);

    if (!context.allowOutsideWorkspace && !(await isWithinWorkspaceSymlinkSafe(fullPath, context.workspaceRoot))) {
      return {
        success: false,
        error: "Access denied: path is outside workspace"
      };
    }

    try {
      const entries = await walkDirectory(fullPath, recursive, context.workspaceRoot);
      return {
        success: true,
        data: {
          path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
          entries
        }
      };
    } catch (error) {
      return {
        success: false,
        error: toFileError(error, "Failed to list directory")
      };
    }
  }
}

export class SearchFilesTool extends Tool {
  definition: ToolDefinition = {
    name: "search_files",
    description: "Search for files by name pattern in the workspace",
    category: "filesystem",
    riskLevel: "read",
    parameters: {
      pattern: {
        type: "string",
        description: "File name pattern to search for (supports wildcards)",
        required: true
      },
      path: {
        type: "string",
        description: "Directory to search in (default: workspace root)",
        required: false
      },
      recursive: {
        type: "boolean",
        description: "Whether to search recursively",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const pattern = params.pattern as string;
    const searchPath = (params.path as string | undefined) ?? ".";
    const recursive = (params.recursive as boolean | undefined) ?? true;

    if (containsPathTraversal(searchPath)) {
      return { success: false, error: "Access denied: path contains traversal sequences" };
    }

    const fullPath = resolveWorkspacePath(searchPath, context.workspaceRoot);

    if (!context.allowOutsideWorkspace && !(await isWithinWorkspaceSymlinkSafe(fullPath, context.workspaceRoot))) {
      return {
        success: false,
        error: "Access denied: path is outside workspace"
      };
    }

    try {
      const matches = await collectSearchFileMatches(fullPath, pattern, context.workspaceRoot, recursive);
      return {
        success: true,
        data: {
          pattern,
          matches,
          path: toWorkspaceRelativePath(fullPath, context.workspaceRoot)
        }
      };
    } catch (error) {
      return {
        success: false,
        error: toFileError(error, "Failed to search files")
      };
    }
  }
}

export class SearchContentTool extends Tool {
  definition: ToolDefinition = {
    name: "search_content",
    description: "Search file contents for text or regex matches in the workspace. Supports regex patterns, multiline matching, context lines, pagination, and multiple output modes.",
    category: "filesystem",
    riskLevel: "read",
    parameters: {
      query: {
        type: "string",
        description: "Text or regex pattern to search for",
        required: true
      },
      path: {
        type: "string",
        description: "File or directory to search (default: workspace root)",
        required: false
      },
      caseSensitive: {
        type: "boolean",
        description: "Whether search should be case-sensitive (default: false)",
        required: false
      },
      recursive: {
        type: "boolean",
        description: "Whether to search directories recursively (default: true)",
        required: false
      },
      fileExtensions: {
        type: "array",
        description: "Optional file extension filters such as ['.ts', '.tsx']",
        required: false,
        items: {
          type: "string",
          description: "File extension"
        }
      },
      maxResults: {
        type: "number",
        description: "Maximum number of matches to return (default: 50, max: 500)",
        required: false
      },
      regex: {
        type: "boolean",
        description: "Enable regex pattern matching (default: false — literal search)",
        required: false
      },
      multiline: {
        type: "boolean",
        description: "Allow regex patterns that span multiple lines (requires regex: true)",
        required: false
      },
      contextLines: {
        type: "number",
        description: "Number of lines to include before and after each match (default: 0)",
        required: false
      },
      headLimit: {
        type: "number",
        description: "Return at most this many matches (applied after offset). Use with offset for pagination.",
        required: false
      },
      offset: {
        type: "number",
        description: "Skip the first N matches (for pagination, default: 0)",
        required: false
      },
      outputMode: {
        type: "string",
        description: "Output mode: 'content' (matching lines), 'files_only' (file paths only), 'count' (match counts per file)",
        required: false,
        enum: ["content", "files_only", "count"]
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const query = (params.query as string | undefined)?.trim();
    const searchPath = (params.path as string | undefined) ?? ".";
    const caseSensitive = (params.caseSensitive as boolean | undefined) ?? false;
    const recursive = (params.recursive as boolean | undefined) ?? true;
    const maxResultsRaw = Math.max(1, Math.min(500, Math.floor((params.maxResults as number | undefined) ?? 50)));
    const fileExtensions = normalizeExtensions(params.fileExtensions);
    const regex = (params.regex as boolean | undefined) ?? false;
    const multiline = (params.multiline as boolean | undefined) ?? false;
    const contextLines = Math.max(0, Math.min(10, Math.floor((params.contextLines as number | undefined) ?? 0)));
    const headLimit = typeof params.headLimit === "number"
      ? Math.max(1, Math.min(500, Math.floor(params.headLimit)))
      : maxResultsRaw;
    const offset = Math.max(0, Math.floor((params.offset as number | undefined) ?? 0));
    const outputMode = (params.outputMode as SearchOutputMode | undefined) ?? "content";

    if (containsPathTraversal(searchPath)) {
      return { success: false, error: "Access denied: path contains traversal sequences" };
    }

    const fullPath = resolveWorkspacePath(searchPath, context.workspaceRoot);

    if (!query) {
      return { success: false, error: "Query must not be empty" };
    }

    if (!context.allowOutsideWorkspace && !(await isWithinWorkspaceSymlinkSafe(fullPath, context.workspaceRoot))) {
      return { success: false, error: "Access denied: path is outside workspace" };
    }

    const searchOptions = {
      workspaceRoot: context.workspaceRoot,
      query,
      caseSensitive,
      recursive,
      fileExtensions,
      maxResults: headLimit,
      regex,
      multiline,
      contextLines,
      offset,
      outputMode
    };

    try {
      // Try ripgrep first for non-multiline, non-context searches (it's much faster)
      let matches: SearchContentMatch[] | null = null;
      if (contextLines === 0 && !multiline) {
        matches = await tryRipgrep(fullPath, searchOptions);
      }

      // Fall back to JS implementation
      if (matches === null) {
        matches = await collectContentMatches(fullPath, searchOptions);
      }

      // Apply offset + headLimit pagination
      const paginated = matches.slice(offset, offset + headLimit);
      const totalMatches = matches.length;

      // Format output based on mode
      if (outputMode === "files_only") {
        const uniqueFiles = [...new Set(matches.map((m) => m.path))];
        const paginatedFiles = uniqueFiles.slice(offset, offset + headLimit);
        return {
          success: true,
          data: {
            query,
            path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
            outputMode,
            regex,
            totalMatches,
            totalFiles: uniqueFiles.length,
            files: paginatedFiles,
            truncated: totalMatches >= headLimit + offset
          }
        };
      }

      if (outputMode === "count") {
        const countMap = new Map<string, number>();
        for (const m of matches) {
          countMap.set(m.path, (countMap.get(m.path) ?? 0) + 1);
        }
        const counts = Array.from(countMap.entries()).map(([file, count]) => ({ file, count }));
        return {
          success: true,
          data: {
            query,
            path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
            outputMode,
            regex,
            totalMatches,
            totalFiles: counts.length,
            counts,
            truncated: false
          }
        };
      }

      // Default: "content" mode
      return {
        success: true,
        data: {
          query,
          path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
          caseSensitive,
          recursive,
          fileExtensions,
          regex,
          multiline,
          contextLines,
          matches: paginated,
          totalMatches,
          truncated: totalMatches >= headLimit + offset
        }
      };
    } catch (error) {
      return {
        success: false,
        error: toFileError(error, "Failed to search file contents")
      };
    }
  }
}

export class DeleteFileTool extends Tool {
  definition: ToolDefinition = {
    name: "delete_file",
    description: "Delete a file or directory from the workspace",
    category: "filesystem",
    requiresApproval: true,
    parameters: {
      path: {
        type: "string",
        description: "Relative path to the file or directory",
        required: true
      },
      recursive: {
        type: "boolean",
        description: "Whether directories can be removed recursively",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const pathValue = params.path as string;
    const recursive = (params.recursive as boolean | undefined) ?? false;

    if (containsPathTraversal(pathValue)) {
      return { success: false, error: "Access denied: path contains traversal sequences" };
    }

    const fullPath = resolveWorkspacePath(pathValue, context.workspaceRoot);

    if (!(await isWithinWorkspaceSymlinkSafe(fullPath, context.workspaceRoot))) {
      return {
        success: false,
        error: "Access denied: path is outside workspace"
      };
    }

    try {
      const info = await stat(fullPath);
      const previousContent = info.isFile() ? await readFile(fullPath, "utf-8") : null;
      await rm(fullPath, { recursive, force: false });

      return {
        success: true,
        data: {
          path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
          type: info.isDirectory() ? "directory" : "file",
          recursive,
          diff: previousContent !== null
            ? {
                before: previousContent,
                after: null
              }
            : undefined
        }
      };

    } catch (error) {
      return {
        success: false,
        error: toFileError(error, "Failed to delete path")
      };
    }
  }
}

export class RenameFileTool extends Tool {
  definition: ToolDefinition = {
    name: "rename_file",
    description: "Rename or move a file or directory within the workspace",
    category: "filesystem",
    requiresApproval: true,
    parameters: {
      oldPath: {
        type: "string",
        description: "Existing path to rename",
        required: true
      },
      newPath: {
        type: "string",
        description: "New path to move the file or directory to",
        required: true
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const oldPath = params.oldPath as string;
    const newPath = params.newPath as string;

    if (containsPathTraversal(oldPath) || containsPathTraversal(newPath)) {
      return { success: false, error: "Access denied: path contains traversal sequences" };
    }

    const sourcePath = resolveWorkspacePath(oldPath, context.workspaceRoot);
    const targetPath = resolveWorkspacePath(newPath, context.workspaceRoot);

    if (!(await isWithinWorkspaceSymlinkSafe(sourcePath, context.workspaceRoot)) || !(await isWithinWorkspaceSymlinkSafe(targetPath, context.workspaceRoot))) {
      return {
        success: false,
        error: "Access denied: path is outside workspace"
      };
    }

    try {
      await mkdir(dirname(targetPath), { recursive: true });
      await rename(sourcePath, targetPath);
      return {
        success: true,
        data: {
          oldPath: toWorkspaceRelativePath(sourcePath, context.workspaceRoot),
          newPath: toWorkspaceRelativePath(targetPath, context.workspaceRoot)
        }
      };
    } catch (error) {
      return {
        success: false,
        error: toFileError(error, "Failed to rename path")
      };
    }
  }
}

export class MkdirTool extends Tool {
  definition: ToolDefinition = {
    name: "mkdir",
    description: "Create a directory in the workspace",
    category: "filesystem",
    requiresApproval: true,
    parameters: {
      path: {
        type: "string",
        description: "Directory path to create",
        required: true
      },
      recursive: {
        type: "boolean",
        description: "Whether to create parent directories as needed",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const pathValue = params.path as string;
    const recursive = (params.recursive as boolean | undefined) ?? true;

    if (containsPathTraversal(pathValue)) {
      return { success: false, error: "Access denied: path contains traversal sequences" };
    }

    const fullPath = resolveWorkspacePath(pathValue, context.workspaceRoot);

    if (!(await isWithinWorkspaceSymlinkSafe(fullPath, context.workspaceRoot))) {
      return {
        success: false,
        error: "Access denied: path is outside workspace"
      };
    }

    try {
      await mkdir(fullPath, { recursive });
      return {
        success: true,
        data: {
          path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
          name: basename(fullPath),
          recursive
        }
      };
    } catch (error) {
      return {
        success: false,
        error: toFileError(error, "Failed to create directory")
      };
    }
  }
}

export const filesystemInternals = {
  collectOccurrences,
  countLineNumberAtIndex,
  escapeRegExp,
  toFileError
};

// ---------------------------------------------------------------------------
// Supported image extensions and MIME types for read_image
// ---------------------------------------------------------------------------
const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon"
};

const IMAGE_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export class ReadImageTool extends Tool {
  definition: ToolDefinition = {
    name: "read_image",
    description: "Read an image file from the workspace and return it as base64-encoded data with MIME type. Supports PNG, JPG, GIF, WebP, SVG, BMP, and ICO files up to 10MB.",
    category: "filesystem",
    riskLevel: "read",
    parameters: {
      path: {
        type: "string",
        description: "Relative path to the image file from workspace root",
        required: true
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const filePath = params.path as string;

    if (containsPathTraversal(filePath)) {
      return { success: false, error: "Access denied: path contains traversal sequences" };
    }

    const fullPath = resolveWorkspacePath(filePath, context.workspaceRoot);

    if (!context.allowOutsideWorkspace && !(await isWithinWorkspaceSymlinkSafe(fullPath, context.workspaceRoot))) {
      return { success: false, error: "Access denied: path is outside workspace" };
    }

    const ext = extname(filePath).toLowerCase();
    const mediaType = IMAGE_EXTENSIONS[ext];
    if (!mediaType) {
      const supported = Object.keys(IMAGE_EXTENSIONS).join(", ");
      return {
        success: false,
        error: `Unsupported image format "${ext}". Supported: ${supported}`
      };
    }

    try {
      const fileInfo = await stat(fullPath);
      if (!fileInfo.isFile()) {
        return { success: false, error: "Path is not a file" };
      }

      if (fileInfo.size > IMAGE_MAX_SIZE_BYTES) {
        return {
          success: false,
          error: `Image file is too large (${(fileInfo.size / 1024 / 1024).toFixed(1)}MB). Maximum: ${IMAGE_MAX_SIZE_BYTES / 1024 / 1024}MB`
        };
      }

      const buffer = await readFile(fullPath);
      const base64Data = buffer.toString("base64");

      // For SVG, also return the text content since it's XML-based
      let textContent: string | undefined;
      if (ext === ".svg") {
        textContent = buffer.toString("utf-8");
      }

      return {
        success: true,
        data: {
          path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
          fullPath,
          fileSize: fileInfo.size,
          mediaType,
          base64Data,
          content: [
            {
              type: "image",
              mediaType,
              base64Data
            }
          ],
          ...(textContent !== undefined ? { textContent } : {})
        }
      };
    } catch (error) {
      return {
        success: false,
        error: toFileError(error, "Failed to read image file")
      };
    }
  }
}
