import { useMemo, useState } from "react";
import { Filter, ChevronDown, ChevronRight } from "lucide-react";
import type { ChatMessage } from "../types/chat";
import type { AgentStep } from "../../lib/agent-api";
import { cn } from "../../lib/utils";

type ToolHistoryEntry = {
  messageId: string;
  messageIndex: number;
  iteration: number;
  name: string;
  parameters: Record<string, unknown>;
  result?: {
    success: boolean;
    error?: string;
    output?: string;
    data?: unknown;
  };
  timestamp?: string;
};

type FilterCategory = "all" | "filesystem" | "shell" | "web" | "git" | "other";

function categorizeTool(name: string): FilterCategory {
  if (["edit_file", "replace_in_file", "append_file", "write_file", "delete_file", "read_file", "read_image", "list_directory", "search_content", "rename_file", "create_directory"].includes(name)) return "filesystem";
  if (["execute_command", "start_process", "stop_process", "list_processes"].includes(name)) return "shell";
  if (["web_search", "fetch_url"].includes(name)) return "web";
  if (name.startsWith("git_")) return "git";
  return "other";
}

function getCategoryColor(cat: FilterCategory): string {
  switch (cat) {
    case "filesystem": return "text-accent-blue";
    case "shell": return "text-accent-yellow";
    case "web": return "text-accent-green";
    case "git": return "text-purple-400";
    case "other": return "text-muted-foreground";
    default: return "text-muted-foreground";
  }
}

function extractToolHistory(messages: ChatMessage[]): ToolHistoryEntry[] {
  const entries: ToolHistoryEntry[] = [];

  messages.forEach((msg, msgIdx) => {
    if (msg.role !== "assistant") return;
    const steps = msg.agentSteps;
    if (!Array.isArray(steps)) return;

    for (const step of steps as AgentStep[]) {
      if (!Array.isArray(step.toolCalls)) continue;
      for (let i = 0; i < step.toolCalls.length; i++) {
        const call = step.toolCalls[i];
        const result = step.toolResults?.[i];
        const name = call.name ?? "unknown";
        entries.push({
          messageId: msg.id,
          messageIndex: msgIdx,
          iteration: step.iteration,
          name,
          parameters: (call.parameters as Record<string, unknown>) ?? {},
          result: result
            ? {
                success: result.success === true,
                error: result.error,
                output: result.output,
                data: result.data,
              }
            : undefined,
          timestamp: step.timestamp,
        });
      }
    }
  });

  return entries;
}

type ToolHistoryContentProps = {
  messages: ChatMessage[];
};

export function ToolHistoryContent({ messages }: ToolHistoryContentProps) {
  const [filter, setFilter] = useState<FilterCategory>("all");
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const allEntries = useMemo(() => extractToolHistory(messages), [messages]);

  const filtered = useMemo(
    () => filter === "all" ? allEntries : allEntries.filter((e) => categorizeTool(e.name) === filter),
    [allEntries, filter]
  );

  const stats = useMemo(() => {
    const total = allEntries.length;
    const succeeded = allEntries.filter((e) => e.result?.success).length;
    const failed = allEntries.filter((e) => e.result?.error).length;
    return { total, succeeded, failed };
  }, [allEntries]);

  const categories: FilterCategory[] = ["all", "filesystem", "shell", "web", "git", "other"];

  return (
    <>
      {/* Stats bar */}
      <div className="px-4 pb-2">
        <p className="font-mono-tech text-[9px] text-muted-foreground/50">
          {stats.total} calls &middot; {stats.succeeded} ok &middot; {stats.failed} failed
        </p>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-1.5 border-b border-border/30 px-4 py-2">
        <Filter size={12} className="shrink-0 text-muted-foreground/50" />
        {categories.map((cat) => {
          const count = cat === "all" ? allEntries.length : allEntries.filter((e) => categorizeTool(e.name) === cat).length;
          if (cat !== "all" && count === 0) return null;
          return (
            <button
              key={cat}
              type="button"
              onClick={() => setFilter(cat)}
              className={cn(
                "rounded border px-2 py-0.5 font-mono-tech text-[9px] font-medium uppercase tracking-wider transition-colors",
                filter === cat
                  ? "border-accent-blue/40 bg-accent-blue/10 text-accent-blue"
                  : "border-border/30 text-muted-foreground/50 hover:text-muted-foreground/70"
              )}
            >
              {cat} {count > 0 && `(${count})`}
            </button>
          );
        })}
      </div>

      {/* Tool list */}
      <div className="flex-1 min-h-0 overflow-y-auto sidebar-scroll">
        {filtered.length === 0 && (
          <div className="px-4 py-8 text-center font-mono-tech text-[10px] text-muted-foreground/50">
            No tool calls found
          </div>
        )}

        {filtered.map((entry, idx) => {
          const cat = categorizeTool(entry.name);
          const isExpanded = expandedIdx === idx;
          const cmdPreview = typeof entry.parameters.command === "string"
            ? entry.parameters.command
            : undefined;
          const pathPreview = typeof entry.parameters.path === "string"
            ? entry.parameters.path
            : typeof entry.parameters.filePath === "string"
              ? entry.parameters.filePath
              : typeof entry.parameters.target_file === "string"
                ? entry.parameters.target_file
                : undefined;

          return (
            <div
              key={`${entry.messageId}-${idx}`}
              className="border-b border-border/20"
            >
              <button
                type="button"
                onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-card-hover/30"
              >
                {isExpanded ? (
                  <ChevronDown size={12} className="shrink-0 text-muted-foreground/40" />
                ) : (
                  <ChevronRight size={12} className="shrink-0 text-muted-foreground/40" />
                )}
                <code className={cn("shrink-0 font-mono-tech text-[10px] font-semibold", getCategoryColor(cat))}>
                  {entry.name}
                </code>
                <span className="min-w-0 flex-1 truncate font-mono-tech text-[9px] text-muted-foreground/50">
                  {cmdPreview ?? pathPreview ?? ""}
                </span>
                <span className={cn(
                  "shrink-0 font-mono-tech text-[8px] font-semibold uppercase",
                  entry.result?.success ? "text-accent-green/60" : entry.result?.error ? "text-accent-red/60" : "text-muted-foreground/40"
                )}>
                  {entry.result?.success ? "ok" : entry.result?.error ? "fail" : "—"}
                </span>
              </button>

              {isExpanded && (
                <div className="border-t border-border/20 bg-card-3/30 px-4 py-2 space-y-2">
                  {/* Parameters */}
                  {Object.keys(entry.parameters).length > 0 && (
                    <div>
                      <div className="mb-1 font-mono-tech text-[8px] font-semibold uppercase tracking-wider text-muted-foreground/40">Parameters</div>
                      <pre className="max-h-32 overflow-auto rounded border border-border/30 bg-card p-2 font-mono-tech text-[9px] leading-[1.5] text-muted-foreground/70">
                        {JSON.stringify(entry.parameters, null, 2)}
                      </pre>
                    </div>
                  )}

                  {/* Result */}
                  {entry.result && (
                    <div>
                      <div className="mb-1 font-mono-tech text-[8px] font-semibold uppercase tracking-wider text-muted-foreground/40">
                        Result {entry.result.success ? "(success)" : entry.result.error ? "(failed)" : ""}
                      </div>
                      {entry.result.error && (
                        <pre className="max-h-24 overflow-auto rounded border border-accent-red/20 bg-accent-red/[0.04] p-2 font-mono-tech text-[9px] leading-[1.5] text-accent-red/70">
                          {entry.result.error}
                        </pre>
                      )}
                      {entry.result.output && (
                        <pre className="max-h-32 overflow-auto rounded border border-border/30 bg-card p-2 font-mono-tech text-[9px] leading-[1.5] text-muted-foreground/70">
                          {entry.result.output.length > 2000 ? entry.result.output.slice(0, 2000) + "..." : entry.result.output}
                        </pre>
                      )}
                    </div>
                  )}

                  {/* Meta */}
                  <div className="flex items-center gap-2 font-mono-tech text-[8px] text-muted-foreground/40">
                    <span>msg #{entry.messageIndex + 1}</span>
                    <span>iter {entry.iteration}</span>
                    {entry.timestamp && <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
