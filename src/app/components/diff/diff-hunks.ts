import { diffLines } from "diff";
import type { AgentStep } from "../../../lib/agent-api";

/* Shared diff logic for every review surface (message trace, dialog,
   persisted-run checkpoints). Moved here from diff-view.tsx so the
   DiffViewer and the legacy exports share one implementation. */

export type DiffEntry = {
  id: string;
  path: string;
  before: string;
  after: string;
  lineStart?: number;
  lineEnd?: number;
  matchStrategy?: string;
  /**
   * Raw preview text for sources that carry no before/after pair
   * (e.g. persisted checkpoint `diffPreview`). Rendered as a labelled
   * fallback — diff data is never fabricated from it.
   */
  rawPreview?: string;
};

export type DiffHunkLineType = "add" | "del" | "ctx";

export type DiffHunkLine = {
  type: DiffHunkLineType;
  oldLine?: number;
  newLine?: number;
  text: string;
};

export type DiffHunk = {
  header: string;
  lines: DiffHunkLine[];
};

const HUNK_CONTEXT_LINES = 3;

/** Pull file diffs out of agent step tool results (edit-family tools only). */
export function extractDiffs(steps: AgentStep[]) {
  const diffs: DiffEntry[] = [];

  steps.forEach((step) => {
    step.toolCalls.forEach((call, index) => {
      const result = step.toolResults[index];
      if (!result?.success || !["edit_file", "replace_in_file", "append_file", "write_file", "delete_file"].includes(call.name)) {
        return;
      }

      if (typeof result.data !== "object" || result.data === null) {
        return;
      }

      const entry = extractDiffFromResult(result.data as Record<string, unknown>, call.id, step.iteration);
      if (entry) diffs.push(entry);
    });
  });

  return diffs.reverse();
}

/** Extract a single DiffEntry from a tool result's data object. Returns null if no diff data. */
export function extractDiffFromResult(
  data: Record<string, unknown> | null | undefined,
  toolCallId: string,
  iteration: number
): DiffEntry | null {
  if (!data || typeof data !== "object") return null;

  const d = data as {
    path?: string;
    matchStrategy?: string;
    lineRange?: { start?: number; end?: number };
    preview?: { before?: string | null; after?: string | null } | string;
    diff?: { before?: string | null; after?: string | null };
  };

  const preview = typeof d.preview === "object" && d.preview !== null ? d.preview : undefined;
  const before = preview?.before ?? d.diff?.before;
  const after = preview?.after ?? d.diff?.after;
  if (!d.path || (before == null && after == null)) return null;

  return {
    id: `${iteration}-${toolCallId}`,
    path: d.path,
    before: before ?? "",
    after: after ?? "",
    lineStart: d.lineRange?.start,
    lineEnd: d.lineRange?.end,
    matchStrategy: d.matchStrategy
  };
}

/** Compute line-level diff statistics from before/after strings. */
export function computeDiffStats(before: string, after: string): { added: number; removed: number } {
  const parts = diffLines(before, after);
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    if (part.added) {
      const lines = part.value.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      added += lines.length;
    } else if (part.removed) {
      const lines = part.value.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      removed += lines.length;
    }
  }
  return { added, removed };
}

/**
 * Group a before/after pair into git-style hunks: consecutive changed
 * lines clustered together, padded with up to `contextSize` unchanged
 * context lines on each side. Unchanged runs longer than 2*contextSize
 * split neighbouring changes into separate hunks.
 */
export function computeHunks(before: string, after: string, contextSize = HUNK_CONTEXT_LINES): DiffHunk[] {
  const allLines: DiffHunkLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const part of diffLines(before, after)) {
    const lines = part.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();

    for (const text of lines) {
      if (part.added) {
        newLine += 1;
        allLines.push({ type: "add", newLine, text });
      } else if (part.removed) {
        oldLine += 1;
        allLines.push({ type: "del", oldLine, text });
      } else {
        oldLine += 1;
        newLine += 1;
        allLines.push({ type: "ctx", oldLine, newLine, text });
      }
    }
  }

  const changedIndexes: number[] = [];
  allLines.forEach((line, index) => {
    if (line.type !== "ctx") changedIndexes.push(index);
  });
  if (changedIndexes.length === 0) return [];

  const clusters: Array<[number, number]> = [];
  let clusterStart = changedIndexes[0];
  let clusterEnd = changedIndexes[0];
  for (let i = 1; i < changedIndexes.length; i++) {
    const index = changedIndexes[i];
    if (index - clusterEnd > contextSize * 2) {
      clusters.push([clusterStart, clusterEnd]);
      clusterStart = index;
    }
    clusterEnd = index;
  }
  clusters.push([clusterStart, clusterEnd]);

  return clusters.map(([start, end]) => {
    const from = Math.max(0, start - contextSize);
    const to = Math.min(allLines.length - 1, end + contextSize);
    const lines = allLines.slice(from, to + 1);

    const oldLines = lines.filter((line) => line.oldLine != null);
    const newLines = lines.filter((line) => line.newLine != null);
    const oldStart = oldLines[0]?.oldLine ?? 0;
    const newStart = newLines[0]?.newLine ?? 0;

    return {
      header: `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
      lines
    };
  });
}

/** djb2 — tiny stable content hash for seen-state tracking (no new deps). */
export function hashContent(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/** Stable fingerprint of a diff entry's content, used for seen-state persistence. */
export function hashEntry(entry: DiffEntry): string {
  if (!entry.before && !entry.after && entry.rawPreview) return hashContent(entry.rawPreview);
  return hashContent(`${entry.before}\u0000${entry.after}`);
}
