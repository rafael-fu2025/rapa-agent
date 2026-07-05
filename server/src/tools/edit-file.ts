import { readFile, writeFile } from "node:fs/promises";
import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { Suggest } from "../lib/suggestions.js";
import {
  filesystemInternals,
  isWithinWorkspace,
  resolveWorkspacePath,
  toWorkspaceRelativePath
} from "./filesystem.js";

type MatchStrategy = "exact" | "normalized_line_endings" | "whitespace_fuzzy";

type ReplacementMatch = {
  startIndex: number;
  endIndex: number;
  matchedText: string;
  strategy: MatchStrategy;
};

function buildWhitespaceFlexibleRegExp(oldText: string) {
  const fragments = oldText
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => filesystemInternals.escapeRegExp(part));

  if (fragments.length === 0) {
    return null;
  }

  return new RegExp(fragments.join("\\s+"), "g");
}

function applyNormalizedReplacement(content: string, oldText: string, newText: string) {
  const usesCrLf = content.includes("\r\n");
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const normalizedOld = oldText.replace(/\r\n/g, "\n");
  const normalizedNew = newText.replace(/\r\n/g, "\n");
  const occurrenceIndexes = filesystemInternals.collectOccurrences(normalizedContent, normalizedOld);

  if (occurrenceIndexes.length !== 1) {
    return null;
  }

  const replaced = normalizedContent.replace(normalizedOld, normalizedNew);
  return {
    match: {
      startIndex: occurrenceIndexes[0],
      endIndex: occurrenceIndexes[0] + normalizedOld.length,
      matchedText: normalizedOld,
      strategy: "normalized_line_endings" as const
    },
    updatedContent: usesCrLf ? replaced.replace(/\n/g, "\r\n") : replaced
  };
}

function applyWhitespaceReplacement(content: string, oldText: string, newText: string) {
  const regex = buildWhitespaceFlexibleRegExp(oldText);
  if (!regex) return null;

  const matches = Array.from(content.matchAll(regex));
  if (matches.length !== 1 || matches[0].index === undefined) {
    return null;
  }

  const match = matches[0];
  const startIndex = match.index;
  const endIndex = startIndex + match[0].length;

  return {
    match: {
      startIndex,
      endIndex,
      matchedText: match[0],
      strategy: "whitespace_fuzzy" as const
    },
    updatedContent: `${content.slice(0, startIndex)}${newText}${content.slice(endIndex)}`
  };
}

function getLineOffsets(content: string, startLine?: number, endLine?: number) {
  const lines = content.split(/\r?\n/);
  const sLine = startLine !== undefined ? Math.min(startLine, lines.length) : 1;
  const eLine = endLine !== undefined ? Math.min(endLine, lines.length) : lines.length;

  let startOffset = 0;
  for (let i = 0; i < sLine - 1; i++) {
    startOffset += lines[i].length + (content.includes("\r\n") ? 2 : 1);
  }

  let endOffset = startOffset;
  for (let i = sLine - 1; i < eLine; i++) {
    endOffset += lines[i].length + (content.includes("\r\n") ? 2 : 1);
  }

  endOffset = Math.min(endOffset, content.length);

  return { startOffset, endOffset };
}

function resolveReplacement(
  content: string,
  oldText: string,
  newText: string,
  startLine?: number,
  endLine?: number,
  replaceGlobally: boolean = false
) {
  let searchContent = content;
  let offset = 0;

  if (startLine !== undefined || endLine !== undefined) {
    const { startOffset, endOffset } = getLineOffsets(content, startLine, endLine);
    searchContent = content.slice(startOffset, endOffset);
    offset = startOffset;
  }

  const exactMatches = filesystemInternals.collectOccurrences(searchContent, oldText);
  if (exactMatches.length >= 1 && replaceGlobally) {
    // Replace every occurrence in the scoped range.
    const firstIdx = exactMatches[0];
    const lastIdx = exactMatches[exactMatches.length - 1];
    const globalStart = offset + firstIdx;
    const globalEnd = offset + lastIdx + oldText.length;
    const between = searchContent.slice(0, lastIdx).slice(firstIdx + oldText.length);
    const updatedContent = `${content.slice(0, globalStart)}${newText}${between.replaceAll(oldText, newText)}${content.slice(globalEnd)}`;
    return {
      match: {
        startIndex: globalStart,
        endIndex: globalEnd,
        matchedText: oldText,
        strategy: "exact" as const
      },
      updatedContent,
      replacementCount: exactMatches.length
    };
  }

  if (exactMatches.length === 1) {
    const startIdx = exactMatches[0];
    const globalStart = offset + startIdx;
    const globalEnd = globalStart + oldText.length;
    return {
      match: {
        startIndex: globalStart,
        endIndex: globalEnd,
        matchedText: oldText,
        strategy: "exact" as const
      },
      updatedContent: `${content.slice(0, globalStart)}${newText}${content.slice(globalEnd)}`
    };
  }

  if (exactMatches.length > 1) {
    return { error: `Edit aborted: found ${exactMatches.length} exact matches in the specified range. Include more surrounding context to make oldText unique, or pass replaceGlobally: true to replace all of them.` };
  }

  const normalized = applyNormalizedReplacement(searchContent, oldText, newText);
  if (normalized) {
    const globalStart = offset + normalized.match.startIndex;
    const globalEnd = offset + normalized.match.endIndex;
    const replaced = content.slice(0, globalStart) + newText + content.slice(globalEnd);
    return {
      match: {
        startIndex: globalStart,
        endIndex: globalEnd,
        matchedText: normalized.match.matchedText,
        strategy: "normalized_line_endings" as const
      },
      updatedContent: replaced
    };
  }

  const whitespace = applyWhitespaceReplacement(searchContent, oldText, newText);
  if (whitespace) {
    const globalStart = offset + whitespace.match.startIndex;
    const globalEnd = offset + whitespace.match.endIndex;
    const replaced = content.slice(0, globalStart) + newText + content.slice(globalEnd);
    return {
      match: {
        startIndex: globalStart,
        endIndex: globalEnd,
        matchedText: whitespace.match.matchedText,
        strategy: "whitespace_fuzzy" as const
      },
      updatedContent: replaced
    };
  }

  return {
    error: "Edit aborted: target text was not found in the specified range.",
    hint: buildClosestLineHint(content, oldText, startLine ?? 1, endLine ?? content.split(/\r?\n/).length)
  };
}

function buildClosestLineHint(content: string, oldText: string, startLine: number, endLine: number): string {
  const lines = content.split(/\r?\n/);
  const oldTextLines = oldText.split(/\r?\n/);
  const firstLine = oldTextLines[0] ?? "";
  const lastLine = oldTextLines[oldTextLines.length - 1] ?? "";

  // Find a line in the file that is most similar to oldText's first line
  // (most whitespace/typo-tolerant edits start with a recognizable anchor).
  let bestIndex = -1;
  let bestScore = -1;
  const lower = firstLine.toLowerCase().trim();
  const lowerLast = lastLine.toLowerCase().trim();

  const rangeStart = Math.max(1, startLine) - 1;
  const rangeEnd = Math.min(lines.length, endLine);

  for (let i = rangeStart; i < rangeEnd; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.toLowerCase().trim();
    if (trimmed.length === 0) continue;

    let score = 0;
    if (lower && trimmed.includes(lower)) {
      score = 100 + (lower.length / Math.max(trimmed.length, 1)) * 20;
    } else if (lower && trimmed.includes(lower.slice(0, Math.min(20, lower.length)))) {
      score = 60;
    } else {
      // Cheap similarity: shared character bigrams
      const a = new Set<string>();
      const b = new Set<string>();
      for (let j = 0; j < trimmed.length - 1; j += 1) a.add(trimmed.slice(j, j + 2));
      for (let j = 0; j < lower.length - 1; j += 1) b.add(lower.slice(j, j + 2));
      let shared = 0;
      for (const g of a) if (b.has(g)) shared += 1;
      score = shared * 2;
      if (lowerLast && trimmed.includes(lowerLast.slice(0, Math.min(20, lowerLast.length)))) score += 30;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestIndex < 0) return "";

  // Cap to a focused 8-line window around the best match (Aider's "did you mean" pattern).
  // A 20-line oldText would otherwise produce a 24-line hint that drowns the actual error.
  const anchorLineCount = Math.min(oldTextLines.length, 4);
  const minLine = Math.max(1, bestIndex - 2);
  const maxLine = Math.min(lines.length, bestIndex + anchorLineCount + 2);
  const snippet = lines
    .slice(minLine - 1, maxLine)
    .map((l, i) => `${minLine + i}: ${l}`)
    .join("\n");
  return `Closest match in file (line ${bestIndex + 1}):\n${snippet}`;
}

function buildPreview(content: string, match: ReplacementMatch, newText: string) {
  const previewRadius = 160;
  const beforeStart = Math.max(0, match.startIndex - previewRadius);
  const beforeEnd = Math.min(content.length, match.endIndex + previewRadius);
  const before = content.slice(beforeStart, beforeEnd);
  const after = `${content.slice(beforeStart, match.startIndex)}${newText}${content.slice(match.endIndex, beforeEnd)}`;

  return { before, after };
}

class BaseEditFileTool extends Tool {
  definition: ToolDefinition;

  constructor(name: string, description: string) {
    super();
    this.definition = {
      name,
      description,
      category: "code",
      requiresApproval: true,
      parameters: {
        path: {
          type: "string",
          description: "Relative path to the file from workspace root",
          required: true
        },
        oldText: {
          type: "string",
          description: "Existing text to replace",
          required: true
        },
        newText: {
          type: "string",
          description: "Replacement text",
          required: true
        },
        startLine: {
          type: "number",
          description: "Optional line number where the target block starts (1-based, inclusive)",
          required: false
        },
        endLine: {
          type: "number",
          description: "Optional line number where the target block ends (1-based, inclusive)",
          required: false
        },
        replaceGlobally: {
          type: "boolean",
          description: "Replace every occurrence of oldText in the scoped range. Default: false (require unique match).",
          required: false
        }
      }
    };
  }

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const pathValue = params.path as string;
    const oldText = params.oldText as string;
    const newText = params.newText as string;
    const startLine = typeof params.startLine === "number" ? Math.max(1, Math.floor(params.startLine)) : undefined;
    const endLine = typeof params.endLine === "number" ? Math.max(1, Math.floor(params.endLine)) : undefined;
    const replaceGlobally = params.replaceGlobally === true;
    const fullPath = resolveWorkspacePath(pathValue, context.workspaceRoot);

    if (!oldText) {
      return Suggest.generic(
        { success: false, error: "Edit aborted: oldText must not be empty." },
        "Provide non-empty `oldText` matching the exact text in the file (whitespace, indentation, line endings all count)."
      );
    }

    if (!isWithinWorkspace(fullPath, context.workspaceRoot)) {
      return {
        success: false,
        error: "Access denied: path is outside workspace"
      };
    }

    try {
      const content = await readFile(fullPath, "utf-8");
      const replacement = resolveReplacement(content, oldText, newText, startLine, endLine, replaceGlobally);

      if ("error" in replacement) {
        let recoveryContext = "";
        try {
          const lines = content.split(/\r?\n/);

          if ("hint" in replacement && replacement.hint) {
            // Use the targeted closest-line hint when available (much more useful than the first 30 lines).
            recoveryContext = `\n\n${replacement.hint}`;
          } else if (startLine !== undefined || endLine !== undefined) {
            const minLine = Math.max(1, (startLine ?? 1) - 5);
            const maxLine = Math.min(lines.length, (endLine ?? lines.length) + 5);
            const snippet = lines
              .slice(minLine - 1, maxLine)
              .map((l, i) => `${minLine + i}: ${l}`)
              .join("\n");
            recoveryContext = `\n\nExisting lines around requested range (${startLine ?? 1}-${endLine ?? lines.length}):\n${snippet}`;
          } else {
            const sample = lines.slice(0, 30).map((l, i) => `${i + 1}: ${l}`).join("\n");
            recoveryContext = `\n\nFirst 30 lines of the file:\n${sample}`;
          }
        } catch {
          // ignore
        }

        // Aider-style reflection: echo the failed SEARCH/REPLACE block so the model can
        // see exactly what it tried to match against the actual file content.
        const oldTextPreview = oldText.length > 800
          ? `${oldText.slice(0, 800)}\n…(${oldText.length - 800} more chars)`
          : oldText;
        const newTextPreview = newText.length > 400
          ? `${newText.slice(0, 400)}\n…(${newText.length - 400} more chars)`
          : newText;
        const searchBlock = [
          "\n\nFailing SEARCH/REPLACE block (what you asked the tool to match):",
          "<<<<<<< SEARCH",
          oldTextPreview,
          "=======",
          newTextPreview,
          ">>>>>>> REPLACE"
        ].join("\n");

        return Suggest.editNotFound(
          {
            success: false,
            error: `${replacement.error}${recoveryContext}${searchBlock}\nAction: re-read_file the section, then retry with byte-exact oldText (whitespace, indentation, line endings). If the same content appears multiple times, add surrounding context to disambiguate, or pass replaceGlobally: true.`
          },
          oldText
        );
      }

      await writeFile(fullPath, replacement.updatedContent, "utf-8");

      const matchedStartLine = filesystemInternals.countLineNumberAtIndex(content, replacement.match.startIndex);
      const matchedEndLine = filesystemInternals.countLineNumberAtIndex(content, replacement.match.endIndex);
      const preview = buildPreview(content, replacement.match, newText);
      const replacementCount = "replacementCount" in replacement ? replacement.replacementCount ?? 1 : 1;

      return {
        success: true,
        data: {
          path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
          fullPath,
          bytesWritten: Buffer.byteLength(replacement.updatedContent),
          fileSize: Buffer.byteLength(replacement.updatedContent),
          matchStrategy: replacement.match.strategy,
          lineRange: {
            start: matchedStartLine,
            end: matchedEndLine
          },
          replacementCount,
          diff: {
            before: replacement.match.matchedText,
            after: newText
          },
          preview
        }
      };

    } catch (error) {
      const errorMessage = filesystemInternals.toFileError(error, "Failed to edit file");
      if (/ENOENT|no such file/i.test(errorMessage)) {
        return Suggest.fileNotFound({ success: false, error: errorMessage }, pathValue);
      }
      if (/EACCES|permission denied/i.test(errorMessage)) {
        return Suggest.permissionDenied({ success: false, error: errorMessage }, pathValue);
      }
      return Suggest.generic(
        { success: false, error: errorMessage },
        "Re-read the file with read_file to confirm its current state, then retry."
      );
    }
  }
}

export class EditFileTool extends BaseEditFileTool {
  constructor() {
    super("edit_file", "Perform a surgical text replacement in a workspace file");
  }
}

export class ReplaceInFileTool extends BaseEditFileTool {
  constructor() {
    super("replace_in_file", "Alias for edit_file that performs a surgical text replacement in a workspace file");
  }
}

export class AppendFileTool extends Tool {
  definition: ToolDefinition = {
    name: "append_file",
    description: "Append text to the end of an existing workspace file without rewriting the whole file",
    category: "code",
    requiresApproval: true,
    parameters: {
      path: {
        type: "string",
        description: "Relative path to the file from workspace root",
        required: true
      },
      content: {
        type: "string",
        description: "Text to append to the file",
        required: true
      },
      ensureNewline: {
        type: "boolean",
        description: "Whether to insert a newline before the appended text when the file does not already end with one (default: true)",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const pathValue = params.path as string;
    const appendContent = params.content as string;
    const ensureNewline = (params.ensureNewline as boolean | undefined) ?? true;
    const fullPath = resolveWorkspacePath(pathValue, context.workspaceRoot);

    if (!appendContent) {
      return {
        success: false,
        error: "Append aborted: content must not be empty."
      };
    }

    if (!isWithinWorkspace(fullPath, context.workspaceRoot)) {
      return {
        success: false,
        error: "Access denied: path is outside workspace"
      };
    }

    try {
      const currentContent = await readFile(fullPath, "utf-8");
      const separator = ensureNewline && currentContent.length > 0 && !currentContent.endsWith("\n") ? "\n" : "";
      const nextContent = `${currentContent}${separator}${appendContent}`;
      await writeFile(fullPath, nextContent, "utf-8");

      const startLine = filesystemInternals.countLineNumberAtIndex(currentContent, currentContent.length);
      const appendedBytes = Buffer.byteLength(`${separator}${appendContent}`);

      const appendedText = `${separator}${appendContent}`;

      return {
        success: true,
        data: {
          path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
          fullPath,
          bytesAppended: appendedBytes,
          bytesWritten: Buffer.byteLength(nextContent),
          fileSize: Buffer.byteLength(nextContent),
          lineRange: {
            start: startLine,
            end: startLine + appendContent.split(/\r?\n/).length - 1
          },
          diff: {
            before: "",
            after: appendedText
          },
          preview: {
            before: "",
            after: appendedText.slice(0, 1000)
          }
        }
      };
    } catch (error) {
      return {
        success: false,
        error: filesystemInternals.toFileError(error, "Failed to append file")
      };
    }
  }
}

