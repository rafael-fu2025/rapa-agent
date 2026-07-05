import { promisify } from "node:util";
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";

const execAsync = promisify(exec);

async function runGit(args: string[], cwd: string, timeout = 30000): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await execAsync(`git ${args.join(" ")}`, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024 * 8,
      env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }
    });

    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    return {
      success: true,
      output,
      data: { cwd }
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Git command failed",
      data: { cwd }
    };
  }
}

function findGitRoot(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function requireGitRepo(cwd: string): Promise<ToolResult | null> {
  const root = findGitRoot(cwd);
  if (!root) {
    return {
      success: false,
      error: "No Git repository found in the current workspace or any parent directory"
    };
  }
  return null;
}

export class GitStatusTool extends Tool {
  definition: ToolDefinition = {
    name: "git_status",
    description: "Show the working tree status — staged, unstaged, and untracked changes",
    category: "filesystem",
    riskLevel: "read",
    parameters: {
      path: {
        type: "string",
        description: "Optional path to a file or directory, relative to workspace root",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const repoError = await requireGitRepo(context.workspaceRoot);
    if (repoError) return repoError;

    const path = typeof params.path === "string" && params.path.trim()
      ? params.path.trim()
      : undefined;

    const args = ["status", "--porcelain", "--branch"];
    if (path) args.push("--", path);

    return runGit(args, context.workspaceRoot);
  }
}

export class GitDiffTool extends Tool {
  definition: ToolDefinition = {
    name: "git_diff",
    description: "Show changes between commits, the working tree, or the index. Use to see what was modified before committing.",
    category: "filesystem",
    riskLevel: "read",
    parameters: {
      staged: {
        type: "boolean",
        description: "Show staged changes (--staged). Default shows unstaged changes.",
        required: false
      },
      path: {
        type: "string",
        description: "Optional path to a specific file or directory",
        required: false
      },
      commit: {
        type: "string",
        description: "Optional commit hash or ref to diff against (e.g. HEAD~1, main)",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const repoError = await requireGitRepo(context.workspaceRoot);
    if (repoError) return repoError;

    const args = ["diff", "--unified=3"];
    if (params.staged) args.push("--staged");
    if (typeof params.commit === "string" && params.commit.trim()) {
      args.push(params.commit.trim());
    }
    if (typeof params.path === "string" && params.path.trim()) {
      args.push("--", params.path.trim());
    }

    return runGit(args, context.workspaceRoot);
  }
}

export class GitLogTool extends Tool {
  definition: ToolDefinition = {
    name: "git_log",
    description: "Show commit history with compact one-line format",
    category: "filesystem",
    riskLevel: "read",
    parameters: {
      count: {
        type: "number",
        description: "Number of recent commits to show (default: 15)",
        required: false
      },
      path: {
        type: "string",
        description: "Optional path to a specific file to see its history",
        required: false
      },
      author: {
        type: "string",
        description: "Optional author to filter by",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const repoError = await requireGitRepo(context.workspaceRoot);
    if (repoError) return repoError;

    const count = typeof params.count === "number" ? Math.min(Math.max(1, Math.floor(params.count)), 100) : 15;
    const args = [
      "log",
      `-${count}`,
      "--oneline",
      "--decorate",
      "--no-merges"
    ];

    if (typeof params.author === "string" && params.author.trim()) {
      args.push("--author", params.author.trim());
    }
    if (typeof params.path === "string" && params.path.trim()) {
      args.push("--", params.path.trim());
    }

    return runGit(args, context.workspaceRoot);
  }
}

export class GitBranchTool extends Tool {
  definition: ToolDefinition = {
    name: "git_branch",
    description: "List local branches. Shows the current branch with a star.",
    category: "filesystem",
    riskLevel: "read",
    parameters: {
      remote: {
        type: "boolean",
        description: "Also show remote branches (-a)",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const repoError = await requireGitRepo(context.workspaceRoot);
    if (repoError) return repoError;

    const args = ["branch", "--sort=-committerdate"];
    if (params.remote) args.push("-a");

    return runGit(args, context.workspaceRoot);
  }
}

export class GitCommitTool extends Tool {
  definition: ToolDefinition = {
    name: "git_commit",
    description: "Create a new commit with staged changes. The commit will include a summary of what was done and which files changed.",
    category: "shell",
    riskLevel: "write",
    requiresApproval: true,
    parameters: {
      message: {
        type: "string",
        description: "Commit message. Follow conventional commits format when applicable (e.g. feat: add search, fix: handle null input)",
        required: true
      },
      files: {
        type: "array",
        description: "Optional list of specific files to stage before committing",
        required: false,
        items: {
          type: "string",
          description: "File path relative to workspace root"
        }
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const repoError = await requireGitRepo(context.workspaceRoot);
    if (repoError) return repoError;

    const message = (params.message as string | undefined)?.trim();
    if (!message) {
      return { success: false, error: "Commit message is required" };
    }

    const files = Array.isArray(params.files) && params.files.length > 0
      ? (params.files as string[]).filter((f): f is string => typeof f === "string" && f.trim().length > 0)
      : undefined;

    if (files) {
      const addResult = await runGit(["add", "--", ...files], context.workspaceRoot);
      if (!addResult.success) return addResult;
    } else {
      const addResult = await runGit(["add", "-A"], context.workspaceRoot);
      if (!addResult.success) return addResult;
    }

    const result = await runGit(["commit", "-m", message], context.workspaceRoot, 60000);
    if (result.success) {
      const summary = await runGit(["show", "--stat", "--format=%H%n%s", "HEAD"], context.workspaceRoot);
      result.data = { ...(result.data as object ?? {}), summary: summary.output };
    }
    return result;
  }
}

/**
 * §4.4 — list_changed_files.
 *
 * Returns a structured list of files with their change type, so the
 * agent can decide what to stage/commit without parsing porcelain output.
 *
 * The mapping from git status codes to change types follows the
 * conventions used by porcelain v1:
 *   'M' = modified in worktree, 'A' = added (intent-to-add), 'D' = deleted,
 *   'R' = renamed, 'C' = copied, 'U' = updated but unmerged, '?' = untracked,
 *   '!' = ignored.
 */
export type FileChange = {
  path: string;
  changeType: "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "ignored" | "unmerged" | "type-changed";
  /** Original path for renames/copies. */
  oldPath?: string;
  /** Which side the change is on: 'staged', 'unstaged', or 'untracked'. */
  side: "staged" | "unstaged" | "untracked";
};

export class ListChangedFilesTool extends Tool {
  definition: ToolDefinition = {
    name: "list_changed_files",
    description: "Return a structured list of files that have been modified, added, deleted, renamed, or are untracked, with their change type. Useful for pre-commit workflows where you need to know what changed without parsing git status output.",
    category: "filesystem",
    riskLevel: "read",
    parameters: {
      path: {
        type: "string",
        description: "Optional path to a file or directory, relative to workspace root. Omit to list all changes in the repo.",
        required: false
      },
      includeUntracked: {
        type: "boolean",
        description: "Include untracked files (default true)",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const repoError = await requireGitRepo(context.workspaceRoot);
    if (repoError) return repoError;

    const includeUntracked = params.includeUntracked !== false;
    const pathArg = typeof params.path === "string" && params.path.trim() ? params.path.trim() : undefined;

    // --porcelain gives a stable, parseable format:
    //   XY<space>PATH
    //   XY<space>OLD_PATH -> NEW_PATH   (for renames/copies, only when -z)
    // We use `-z` for unambiguous NUL-separated output, then split on NUL.
    const args = ["status", "--porcelain", "-z", "--untracked-files=all"];
    if (pathArg) args.push("--", pathArg);

    const result = await runGit(args, context.workspaceRoot);
    if (!result.success) return result;

    const output = result.output ?? "";
    if (!output) {
      return {
        success: true,
        data: {
          changes: [],
          summary: { total: 0, staged: 0, unstaged: 0, untracked: 0 }
        }
      };
    }

    // -z produces entries separated by NUL. Renames/copies append a second
    // NUL-separated path for the old name. We split on NUL and walk
    // records of (header) or (header, oldPath, newPath) shape.
    const changes: FileChange[] = [];
    const tokens = output.split("\u0000").filter(Boolean);

    for (let i = 0; i < tokens.length; i += 1) {
      const header = tokens[i];
      if (!header || header.length < 4) continue;
      const x = header[0]; // staged status
      const y = header[1]; // unstaged status
      const rest = header.slice(3);
      const oldPath = rest;
      let newPath = rest;
      let consumed = 0;
      // For renames/copies, the next token is the old path and the
      // current one is the new path.
      if ((x === "R" || x === "C") && tokens[i + 1]) {
        newPath = oldPath;
        consumed = 1;
      }

      const push = (side: "staged" | "unstaged" | "untracked", code: string, filePath: string, oldP?: string) => {
        const changeType = mapCode(code);
        if (!changeType) return;
        changes.push({
          path: filePath,
          changeType,
          side,
          ...(oldP ? { oldPath: oldP } : {})
        });
      };

      if (x !== " " && x !== "?") {
        push("staged", x, newPath, consumed ? oldPath : undefined);
      }
      if (y !== " " && y !== "?") {
        push("unstaged", y, newPath);
      }
      if (x === "?" || y === "?") {
        if (includeUntracked) push("untracked", "?", newPath);
      }

      i += consumed;
    }

    const summary = {
      total: changes.length,
      staged: changes.filter((c) => c.side === "staged").length,
      unstaged: changes.filter((c) => c.side === "unstaged").length,
      untracked: changes.filter((c) => c.side === "untracked").length
    };

    return {
      success: true,
      data: { changes, summary }
    };
  }
}

function mapCode(code: string): FileChange["changeType"] | null {
  switch (code) {
    case "M": return "modified";
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "U": return "unmerged";
    case "T": return "type-changed";
    case "?": return "untracked";
    case "!": return "ignored";
    default: return null;
  }
}
