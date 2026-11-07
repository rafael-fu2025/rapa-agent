import { useMemo } from "react";
import { Diff } from "lucide-react";
import type { AgentStep } from "../../lib/agent-api";
import { cn } from "../../lib/utils";
import { DiffViewer } from "./diff/diff-viewer";
import { extractDiffs } from "./diff/diff-hunks";

// Shared diff logic lives in ./diff/ now; these re-exports keep the
// historical import surface (agent-steps-viewer imports
// computeDiffStats / extractDiffFromResult from here) working.
export type { DiffEntry } from "./diff/diff-hunks";
export { computeDiffStats, extractDiffFromResult, extractDiffs } from "./diff/diff-hunks";

type DiffViewProps = {
  steps: AgentStep[];
  embedded?: boolean;
  className?: string;
};

const EMPTY_COPY =
  "No successful file edits have surfaced yet. Approval-blocked or failed edit attempts stay in the execution trace.";

export function DiffView({ steps, embedded = false, className }: DiffViewProps) {
  const diffs = useMemo(() => extractDiffs(steps), [steps]);

  const viewer = <DiffViewer entries={diffs} emptyMessage={EMPTY_COPY} className={className} />;

  if (embedded) {
    return viewer;
  }

  return (
    <div className={cn("overflow-hidden rounded-2xl border border-card-hover bg-card", className)}>
      <div className="flex items-center gap-2 border-b border-card-hover bg-card-2 px-4 py-3 text-sm text-primary">
        <Diff className="h-4 w-4 text-muted-foreground" />
        <span>Code Changes</span>
      </div>
      <div className="p-4">
        <DiffViewer entries={diffs} emptyMessage={EMPTY_COPY} />
      </div>
    </div>
  );
}
