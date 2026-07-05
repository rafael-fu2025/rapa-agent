import { useMemo } from "react";
import { Diff, FileCode2 } from "lucide-react";
import { diffLines } from "diff";
import type { AgentStep } from "../../lib/agent-api";
import { cn } from "../../lib/utils";

export type DiffEntry = {
  id: string;
  path: string;
  before: string;
  after: string;
  lineStart?: number;
  lineEnd?: number;
  matchStrategy?: string;
};

type DiffViewProps = {
  steps: AgentStep[];
  embedded?: boolean;
  className?: string;
};

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

      const data = result.data as {
        path?: string;
        matchStrategy?: string;
        lineRange?: { start?: number; end?: number };
        preview?: { before?: string | null; after?: string | null } | string;
        diff?: { before?: string | null; after?: string | null };
      };

      const preview = typeof data.preview === "object" && data.preview !== null ? data.preview : undefined;
      const before = preview?.before ?? data.diff?.before;
      const after = preview?.after ?? data.diff?.after;
      if (!data.path || (before == null && after == null)) {
        return;
      }


      diffs.push({
        id: `${step.iteration}-${call.id}`,
        path: data.path,
        before: before ?? "",
        after: after ?? "",
        lineStart: data.lineRange?.start,
        lineEnd: data.lineRange?.end,
        matchStrategy: data.matchStrategy
      });
    });
  });

  return diffs.reverse();
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

export function DiffView({ steps, embedded = false, className }: DiffViewProps) {
  const diffs = useMemo(() => extractDiffs(steps), [steps]);

  const content = diffs.length === 0 ? (
    <div className="rounded-xl border border-dashed border-card-hover bg-app px-4 py-6 text-sm leading-6 text-muted-foreground">
      No successful file edits have surfaced yet. Approval-blocked or failed edit attempts stay in the execution trace.
    </div>
  ) : (
    diffs.map((entry) => (
      <div key={entry.id} className="overflow-hidden rounded-xl border border-card-hover bg-card-2">
        <div className="flex items-center gap-2 border-b border-card-hover bg-card-2 px-4 py-3 text-sm text-primary">
          <FileCode2 className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{entry.path}</span>
          {(entry.lineStart || entry.lineEnd) && (
            <span className="text-xs text-muted-foreground">
              {entry.lineStart === entry.lineEnd || !entry.lineEnd
                ? `line ${entry.lineStart}`
                : `lines ${entry.lineStart}-${entry.lineEnd}`}
            </span>
          )}
          {entry.matchStrategy ? <span className="ml-auto text-xs text-muted-foreground">{entry.matchStrategy}</span> : null}
        </div>

        <div className="overflow-x-auto bg-app">
          <pre className="min-w-full p-0 text-[12px] leading-6 text-primary">
            {diffLines(entry.before, entry.after).map((part, index) => {
              const lines = part.value.split("\n");
              if (lines[lines.length - 1] === "") {
                lines.pop();
              }

              return lines.map((line, lineIndex) => {
                const key = `${entry.id}-${index}-${lineIndex}`;
                const prefix = part.added ? "+" : part.removed ? "-" : " ";
                // Strict B/W/grey palette. Added/removed rows are
                // differentiated by background opacity (full vs.
                // reduced), not by green/red tint.
                const rowClass = part.added
                  ? "bg-card text-primary font-medium"
                  : part.removed
                    ? "bg-card-3 text-muted-foreground line-through opacity-70"
                    : "bg-transparent text-muted-foreground";

                return (
                  <div key={key} className={`grid grid-cols-[40px_1fr] px-3 ${rowClass}`}>
                    <span className="select-none text-muted-foreground">{prefix}</span>
                    <span className="whitespace-pre-wrap break-words">{line || " "}</span>
                  </div>
                );
              });
            })}
          </pre>
        </div>
      </div>
    ))
  );

  if (embedded) {
    return <div className={cn("space-y-4", className)}>{content}</div>;
  }

  return (
    <div className={cn("overflow-hidden rounded-2xl border border-card-hover bg-card", className)}>
      <div className="flex items-center gap-2 border-b border-card-hover bg-card-2 px-4 py-3 text-sm text-primary">
        <Diff className="h-4 w-4 text-muted-foreground" />
        <span>Code Changes</span>
      </div>
      <div className="space-y-4 p-4">{content}</div>
    </div>
  );
}
