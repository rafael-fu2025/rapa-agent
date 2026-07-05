import { useMemo } from "react";
import { diffLines } from "diff";
import { FileCode2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "./ui/dialog";

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
  const diffParts = useMemo(() => diffLines(before, after), [before, after]);

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
            <FileCode2 className="h-4 w-4 text-muted-foreground shrink-0" />
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

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="bg-app">
            <pre className="min-w-full p-0 text-[11px] leading-[1.6] text-primary font-mono-tech">
              {diffParts.map((part, index) => {
                const lines = part.value.split("\n");
                if (lines[lines.length - 1] === "") {
                  lines.pop();
                }

                return lines.map((line, lineIndex) => {
                  const key = `${index}-${lineIndex}`;
                  const prefix = part.added ? "+" : part.removed ? "-" : " ";
                  const rowClass = part.added
                    ? "bg-accent-green/[0.08] text-accent-green font-medium"
                    : part.removed
                      ? "bg-accent-red/[0.06] text-accent-red line-through opacity-80"
                      : "bg-transparent text-muted-foreground";

                  return (
                    <div key={key} className={`grid grid-cols-[36px_1fr] px-4 ${rowClass}`}>
                      <span className="select-none text-muted-foreground">{prefix}</span>
                      <span className="whitespace-pre-wrap break-words">{line || " "}</span>
                    </div>
                  );
                });
              })}
            </pre>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
