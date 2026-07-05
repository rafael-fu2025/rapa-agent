// SKILL.md parser (Anthropic Agent Skills spec, 2025).
//
// The standard SKILL.md format is:
//   ---
//   name: my-skill
//   description: One-line summary of what this skill does.
//   context: fork      # optional — run body in a subagent
//   ---
//
//   # Title
//
//   Markdown body — instructions the agent reads before using the skill.
//
// This module:
//   1. Parses the YAML frontmatter (deliberately minimal — no YAML lib
//      dependency).
//   2. Exposes a "progressive disclosure" loader: the metadata is always
//      available, but the body is only loaded on demand (when the agent
//      explicitly activates the skill).
//   3. Normalises the parsed skill into a shape compatible with our
//      existing `AgentSkill` model so we can store standard SKILL.md files
//      alongside the proprietary-format skills already in the system.

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export type SkillMdFrontmatter = {
  name: string;
  description: string;
  /** Optional — when "fork" the body runs in a subagent. */
  context?: "fork" | undefined;
  /** Optional arbitrary key/value pairs the user can attach. */
  metadata?: Record<string, string>;
};

export type ParsedSkillMd = {
  frontmatter: SkillMdFrontmatter;
  /** The body of the file with frontmatter stripped. */
  body: string;
  /** Raw, unmodified source — useful for storing the original. */
  raw: string;
  /** Path on disk (if loaded from a file). */
  path?: string;
};

export type SkillMdParseError = {
  message: string;
  line?: number;
};

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Minimal YAML frontmatter parser — handles the subset Anthropic's spec
 * requires (flat key: value, strings, optional quoted strings, nested
 * metadata as `metadata.key: value`).
 */
function parseFrontmatter(raw: string): { data: Record<string, string>; errors: SkillMdParseError[] } {
  const data: Record<string, string> = {};
  const errors: SkillMdParseError[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) {
      errors.push({ message: `Expected "key: value" on line ${i + 1}`, line: i + 1 });
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(key)) {
      errors.push({ message: `Invalid key "${key}" on line ${i + 1}`, line: i + 1 });
      continue;
    }
    if (key === "context" && value !== "fork") {
      errors.push({ message: `Invalid "context" value on line ${i + 1} — only "fork" is allowed`, line: i + 1 });
      continue;
    }
    data[key] = unquote(value);
  }
  return { data, errors };
}

/**
 * Parse a SKILL.md source string into a typed object. Returns either a
 * valid `ParsedSkillMd` or throws a descriptive error.
 */
export function parseSkillMd(source: string, path?: string): ParsedSkillMd {
  if (!source || !source.startsWith("---")) {
    throw new Error("SKILL.md must start with YAML frontmatter delimited by ---");
  }
  const match = FRONTMATTER_RE.exec(source);
  if (!match) {
    throw new Error("SKILL.md frontmatter is missing the closing --- delimiter");
  }
  const [, frontmatterRaw, body] = match;
  const { data, errors } = parseFrontmatter(frontmatterRaw);
  if (errors.length > 0) {
    throw new Error(`SKILL.md parse errors: ${errors.map((e) => e.message).join("; ")}`);
  }
  if (!data.name) throw new Error("SKILL.md frontmatter is missing required `name`");
  if (!data.description) throw new Error("SKILL.md frontmatter is missing required `description`");
  if (!NAME_PATTERN.test(data.name)) {
    throw new Error(`SKILL.md name "${data.name}" must be kebab-case (lowercase, digits, single hyphens)`);
  }
  if (data.description.length > 1024) {
    throw new Error(`SKILL.md description is ${data.description.length} chars; max 1024`);
  }
  const frontmatter: SkillMdFrontmatter = {
    name: data.name,
    description: data.description,
    context: data.context === "fork" ? "fork" : undefined
  };
  return {
    frontmatter,
    body: body.trim(),
    raw: source,
    path
  };
}

/**
 * Load a SKILL.md file from disk. The file is parsed but the body is
 * discarded after parsing — only the metadata is returned by default.
 * This is the "progressive disclosure" half of the spec: the LLM only
 * sees the frontmatter, and the body is loaded on demand.
 */
export async function loadSkillMetadata(filePath: string): Promise<SkillMdFrontmatter> {
  const raw = await readFile(filePath, "utf-8");
  return parseSkillMd(raw, filePath).frontmatter;
}

/**
 * Load the full body of a SKILL.md file. Call this only when the agent
 * has decided to use the skill — that's the progressive-disclosure
 * cost saving.
 */
export async function loadSkillBody(filePath: string): Promise<ParsedSkillMd> {
  const raw = await readFile(filePath, "utf-8");
  return parseSkillMd(raw, filePath);
}

/**
 * Scan a directory for SKILL.md files. Returns the parsed frontmatter for
 * each one (body is not loaded — progressive disclosure).
 */
export async function discoverSkillsInDir(
  dir: string,
  options: { recursive?: boolean; maxDepth?: number } = {}
): Promise<{ path: string; skill: SkillMdFrontmatter }[]> {
  const recursive = options.recursive ?? true;
  const maxDepth = options.maxDepth ?? 3;
  const out: { path: string; skill: SkillMdFrontmatter }[] = [];

  async function walk(current: string, depth: number) {
    if (depth > maxDepth) return;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && recursive) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
        await walk(join(current, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (lower === "skill.md" || lower === "skills.md") {
          const full = join(current, entry.name);
          try {
            const skill = await loadSkillMetadata(full);
            out.push({ path: full, skill });
          } catch {
            // Skip invalid skills.
          }
        }
      }
    }
  }

  await walk(dir, 0);
  return out;
}

/**
 * Convert a parsed SKILL.md into the shape our DB wants, so we can store
 * standard-format skills alongside the proprietary format.
 */
export function skillMdToDbRecord(parsed: ParsedSkillMd): {
  name: string;
  description: string;
  body: string;
  format: "skill-md";
  context: "fork" | null;
} {
  return {
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    body: parsed.body,
    format: "skill-md",
    context: parsed.frontmatter.context ?? null
  };
}

/**
 * Pretty-print a SKILL.md file from a record. Inverse of parseSkillMd.
 */
export function stringifySkillMd(record: {
  name: string;
  description: string;
  body: string;
  context?: "fork" | null;
}): string {
  if (!NAME_PATTERN.test(record.name)) {
    throw new Error(`Invalid skill name "${record.name}"`);
  }
  const lines = ["---"];
  lines.push(`name: ${record.name}`);
  const desc = record.description.includes(":") || record.description.includes("#")
    ? `"${record.description.replace(/"/g, '\\"')}"`
    : record.description;
  lines.push(`description: ${desc}`);
  if (record.context === "fork") lines.push("context: fork");
  lines.push("---", "");
  lines.push(record.body.trim(), "");
  return lines.join("\n");
}

/**
 * Re-export extension constants for callers (e.g. UI hints).
 */
export const SKILL_MD_MAX_DESCRIPTION_CHARS = 1024;
export const SKILL_MD_FILE_NAMES = ["SKILL.md", "skill.md", "skills.md"];

/** File-system helper: does this file exist and is it a regular file? */
export async function isFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

/** Convenience for tests / debug. */
export function getExtension(path: string): string {
  return extname(path);
}

export function getBasename(path: string): string {
  return basename(path);
}
