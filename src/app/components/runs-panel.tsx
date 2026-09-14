// Runs panel — the right-sidebar "Runs" tab. Lists the conversation's
// agent runs, opens a run detail (checkpoints, metrics, restore) in a
// dialog, and supports selecting two runs for A/B comparison. This wires
// the previously-unreachable operations layer (audit M2.1).

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, GitCompare, Loader2, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { listAgentRuns, type AgentRunSummary } from "../../lib/agent-api";
import { cn } from "../../lib/utils";
import { Hint } from "./ui/tooltip";
import { AgentRunPanel } from "./agent-run-panel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "./ui/dialog";

const ACTIVE_RUN_STATUSES = new Set(["pending", "resumed", "in_progress", "running"]);
const POLL_INTERVAL_MS = 5_000;

function statusTone(status: string): string {
  if (status === "completed") return "text-accent-green";
  if (status === "failed") return "text-accent-red";
  if (status === "aborted") return "text-muted-foreground";
  if (ACTIVE_RUN_STATUSES.has(status)) return "text-accent-blue";
  return "text-accent-yellow";
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTokens(run: AgentRunSummary): string | null {
  const total = run.tokenUsage?.totalTokens;
  return typeof total === "number" && total > 0
    ? total >= 1000 ? `${(total / 1000).toFixed(1)}k tok` : `${total} tok`
    : null;
}

type RunsPanelContentProps = {
  conversationId?: string;
  /** Called with exactly two run ids when the user compares runs. */
  onCompare: (leftRunId: string, rightRunId: string) => void;
};

export function RunsPanelContent({ conversationId, onCompare }: RunsPanelContentProps) {
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);

  const hasActiveRun = useMemo(
    () => runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)),
    [runs]
  );

  const load = useCallback(async () => {
    if (!conversationId) {
      setRuns([]);
      setLoaded(true);
      return;
    }
    setLoading(true);
    try {
      const { runs: next } = await listAgentRuns({ conversationId, limit: 30 });
      setRuns(next);
    } catch {
      // Panel-level silence: an empty list with a retry button beats a
      // toast storm while polling.
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    setCompareIds([]);
    setDetailRunId(null);
    void load();
  }, [load]);

  // Poll while a run is active so the list reflects live status changes.
  useEffect(() => {
    if (!hasActiveRun || !conversationId) return;
    const timer = window.setInterval(() => { void load(); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasActiveRun, conversationId, load]);

  const toggleCompare = (runId: string) => {
    setCompareIds((prev) =>
      prev.includes(runId)
        ? prev.filter((id) => id !== runId)
        : prev.length >= 2
          ? [prev[1], runId]
          : [...prev, runId]
    );
  };

  const canCompare = compareIds.length === 2;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header row: count + refresh + compare */}
      <div className="flex items-center justify-between gap-2 border-b border-border/30 px-2.5 py-2">
        <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/50">
          {runs.length} run{runs.length === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-1">
          {compareIds.length > 0 && (
            <Hint label={canCompare ? "Compare selected runs" : "Select two runs to compare"}>
              <button
                type="button"
                disabled={!canCompare}
                onClick={() => { if (canCompare) onCompare(compareIds[0], compareIds[1]); }}
                className={cn(
                  "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.08em] transition-colors",
                  canCompare
                    ? "border-accent-blue/40 bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20"
                    : "cursor-not-allowed border-border/40 text-muted-foreground/40"
                )}
              >
                <GitCompare size={10} />
                Compare {compareIds.length}/2
              </button>
            </Hint>
          )}
          <Hint label="Refresh">
            <button
              type="button"
              onClick={() => { void load(); }}
              className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-accent/30 hover:text-foreground"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            </button>
          </Hint>
        </div>
      </div>

      {/* Run list */}
      <div className="sidebar-scroll flex-1 min-h-0 overflow-y-auto p-1.5">
        {!conversationId && (
          <p className="px-2 py-6 text-center font-mono-tech text-[10px] text-muted-foreground/50">
            Start or open a conversation to see its agent runs.
          </p>
        )}
        {conversationId && loaded && runs.length === 0 && !loading && (
          <p className="px-2 py-6 text-center font-mono-tech text-[10px] text-muted-foreground/50">
            No agent runs yet. Switch to Agent mode and send a task.
          </p>
        )}
        {runs.map((run) => {
          const selected = compareIds.includes(run.id);
          const tokens = formatTokens(run);
          return (
            <div
              key={run.id}
              className={cn(
                "group mb-1 rounded border bg-card-3/30 px-2 py-1.5 transition-colors",
                selected ? "border-accent-blue/50" : "border-border/30 hover:border-border/60"
              )}
            >
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={selected ? `Remove ${run.id} from comparison` : `Add ${run.id} to comparison`}
                  onClick={() => toggleCompare(run.id)}
                  className={cn(
                    "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border transition-colors",
                    selected
                      ? "border-accent-blue bg-accent-blue/20 text-accent-blue"
                      : "border-border/50 text-transparent hover:border-accent-blue/50"
                  )}
                >
                  <X size={8} className={selected ? "" : "hidden"} strokeWidth={3} />
                </button>
                <button
                  type="button"
                  onClick={() => setDetailRunId(run.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-1.5">
                    <Activity size={10} className={cn("shrink-0", statusTone(run.status))} />
                    <span className={cn("truncate font-mono-tech text-[9px] font-semibold uppercase tracking-[0.08em]", statusTone(run.status))}>
                      {run.status}
                    </span>
                    <span className="ml-auto shrink-0 font-mono-tech text-[8px] text-muted-foreground/50">
                      {timeAgo(run.startedAt ?? run.createdAt)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 font-mono-tech text-[9px] text-muted-foreground/60">
                    <span>{run.iterationCount} iter</span>
                    {tokens && <span>{tokens}</span>}
                    {run.model && <span className="truncate">{run.model}</span>}
                  </div>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Run detail dialog (checkpoints, metrics, restore) */}
      <Dialog open={detailRunId !== null} onOpenChange={(open) => { if (!open) setDetailRunId(null); }}>
        <DialogContent className="dialog-panel sm:max-w-[680px] max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-mono-tech text-[11px] font-semibold normal-case tracking-normal">
              Agent Run {detailRunId?.slice(-8)}
            </DialogTitle>
            <DialogDescription className="font-mono-tech text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
              Metrics, checkpoints, and process history
            </DialogDescription>
          </DialogHeader>
          {detailRunId && (
            <AgentRunPanel
              agentRunId={detailRunId}
              onError={(message) => toast.error(message)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
