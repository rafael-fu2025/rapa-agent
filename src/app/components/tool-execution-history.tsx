import { useMemo, useState } from "react";
import {
  History,
  FolderOpen,
  Terminal,
  Globe,
  Settings,
  Code,
  Wrench,
  Bot,
  ChevronDown,
  ChevronRight,
  Undo2,
  CheckCircle2,
  XCircle,
  Loader2,
  Trash2,
  Filter
} from "lucide-react";
import { cn } from "../../lib/utils";
import {
  type ToolExecution,
  type ToolCategory,
  formatRelativeTime,
  filterExecutionsByCategory,
  sortExecutionsByTime
} from "../../lib/tool-history";

export type { ToolExecution };

export type ToolExecutionHistoryProps = {
  executions: ToolExecution[];
  onUndo: (executionId: string) => void;
  onClearHistory?: () => void;
  className?: string;
};

const CATEGORY_OPTIONS: { value: ToolCategory | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "filesystem", label: "Filesystem" },
  { value: "shell", label: "Shell" },
  { value: "web", label: "Web" },
  { value: "system", label: "System" },
  { value: "code", label: "Code" },
  { value: "agent", label: "Agent" }
];

function CategoryIcon({ category, className }: { category: ToolCategory; className?: string }) {
  const iconClass = cn("h-4 w-4", className);
  
  switch (category) {
    case "filesystem":
      return <FolderOpen className={iconClass} />;
    case "shell":
      return <Terminal className={iconClass} />;
    case "web":
      return <Globe className={iconClass} />;
    case "system":
      return <Settings className={iconClass} />;
    case "code":
      return <Code className={iconClass} />;
    case "agent":
      return <Bot className={iconClass} />;
    default:
      return <Wrench className={iconClass} />;
  }
}

function StatusBadge({ status }: { status: ToolExecution["status"] }) {
  // Strict B/W/grey palette. Each status is differentiated by
  // border-weight + filled-vs-outline, not by hue. This stops a
  // "successful" or "error" tint from sticking in the user's eye.
  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-card-strong bg-card-2 text-primary px-2 py-0.5 text-[10px] font-semibold">
        <CheckCircle2 className="h-3 w-3" />
        Success
      </span>
    );
  }

  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-card-strong bg-card text-primary px-2 py-0.5 text-[10px] font-semibold">
        <XCircle className="h-3 w-3" />
        Error
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-card-hover bg-card text-muted-foreground px-2 py-0.5 text-[10px] font-medium">
      <Loader2 className="h-3 w-3 animate-spin" />
      Pending
    </span>
  );
}

function ExecutionItem({
  execution,
  onUndo
}: {
  execution: ToolExecution;
  onUndo: (id: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  const canUndo = execution.undoable && !execution.undone && execution.status === "success";

  return (
    <div
      className={cn(
        "rounded-[10px] border border-card-hover bg-card-2 transition-colors",
        execution.undone && "opacity-50"
      )}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        {/* Category Icon */}
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-card-hover bg-card text-muted-foreground">
          <CategoryIcon category={execution.category} />
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-medium text-primary">
              {execution.toolName}
            </span>
            <StatusBadge status={execution.status} />
            {execution.undone && (
              <span className="rounded-full bg-card border border-card-hover px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                Undone
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {formatRelativeTime(execution.timestamp)}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5">
          {canUndo && (
            <button
              onClick={() => onUndo(execution.id)}
              className="flex h-7 items-center gap-1 rounded-lg border border-card-hover bg-card px-2 text-[10px] font-medium text-primary transition-colors hover:border-card-strong hover:bg-card-2"
            >
              <Undo2 className="h-3 w-3" />
              Undo
            </button>
          )}
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-primary"
          >
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="border-t border-card-hover px-3 py-2.5">
          <div className="space-y-2">
            {/* Parameters */}
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Parameters
              </div>
              <pre className="overflow-x-auto rounded-[10px] bg-card border border-card-hover p-2 text-[10px] leading-4 text-primary">
                {JSON.stringify(execution.params, null, 2)}
              </pre>
            </div>

            {/* Result */}
            {execution.result !== undefined && (
              <div>
                <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  Result
                </div>
                <pre className="max-h-40 overflow-auto rounded-lg bg-card border border-card-hover p-2 text-[10px] text-primary [scrollbar-width:thin] [scrollbar-color:hsl(var(--muted))_transparent]">
                  {typeof execution.result === "string"
                    ? execution.result
                    : JSON.stringify(execution.result, null, 2)}
                </pre>
              </div>
            )}

            {/* Previous Content (for undoable operations) */}
            {execution.previousContent !== undefined && (
              <div>
                <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  Previous Content (for undo)
                </div>
                <pre className="max-h-32 overflow-auto rounded-[10px] bg-card border border-card-hover p-2 text-[10px] leading-4 text-primary [scrollbar-width:thin] [scrollbar-color:hsl(var(--muted))_transparent]">
                  {execution.previousContent || "(empty file)"}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ToolExecutionHistory({
  executions,
  onUndo,
  onClearHistory,
  className
}: ToolExecutionHistoryProps) {
  const [categoryFilter, setCategoryFilter] = useState<ToolCategory | "all">("all");

  const filteredExecutions = useMemo(() => {
    const filtered = filterExecutionsByCategory(executions, categoryFilter);
    return sortExecutionsByTime(filtered);
  }, [executions, categoryFilter]);

  const undoableCount = useMemo(
    () => executions.filter((e) => e.undoable && !e.undone && e.status === "success").length,
    [executions]
  );

  const content = filteredExecutions.length === 0 ? (
    <div className="rounded-[10px] border border-dashed border-card-hover bg-card px-3 py-5 text-center text-[11px] leading-5 text-muted-foreground">
      {executions.length === 0
        ? "No tool executions yet. Tool calls will appear here as the agent runs."
        : "No executions match the selected filter."}
    </div>
  ) : (
    <div className="max-h-[400px] space-y-2 overflow-y-auto pr-1 [scrollbar-width:thin] [scrollbar-color:hsl(var(--muted))_transparent] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:bg-card-hover [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent">
      {filteredExecutions.map((execution) => (
        <ExecutionItem
          key={execution.id}
          execution={execution}
          onUndo={onUndo}
        />
      ))}
    </div>
  );

  return (
    <div className={cn("my-2 overflow-hidden rounded-[10px] border border-card-hover bg-app", className)}>
      {/* Header */}
      <div className="border-b border-card-hover bg-app px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-medium text-primary">
              <History className="h-3 w-3 text-muted-foreground" />
              Tool History
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              Track tool executions and undo file operations.
            </div>
          </div>
          {undoableCount > 0 ? (
            <span className="rounded-full border border-card-strong bg-card-2 px-2 py-0.5 text-[10px] font-semibold text-primary">
              {undoableCount} undoable
            </span>
          ) : executions.length > 0 ? (
            <span className="rounded-full border border-card-hover bg-card-2 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {executions.length}
            </span>
          ) : null}
        </div>
      </div>

      {/* Content */}
      <div className="space-y-2 p-3">
        {/* Filter Bar */}
        {executions.length > 0 && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Filter className="h-3.5 w-3.5 text-muted-foreground" />
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value as ToolCategory | "all")}
                className="rounded-lg border border-card-hover bg-card px-2 py-1.5 text-[10px] text-primary outline-none transition-colors hover:border-card-strong focus:border-card"
              >
                {CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            {onClearHistory && executions.length > 0 && (
              <button
                onClick={onClearHistory}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-card hover:text-primary"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
          </div>
        )}

        {content}
      </div>
    </div>
  );
}
