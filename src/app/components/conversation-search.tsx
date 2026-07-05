import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X, MessageSquare, Wrench } from "lucide-react";
import type { ChatMessage } from "../types/chat";
import type { AgentStep } from "../../lib/agent-api";
import { cn } from "../../lib/utils";

type SearchResult = {
  messageId: string;
  messageIndex: number;
  role: "user" | "assistant";
  matchType: "content" | "tool_name" | "tool_param" | "tool_result";
  matchText: string;
  context: string;
};

type ConversationSearchProps = {
  messages: ChatMessage[];
  open: boolean;
  onClose: () => void;
  onNavigate: (messageId: string) => void;
};

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-accent-yellow/30 text-foreground rounded px-0.5">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

function getContextSnippet(text: string, query: string, maxLen = 120): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, maxLen);
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + query.length + 80);
  const snippet = text.slice(start, end);
  return (start > 0 ? "..." : "") + snippet + (end < text.length ? "..." : "");
}

function searchToolResults(
  steps: AgentStep[],
  query: string,
  messageId: string,
  messageIndex: number,
  role: "user" | "assistant"
): SearchResult[] {
  const results: SearchResult[] = [];
  const q = query.toLowerCase();

  for (const step of steps) {
    for (let i = 0; i < step.toolCalls.length; i++) {
      const call = step.toolCalls[i];
      const result = step.toolResults[i];
      const name = call.name ?? "";

      if (name.toLowerCase().includes(q)) {
        results.push({
          messageId,
          messageIndex,
          role,
          matchType: "tool_name",
          matchText: name,
          context: `${name}(${JSON.stringify(call.parameters ?? {}).slice(0, 80)})`,
        });
      }

      const paramsStr = JSON.stringify(call.parameters ?? {});
      if (paramsStr.toLowerCase().includes(q)) {
        results.push({
          messageId,
          messageIndex,
          role,
          matchType: "tool_param",
          matchText: name,
          context: getContextSnippet(paramsStr, query),
        });
      }

      if (result) {
        const resultStr = [
          result.output ?? "",
          result.error ?? "",
          typeof result.data === "object" ? JSON.stringify(result.data) : String(result.data ?? ""),
        ].join(" ");
        if (resultStr.toLowerCase().includes(q)) {
          results.push({
            messageId,
            messageIndex,
            role,
            matchType: "tool_result",
            matchText: name,
            context: getContextSnippet(resultStr, query),
          });
        }
      }
    }
  }

  return results;
}

export function ConversationSearch({
  messages,
  open,
  onClose,
  onNavigate,
}: ConversationSearchProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const results = useMemo(() => {
    if (query.length < 2) return [];
    const allResults: SearchResult[] = [];
    const q = query.toLowerCase();

    messages.forEach((msg, idx) => {
      // Search message content
      if (msg.content.toLowerCase().includes(q)) {
        allResults.push({
          messageId: msg.id,
          messageIndex: idx,
          role: msg.role as "user" | "assistant",
          matchType: "content",
          matchText: msg.role === "user" ? "User message" : "Assistant response",
          context: getContextSnippet(msg.content, query),
        });
      }

      // Search tool calls/results in agent mode
      if (msg.mode === "agent" && msg.agentSteps) {
        allResults.push(
          ...searchToolResults(
            msg.agentSteps,
            query,
            msg.id,
            idx,
            msg.role as "user" | "assistant"
          )
        );
      }
    });

    return allResults.slice(0, 50); // Cap at 50 results
  }, [messages, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && results[selectedIndex]) {
        e.preventDefault();
        onNavigate(results[selectedIndex].messageId);
        onClose();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [results, selectedIndex, onNavigate, onClose]
  );

  // Scroll selected result into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;

  const getMatchIcon = (type: SearchResult["matchType"]) => {
    switch (type) {
      case "content": return MessageSquare;
      case "tool_name":
      case "tool_param":
      case "tool_result": return Wrench;
    }
  };

  const getMatchLabel = (type: SearchResult["matchType"]) => {
    switch (type) {
      case "content": return "Message";
      case "tool_name": return "Tool";
      case "tool_param": return "Parameter";
      case "tool_result": return "Result";
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />

      {/* Search panel */}
      <div
        className="relative z-10 w-full max-w-[560px] rounded-lg border border-border/50 bg-card shadow-2xl"
        style={{ backdropFilter: "blur(24px)" }}
        onKeyDown={handleKeyDown}
      >
        {/* Input */}
        <div className="flex items-center gap-2.5 border-b border-border/40 px-4 py-3">
          <Search size={16} className="shrink-0 text-muted-foreground/60" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages, tool calls, results..."
            className="flex-1 bg-transparent font-mono-tech text-[12px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="rounded p-0.5 text-muted-foreground/50 hover:text-foreground"
            >
              <X size={14} />
            </button>
          )}
          <kbd className="rounded border border-border/40 bg-card-3 px-1.5 py-0.5 font-mono-tech text-[9px] text-muted-foreground/50">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          className="max-h-[40vh] overflow-y-auto sidebar-scroll"
        >
          {query.length >= 2 && results.length === 0 && (
            <div className="px-4 py-8 text-center font-mono-tech text-[11px] text-muted-foreground/50">
              No results found
            </div>
          )}

          {results.map((result, idx) => {
            const Icon = getMatchIcon(result.matchType);
            return (
              <button
                key={`${result.messageId}-${idx}`}
                type="button"
                onClick={() => {
                  onNavigate(result.messageId);
                  onClose();
                }}
                className={cn(
                  "flex w-full items-start gap-3 border-b border-border/20 px-4 py-2.5 text-left transition-colors",
                  idx === selectedIndex
                    ? "bg-accent-blue/[0.08]"
                    : "hover:bg-card-hover/30"
                )}
              >
                <Icon size={14} className="mt-0.5 shrink-0 text-muted-foreground/50" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono-tech text-[10px] font-semibold text-foreground">
                      {result.matchText}
                    </span>
                    <span className="rounded border border-border/30 bg-card-3 px-1 py-px font-mono-tech text-[8px] font-medium uppercase tracking-wider text-muted-foreground/50">
                      {getMatchLabel(result.matchType)}
                    </span>
                    <span className="font-mono-tech text-[9px] text-muted-foreground/40">
                      msg #{result.messageIndex + 1}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate font-mono-tech text-[10px] text-muted-foreground/60">
                    {highlightMatch(result.context, query)}
                  </p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Footer */}
        {results.length > 0 && (
          <div className="flex items-center gap-3 border-t border-border/40 px-4 py-2">
            <span className="font-mono-tech text-[9px] text-muted-foreground/40">
              {results.length} result{results.length !== 1 ? "s" : ""}
            </span>
            <span className="ml-auto flex items-center gap-1.5 font-mono-tech text-[9px] text-muted-foreground/40">
              <kbd className="rounded border border-border/40 bg-card-3 px-1 py-px">↑↓</kbd>
              navigate
              <kbd className="ml-1 rounded border border-border/40 bg-card-3 px-1 py-px">↵</kbd>
              go
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
