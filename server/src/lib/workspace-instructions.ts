// Workspace instruction files (AGENTS.md / CLAUDE.md / .cursorrules).
//
// The ecosystem convention is that a workspace can carry standing agent
// instructions in a root-level markdown file. Rapa reads the first match
// (in the precedence order below) at run start and injects it as a system
// message — the same channel DB-stored AgentRules use, but sourced from
// the repository itself so instructions travel with the project.
//
// Safety: the file lives on disk where anything (a hostile dependency, a
// compromised tool) could have written it. Content is scanned with the
// prompt-injection detector and, when suspicious, wrapped as untrusted
// data — wrap-not-block, mirroring how tool-orchestrator treats
// fetch_url/web_search output (never a hard refusal).

import { readFile, stat } from "node:fs/promises";
import { detectPromptInjection, wrapUntrustedContent } from "./safety/prompt-injection.js";
import { resolveWorkspacePathSafe } from "../tools/filesystem.js";
import { FRONTMATTER_RE } from "./skill-md.js";

/** Probe order — first existing file wins. */
const CANDIDATE_FILES: readonly string[] = ["AGENTS.md", "CLAUDE.md", ".cursorrules"];

/** Skip implausibly large instruction files outright. */
const MAX_FILE_BYTES = 64 * 1024;
/** Hard cap on injected chars — must stay well under the 24k message limit
 *  (PROVIDER_MESSAGE_CHAR_LIMIT) and the 90k history budget. */
const MAX_INJECTED_CHARS = 12_000;

export type WorkspaceInstructions = {
  /** The file the instructions came from ("AGENTS.md", …). */
  source: string;
  /** Frontmatter-stripped, injection-wrapped, length-capped content. */
  content: string;
};

type CacheEntry = { mtimeMs: number; size: number; content: string };
// Keyed `${workspaceRoot}::${source}` — same lifetime semantics as the
// realpathCache in tools/filesystem.ts (per-process, mtime-invalidated).
const instructionCache = new Map<string, CacheEntry>();

export async function loadWorkspaceInstructions(workspaceRoot: string): Promise<WorkspaceInstructions | null> {
  for (const source of CANDIDATE_FILES) {
    const loaded = await loadInstructionFile(source, workspaceRoot);
    if (loaded) return { source, content: loaded };
  }
  return null;
}

async function loadInstructionFile(source: string, workspaceRoot: string): Promise<string | null> {
  try {
    const fullPath = await resolveWorkspacePathSafe(source, workspaceRoot);
    const stats = await stat(fullPath);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return null;

    const cacheKey = `${workspaceRoot}::${source}`;
    const cached = instructionCache.get(cacheKey);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.content;
    }

    const raw = await readFile(fullPath, "utf-8");
    // CLAUDE.md sometimes carries YAML frontmatter; AGENTS.md/.cursorrules
    // never require it. Strip when present so the model sees prose only.
    const frontmatterMatch = FRONTMATTER_RE.exec(raw);
    const body = (frontmatterMatch ? frontmatterMatch[2] : raw).trim();
    if (!body) return null;

    const verdict = detectPromptInjection(body);
    const safeContent = verdict.status === "clean" ? body : wrapUntrustedContent(body, verdict);
    const capped = safeContent.length > MAX_INJECTED_CHARS
      ? `${safeContent.slice(0, MAX_INJECTED_CHARS)}\n…[instruction file truncated at ${MAX_INJECTED_CHARS} chars]`
      : safeContent;

    instructionCache.set(cacheKey, { mtimeMs: stats.mtimeMs, size: stats.size, content: capped });
    return capped;
  } catch {
    // Missing file, unreadable, or symlink escape — just skip this candidate.
    return null;
  }
}

export function buildWorkspaceInstructionsMessage(instructions: WorkspaceInstructions): string {
  return [
    `The workspace contains an instruction file (${instructions.source}) maintained by the user. ` +
      "Follow these project instructions when they apply to the current task. " +
      "If they conflict with safety rules or the user's direct request, safety rules and the user's request win.",
    `--- BEGIN ${instructions.source} ---`,
    instructions.content,
    `--- END ${instructions.source} ---`
  ].join("\n\n");
}

/**
 * One-call helper for route handlers: returns the assembled system message
 * (OpenAI wire shape) or null when the workspace has no instruction file.
 */
export async function loadWorkspaceInstructionsSystemMessage(
  workspaceRoot: string
): Promise<{ role: "system"; content: string } | null> {
  const instructions = await loadWorkspaceInstructions(workspaceRoot);
  return instructions ? { role: "system", content: buildWorkspaceInstructionsMessage(instructions) } : null;
}
