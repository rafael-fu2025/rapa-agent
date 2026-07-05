import { useState, useEffect, useCallback } from "react";
import { FileCode2, Loader2, Eye, Code } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "./ui/dialog";
import { cn } from "../../lib/utils";
import { getWorkspaceFileContent, type WorkspaceFileContent } from "../../lib/workspace-api";

type ViewMode = "raw" | "preview";

type FileViewerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  filePath: string;
};

function isMarkdown(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ext === "md" || ext === "mdx";
}

export function FileViewerDialog({
  open,
  onOpenChange,
  workspaceId,
  filePath
}: FileViewerDialogProps) {
  const [data, setData] = useState<WorkspaceFileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("preview");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getWorkspaceFileContent(workspaceId, filePath);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read file");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, filePath]);

  useEffect(() => {
    if (open) {
      setViewMode("preview");
      void load();
    } else {
      setData(null);
      setError(null);
    }
  }, [open, load]);

  const md = isMarkdown(filePath);
  const fileName = filePath.split(/[/\\]/).pop() ?? filePath;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="dialog-panel sm:max-w-[720px] max-h-[80vh] flex flex-col gap-0 p-0 overflow-hidden"
        aria-label={`File viewer for ${fileName}`}
      >
        <DialogHeader className="border-b border-border/40 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 font-mono-tech text-[11px] font-semibold normal-case tracking-normal">
            <FileCode2 className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="truncate">{filePath}</span>
          </DialogTitle>
          <DialogDescription className="flex items-center gap-3 font-mono-tech text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
            {data && <span>{data.lines} lines</span>}
            {data && <span>{(data.size / 1024).toFixed(1)} KB</span>}
            {md && (
              <div className="ml-auto flex items-center rounded border border-border/40 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setViewMode("preview")}
                  className={cn(
                    "flex items-center gap-1 px-1.5 py-0.5 font-mono-tech text-[9px] transition-colors",
                    viewMode === "preview"
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  title="Preview"
                >
                  <Eye size={10} />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("raw")}
                  className={cn(
                    "flex items-center gap-1 px-1.5 py-0.5 font-mono-tech text-[9px] transition-colors",
                    viewMode === "raw"
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  title="Raw"
                >
                  <Code size={10} />
                </button>
              </div>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-10">
              <Loader2 size={18} className="animate-spin text-muted-foreground/40" />
            </div>
          )}

          {error && (
            <div className="px-4 py-6 text-center">
              <p className="font-mono-tech text-[11px] text-accent-red/70">{error}</p>
              <button
                type="button"
                onClick={() => { void load(); }}
                className="mt-2 rounded border border-border/40 px-3 py-1 font-mono-tech text-[10px] text-muted-foreground transition-colors hover:bg-accent/30"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && data && md && viewMode === "preview" && (
            <div className="markdown-preview px-5 py-4 font-mono-tech text-[11px] leading-[1.7] text-foreground/80">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {data.content}
              </ReactMarkdown>
            </div>
          )}

          {!loading && !error && data && (viewMode === "raw" || !md) && (
            <div className="bg-app">
              <pre className="min-w-full p-0 text-[11px] leading-[1.6] text-primary font-mono-tech">
                {data.content.split("\n").map((line, i) => (
                  <div key={i} className="grid grid-cols-[36px_1fr] px-4 hover:bg-accent/10">
                    <span className="select-none text-right font-mono-tech text-[10px] text-muted-foreground/30">
                      {i + 1}
                    </span>
                    <span className="whitespace-pre-wrap break-words px-2 font-mono-tech text-[11px] text-foreground/80">
                      {line || " "}
                    </span>
                  </div>
                ))}
              </pre>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
