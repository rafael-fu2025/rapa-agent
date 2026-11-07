import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "./ui/dialog";
import { FileTypeIcon } from "./file-type-icon";
import { DiffViewer } from "./diff/diff-viewer";
import type { DiffEntry } from "./diff/diff-hunks";

type DiffDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  before: string;
  after: string;
  lineStart?: number;
  lineEnd?: number;
  matchStrategy?: string;
};

// Props surface is locked to agent-steps-viewer.tsx (lazy import):
// <DiffDialog open onOpenChange filePath before after lineStart lineEnd matchStrategy />
export function DiffDialog({
  open,
  onOpenChange,
  filePath,
  before,
  after,
  lineStart,
  lineEnd,
  matchStrategy
}: DiffDialogProps) {
  const entry = useMemo<DiffEntry>(
    () => ({ id: "diff-dialog", path: filePath, before, after, lineStart, lineEnd, matchStrategy }),
    [filePath, before, after, lineStart, lineEnd, matchStrategy]
  );

  const fileName = filePath.split("/").pop() ?? filePath;
  const lineLabel =
    lineStart && lineEnd
      ? lineStart === lineEnd
        ? `line ${lineStart}`
        : `lines ${lineStart}-${lineEnd}`
      : lineStart
        ? `line ${lineStart}`
        : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="dialog-panel sm:max-w-[720px] max-h-[80vh] flex flex-col gap-0 p-0 overflow-hidden"
        aria-label={`Code changes for ${fileName}`}
      >
        <DialogHeader className="border-b border-border/40 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 font-mono-tech text-[11px] font-semibold normal-case tracking-normal">
            <FileTypeIcon name={fileName} className="h-4 w-4 shrink-0" />
            <span className="truncate">{filePath}</span>
          </DialogTitle>
          <DialogDescription className="flex items-center gap-3 font-mono-tech text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
            {lineLabel && <span>{lineLabel}</span>}
            {matchStrategy && (
              <span className="rounded border border-border/40 bg-card-3 px-1.5 py-0.5">
                {matchStrategy}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          <DiffViewer entries={[entry]} tone="color" className="h-full min-h-0 flex-1 border-0" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
