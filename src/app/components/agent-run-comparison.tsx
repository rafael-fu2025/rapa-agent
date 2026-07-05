import { useEffect, useState, useMemo } from "react";
import { X, ArrowLeftRight, CheckCircle, XCircle, Clock, Loader2, Zap, MessageSquare, Wrench } from "lucide-react";
import { cn } from "../../lib/utils";
import { getAgentRun, type AgentRunDetail } from "../../lib/agent-api";

type Props = {
  open: boolean;
  onClose: () => void;
  leftRunId: string | null;
  rightRunId: string | null;
};

type RunPanel = {
  run: AgentRunDetail | null;
  loading: boolean;
  error: string | null;
};

function formatDuration(start: string, end?: string | null): string {
  if (!end) return "running...";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatTokens(usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null): string {
  if (!usage) return "—";
  const total = usage.totalTokens ?? ((usage.promptTokens ?? 0) + (usage.completionTokens ?? 0));
  if (total > 1000) return `${(total / 1000).toFixed(1)}k`;
  return String(total);
}

function StatusBadge({ status }: { status: string }) {
  const isSuccess = status === "completed" || status === "done";
  const isFailed = status === "failed" || status === "error";
  const isRunning = status === "running" || status === "streaming";

  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.12em]",
      isSuccess ? "border-accent-green/30 bg-accent-green/[0.08] text-accent-green" :
      isFailed ? "border-accent-red/30 bg-accent-red/[0.08] text-accent-red" :
      isRunning ? "border-accent-blue/30 bg-accent-blue/[0.08] text-accent-blue" :
      "border-border/40 bg-card-3 text-muted-foreground/60"
    )}>
      {isSuccess ? <CheckCircle size={9} /> : isFailed ? <XCircle size={9} /> : isRunning ? <Loader2 size={9} className="animate-spin" /> : null}
      {status}
    </span>
  );
}

function MetricRow({ label, left, right, highlight }: {
  label: string;
  left: string | number;
  right: string | number;
  highlight?: "left" | "right" | "equal" | null;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-border/20 py-2">
      <div className={cn(
        "text-right font-mono-tech text-[11px]",
        highlight === "left" ? "text-accent-green font-medium" : "text-foreground/70"
      )}>
        {left}
      </div>
      <div className="w-24 text-center">
        <span className="font-mono-tech text-[8px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/40">
          {label}
        </span>
      </div>
      <div className={cn(
        "text-left font-mono-tech text-[11px]",
        highlight === "right" ? "text-accent-green font-medium" : "text-foreground/70"
      )}>
        {right}
      </div>
    </div>
  );
}

export function AgentRunComparison({ open, onClose, leftRunId, rightRunId }: Props) {
  const [leftPanel, setLeftPanel] = useState<RunPanel>({ run: null, loading: false, error: null });
  const [rightPanel, setRightPanel] = useState<RunPanel>({ run: null, loading: false, error: null });

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    const loadRun = async (id: string | null, setter: (p: RunPanel) => void) => {
      if (!id) {
        setter({ run: null, loading: false, error: "No run selected" });
        return;
      }
      setter({ run: null, loading: true, error: null });
      try {
        const { run } = await getAgentRun(id);
        if (!cancelled) setter({ run, loading: false, error: null });
      } catch {
        if (!cancelled) setter({ run: null, loading: false, error: "Failed to load run" });
      }
    };

    void loadRun(leftRunId, setLeftPanel);
    void loadRun(rightRunId, setRightPanel);

    return () => { cancelled = true; };
  }, [open, leftRunId, rightRunId]);

  // Close on escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Compute comparison metrics
  const comparison = useMemo(() => {
    const l = leftPanel.run;
    const r = rightPanel.run;
    if (!l && !r) return null;

    const leftTokens = l?.tokenUsage?.totalTokens ?? ((l?.tokenUsage?.promptTokens ?? 0) + (l?.tokenUsage?.completionTokens ?? 0));
    const rightTokens = r?.tokenUsage?.totalTokens ?? ((r?.tokenUsage?.promptTokens ?? 0) + (r?.tokenUsage?.completionTokens ?? 0));
    const leftDuration = l ? formatDuration(l.startedAt, l.completedAt) : "—";
    const rightDuration = r ? formatDuration(r.startedAt, r.completedAt) : "—";
    const leftToolCalls = l?.toolCalls?.length ?? 0;
    const rightToolCalls = r?.toolCalls?.length ?? 0;

    return {
      leftTokens,
      rightTokens,
      leftDuration,
      rightDuration,
      leftToolCalls,
      rightToolCalls,
      tokenHighlight: leftTokens < rightTokens ? "left" as const : rightTokens < leftTokens ? "right" as const : "equal" as const,
      durationHighlight: leftDuration < rightDuration ? "left" as const : rightDuration < leftDuration ? "right" as const : "equal" as const,
      iterationHighlight: (l?.iterationCount ?? 0) < (r?.iterationCount ?? 0) ? "left" as const : (r?.iterationCount ?? 0) < (l?.iterationCount ?? 0) ? "right" as const : "equal" as const,
    };
  }, [leftPanel.run, rightPanel.run]);

  if (!open) return null;

  const left = leftPanel.run;
  const right = rightPanel.run;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      <div className="relative z-10 flex h-[80vh] max-h-[700px] w-full max-w-[900px] flex-col rounded-lg border border-border/60 bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/40 px-4 py-3">
          <div className="flex items-center gap-2">
            <ArrowLeftRight size={14} className="text-accent-blue/60" />
            <h3 className="font-mono-tech text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground">
              Agent Run Comparison
            </h3>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            type="button"
          >
            <X size={14} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:thin]">
          {(leftPanel.loading || rightPanel.loading) && (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={20} className="animate-spin text-muted-foreground/40" />
            </div>
          )}

          {!leftPanel.loading && !rightPanel.loading && !left && !right && (
            <div className="px-4 py-16 text-center">
              <p className="text-[11px] text-muted-foreground/60">No runs to compare</p>
            </div>
          )}

          {(!leftPanel.loading && !rightPanel.loading) && (left || right) && (
            <div className="p-4 space-y-4">
              {/* Run headers */}
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded border border-border/40 bg-card-3/50 p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-accent-blue/70">
                      Run A
                    </span>
                    {left && <StatusBadge status={left.status} />}
                  </div>
                  {left && (
                    <div className="mt-2 space-y-1">
                      <p className="truncate text-[11px] text-foreground/80 font-medium">
                        {left.model ?? "unknown model"}
                      </p>
                      <p className="truncate font-mono-tech text-[10px] text-muted-foreground/50">
                        {left.promptPreview ?? "No prompt"}
                      </p>
                      <p className="font-mono-tech text-[9px] text-muted-foreground/40">
                        {new Date(left.startedAt).toLocaleString()}
                      </p>
                    </div>
                  )}
                  {leftPanel.error && (
                    <p className="mt-2 text-[10px] text-accent-red/70">{leftPanel.error}</p>
                  )}
                </div>

                <div className="rounded border border-border/40 bg-card-3/50 p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-accent-green/70">
                      Run B
                    </span>
                    {right && <StatusBadge status={right.status} />}
                  </div>
                  {right && (
                    <div className="mt-2 space-y-1">
                      <p className="truncate text-[11px] text-foreground/80 font-medium">
                        {right.model ?? "unknown model"}
                      </p>
                      <p className="truncate font-mono-tech text-[10px] text-muted-foreground/50">
                        {right.promptPreview ?? "No prompt"}
                      </p>
                      <p className="font-mono-tech text-[9px] text-muted-foreground/40">
                        {new Date(right.startedAt).toLocaleString()}
                      </p>
                    </div>
                  )}
                  {rightPanel.error && (
                    <p className="mt-2 text-[10px] text-accent-red/70">{rightPanel.error}</p>
                  )}
                </div>
              </div>

              {/* Metrics comparison */}
              {comparison && (
                <div className="rounded border border-border/40 bg-card-3/30 p-3">
                  <h4 className="mb-2 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/50">
                    Metrics
                  </h4>
                  <MetricRow
                    label="status"
                    left={left?.status ?? "—"}
                    right={right?.status ?? "—"}
                  />
                  <MetricRow
                    label="iterations"
                    left={left?.iterationCount ?? 0}
                    right={right?.iterationCount ?? 0}
                    highlight={comparison.iterationHighlight}
                  />
                  <MetricRow
                    label="tokens"
                    left={formatTokens(left?.tokenUsage)}
                    right={formatTokens(right?.tokenUsage)}
                    highlight={comparison.tokenHighlight}
                  />
                  <MetricRow
                    label="duration"
                    left={comparison.leftDuration}
                    right={comparison.rightDuration}
                    highlight={comparison.durationHighlight}
                  />
                  <MetricRow
                    label="tool calls"
                    left={comparison.leftToolCalls}
                    right={comparison.rightToolCalls}
                  />
                  <MetricRow
                    label="provider"
                    left={left?.provider ?? "—"}
                    right={right?.provider ?? "—"}
                  />
                </div>
              )}

              {/* Response comparison */}
              {(left?.responsePreview || right?.responsePreview) && (
                <div className="rounded border border-border/40 bg-card-3/30 p-3">
                  <h4 className="mb-2 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/50">
                    Response Preview
                  </h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded border border-border/30 bg-card p-2.5">
                      <div className="mb-1 flex items-center gap-1">
                        <MessageSquare size={9} className="text-accent-blue/50" />
                        <span className="font-mono-tech text-[8px] font-semibold uppercase tracking-[0.12em] text-accent-blue/60">A</span>
                      </div>
                      <p className="font-mono text-[10px] leading-relaxed text-foreground/60 line-clamp-6">
                        {left?.responsePreview ?? "No response"}
                      </p>
                    </div>
                    <div className="rounded border border-border/30 bg-card p-2.5">
                      <div className="mb-1 flex items-center gap-1">
                        <MessageSquare size={9} className="text-accent-green/50" />
                        <span className="font-mono-tech text-[8px] font-semibold uppercase tracking-[0.12em] text-accent-green/60">B</span>
                      </div>
                      <p className="font-mono text-[10px] leading-relaxed text-foreground/60 line-clamp-6">
                        {right?.responsePreview ?? "No response"}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Run summary comparison */}
              {(left?.runSummary || right?.runSummary) && (
                <div className="rounded border border-border/40 bg-card-3/30 p-3">
                  <h4 className="mb-2 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/50">
                    Run Summary
                  </h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded border border-border/30 bg-card p-2.5">
                      <div className="mb-1 flex items-center gap-1">
                        <Zap size={9} className="text-accent-blue/50" />
                        <span className="font-mono-tech text-[8px] font-semibold uppercase tracking-[0.12em] text-accent-blue/60">A</span>
                      </div>
                      <p className="text-[10px] leading-relaxed text-foreground/60">
                        {left?.runSummary ?? "No summary"}
                      </p>
                    </div>
                    <div className="rounded border border-border/30 bg-card p-2.5">
                      <div className="mb-1 flex items-center gap-1">
                        <Zap size={9} className="text-accent-green/50" />
                        <span className="font-mono-tech text-[8px] font-semibold uppercase tracking-[0.12em] text-accent-green/60">B</span>
                      </div>
                      <p className="text-[10px] leading-relaxed text-foreground/60">
                        {right?.runSummary ?? "No summary"}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Error comparison */}
              {(left?.errorMessage || right?.errorMessage) && (
                <div className="rounded border border-accent-red/20 bg-accent-red/[0.03] p-3">
                  <h4 className="mb-2 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-accent-red/60">
                    Errors
                  </h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded border border-border/30 bg-card p-2.5">
                      <p className="font-mono text-[10px] leading-relaxed text-accent-red/70">
                        {left?.errorMessage ?? "No error"}
                      </p>
                    </div>
                    <div className="rounded border border-border/30 bg-card p-2.5">
                      <p className="font-mono text-[10px] leading-relaxed text-accent-red/70">
                        {right?.errorMessage ?? "No error"}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border/30 px-4 py-2">
          <div className="flex items-center justify-between">
            <span className="font-mono-tech text-[9px] text-muted-foreground/40">
              Compare two agent runs side-by-side
            </span>
            <span className="flex items-center gap-1.5 font-mono-tech text-[9px] text-muted-foreground/40">
              <kbd className="rounded border border-border/40 bg-card-3 px-1 py-px">esc</kbd>
              close
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
