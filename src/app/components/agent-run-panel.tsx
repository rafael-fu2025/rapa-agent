import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, GitBranch, LoaderCircle, RotateCcw, Terminal, XCircle } from "lucide-react";

import { getAgentRun, restoreAgentCheckpoint, type AgentCheckpoint, type AgentRunDetail } from "../../lib/agent-api";
import { cn } from "../../lib/utils";
import { Hint } from "./ui/tooltip";

type AgentRunPanelProps = {
  agentRunId?: string;
  className?: string;
  onError?: (message: string) => void;
};

function statusClassName(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "completed" || normalized === "created") return "border-accent-green/30 bg-accent-green/15 text-accent-green";
  if (normalized === "running" || normalized === "pending") return "border-accent-blue/30 bg-accent-blue/15 text-accent-blue";
  if (normalized === "restored") return "border-accent-purple/30 bg-accent-purple/15 text-accent-purple";
  return "border-border/40 bg-card-3/50 text-muted-foreground";
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function CheckpointRow({
  checkpoint,
  busy,
  onRestore
}: {
  checkpoint: AgentCheckpoint;
  busy: boolean;
  onRestore: (checkpoint: AgentCheckpoint) => void;
}) {
  const isRestored = checkpoint.status === "restored";
  const canRestore = Boolean(checkpoint.canRestore) && !isRestored;

  return (
    <div className="panel-card rounded p-3">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border/40 bg-card-3/30 text-muted-foreground">
          <GitBranch className="h-3 w-3" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Hint label={checkpoint.path}>
              <code className="truncate rounded border border-border/40 bg-card-3/30 px-1.5 py-0.5 font-mono-tech text-[9px] text-foreground">
                {checkpoint.path}
              </code>
            </Hint>
            <span className={cn("rounded border px-1.5 py-0.5 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.08em] leading-none", statusClassName(checkpoint.status))}>
              {checkpoint.status}
            </span>
            {checkpoint.toolCall?.name ? <span className="font-mono-tech text-[9px] text-muted-foreground">{checkpoint.toolCall.name}</span> : null}
          </div>
          {checkpoint.diffPreview ? (
            <pre className="mt-1.5 max-h-28 overflow-auto panel-card rounded p-2 font-mono-tech text-[9px] leading-4 text-foreground">
              {checkpoint.diffPreview}
            </pre>
          ) : null}
          {checkpoint.restoreNote ? <div className="mt-1.5 font-mono-tech text-[9px] text-muted-foreground">{checkpoint.restoreNote}</div> : null}
        </div>
        <Hint label={canRestore ? "Restore this checkpoint" : "This checkpoint cannot be restored"}>
          <button
            type="button"
            disabled={!canRestore || busy}
            onClick={() => onRestore(checkpoint)}
            className="inline-flex items-center gap-1 rounded border border-border/40 bg-card-3/30 px-2 py-1 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.08em] text-foreground transition-colors hover:border-border hover:bg-card-3 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busy ? <LoaderCircle className="h-2.5 w-2.5 animate-spin" /> : <RotateCcw className="h-2.5 w-2.5" />}
            Restore
          </button>
        </Hint>
      </div>
    </div>
  );
}

export function AgentRunPanel({ agentRunId, className, onError }: AgentRunPanelProps) {
  const [run, setRun] = useState<AgentRunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyCheckpointIds, setBusyCheckpointIds] = useState<string[]>([]);
  const [showRawResult, setShowRawResult] = useState(false);
  // Destructive-restore typed-phrase confirmation (replaces the old
  // native window.prompt — audit M2.1).
  const [pendingConfirm, setPendingConfirm] = useState<{ checkpointId: string; phrase: string } | null>(null);
  const [confirmInput, setConfirmInput] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentRunId) {
      setRun(null);
      return;
    }

    let mounted = true;
    setLoading(true);
    getAgentRun(agentRunId)
      .then((response) => {
        if (mounted) setRun(response.run);
      })
      .catch((error) => {
        if (mounted) onError?.(error instanceof Error ? error.message : "Failed to load agent run");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [agentRunId, onError]);

  if (!agentRunId) return null;

  const handleRestore = async (checkpoint: AgentCheckpoint) => {
    setBusyCheckpointIds((prev) => (prev.includes(checkpoint.id) ? prev : [...prev, checkpoint.id]));
    try {
      // P2-E: try without confirmation first; if the server says the
      // checkpoint is destructive, the typed-phrase confirmation will
      // surface in the caught error.
      const restored = await restoreAgentCheckpoint(checkpoint.id);
      setRun((current) => current
        ? {
            ...current,
            checkpoints: current.checkpoints.map((item) => item.id === checkpoint.id
              ? { ...item, ...restored.checkpoint, canRestore: false }
              : item)
          }
        : current);
    } catch (error) {
      // The `requiresConfirmation` field is appended to the thrown Error
      // by the API client for destructive checkpoints. The UI surfaces
      // a typed-confirmation card and retries with the phrase.
      const err = error as Error & { requiresConfirmation?: boolean; expectedConfirmation?: string };
      if (err.requiresConfirmation) {
        setPendingConfirm({ checkpointId: checkpoint.id, phrase: err.expectedConfirmation ?? "RESTORE" });
        return;
      }
      onError?.(error instanceof Error ? error.message : "Failed to restore checkpoint");
    } finally {
      setBusyCheckpointIds((prev) => prev.filter((item) => item !== checkpoint.id));
    }
  };

  const handleConfirmRestore = async () => {
    if (!pendingConfirm) return;
    const { checkpointId, phrase } = pendingConfirm;
    if (confirmInput.trim() !== phrase) {
      setConfirmError("Confirmation phrase did not match.");
      return;
    }
    setBusyCheckpointIds((prev) => (prev.includes(checkpointId) ? prev : [...prev, checkpointId]));
    try {
      const restored = await restoreAgentCheckpoint(checkpointId, { confirmation: phrase });
      setRun((current) => current
        ? {
            ...current,
            checkpoints: current.checkpoints.map((item) => item.id === checkpointId
              ? { ...item, ...restored.checkpoint, canRestore: false }
              : item)
          }
        : current);
      setPendingConfirm(null);
      setConfirmInput("");
      setConfirmError(null);
    } catch (retryError) {
      onError?.(retryError instanceof Error ? retryError.message : "Failed to restore checkpoint");
    } finally {
      setBusyCheckpointIds((prev) => prev.filter((item) => item !== checkpointId));
    }
  };

  if (loading && !run) {
    return (
      <div className={cn("panel-card rounded-lg px-3 py-2 font-mono-tech text-[10px] text-muted-foreground", className)}>
        <LoaderCircle className="mr-2 inline h-3 w-3 animate-spin text-accent-blue" />
        Loading persisted Agent run...
      </div>
    );
  }

  if (!run) return null;

  const checkpointCount = run.checkpoints?.length ?? 0;
  const processCount = run.processSessions?.length ?? 0;

  return (
    <div className={cn("my-2 overflow-hidden rounded-lg analytics-panel", className)}>
      <div className="border-b border-border/30 px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-foreground">
              <CheckCircle2 className="h-3 w-3 text-accent-green" />
              Persisted Agent run
            </div>
            <div className="mt-0.5 font-mono-tech text-[9px] text-muted-foreground">{run.id}</div>
          </div>
          <span className={cn("rounded border px-1.5 py-0.5 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.08em] leading-none", statusClassName(run.status))}>
            {run.status}
          </span>
        </div>
      </div>

      <div className="space-y-2 p-3">
        <div className="grid gap-2 font-mono-tech text-[9px] text-muted-foreground sm:grid-cols-4">
          <div className="panel-card rounded px-2 py-1.5">
            <div className="text-muted-foreground">Iterations</div>
            <div className="mt-1 text-foreground">{run.iterationCount}</div>
          </div>
          <div className="panel-card rounded px-2 py-1.5">
            <div className="text-muted-foreground">Checkpoints</div>
            <div className="mt-1 text-foreground">{checkpointCount}</div>
          </div>
          <div className="panel-card rounded px-2 py-1.5">
            <div className="text-muted-foreground">Processes</div>
            <div className="mt-1 text-foreground">{processCount}</div>
          </div>
          <div className="panel-card rounded px-2 py-1.5">
            <div className="text-muted-foreground">Completed</div>
            <Hint label={formatDate(run.completedAt)}>
              <div className="mt-1 truncate text-foreground">{formatDate(run.completedAt)}</div>
            </Hint>
          </div>
        </div>

        {run.runSummary ? (
          <div className="space-y-2">
            <button
              onClick={() => setShowRawResult(!showRawResult)}
              className="flex w-full items-center justify-between panel-card rounded px-2 py-1.5 text-left font-mono-tech text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
            >
              <span>Raw Result</span>
              {showRawResult ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
            {showRawResult && (
              <div className="max-h-[300px] overflow-auto panel-card rounded px-2 py-1.5 font-mono-tech text-[9px] leading-4 text-foreground">
                {run.runSummary}
              </div>
            )}
          </div>
        ) : null}

        {pendingConfirm ? (
          <div className="panel-card rounded border-accent-yellow/40 p-3">
            <div className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.14em] text-accent-yellow">
              Destructive restore
            </div>
            <p className="mt-1 font-mono-tech text-[9px] leading-4 text-muted-foreground">
              Restoring this checkpoint will discard the current file content. Type{" "}
              <code className="rounded border border-border/40 bg-card-3/50 px-1 py-0.5 text-foreground">{pendingConfirm.phrase}</code>{" "}
              to confirm.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                value={confirmInput}
                onChange={(e) => { setConfirmInput(e.target.value); setConfirmError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") { void handleConfirmRestore(); } }}
                placeholder={pendingConfirm.phrase}
                autoFocus
                className="min-w-0 flex-1 rounded border border-border/50 bg-card px-2 py-1 font-mono-tech text-[10px] text-foreground focus:border-accent-blue/60 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => { void handleConfirmRestore(); }}
                className="rounded border border-accent-yellow/40 bg-accent-yellow/10 px-2 py-1 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.08em] text-accent-yellow transition-colors hover:bg-accent-yellow/20"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => { setPendingConfirm(null); setConfirmInput(""); setConfirmError(null); }}
                className="rounded border border-border/40 px-2 py-1 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:bg-accent/30"
              >
                Cancel
              </button>
            </div>
            {confirmError && (
              <p className="mt-1 font-mono-tech text-[9px] text-accent-red">{confirmError}</p>
            )}
          </div>
        ) : null}

        {checkpointCount > 0 ? (
          <div className="space-y-2">
            <div className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Restore checkpoints</div>
            {run.checkpoints.map((checkpoint) => (
              <CheckpointRow
                key={checkpoint.id}
                checkpoint={checkpoint}
                busy={busyCheckpointIds.includes(checkpoint.id)}
                onRestore={handleRestore}
              />
            ))}
          </div>
        ) : null}

        {processCount > 0 ? (
          <div className="space-y-2">
            <div className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Process history</div>
            {run.processSessions.map((session) => (
              <div key={session.id} className="panel-card rounded p-3">
                <div className="flex items-center gap-2 font-mono-tech text-[9px] text-foreground">
                  <Terminal className="h-3 w-3 text-muted-foreground" />
                  <Hint label={session.command}>
                    <code className="min-w-0 flex-1 truncate">{session.command}</code>
                  </Hint>
                  <span className={cn("rounded border px-1.5 py-0.5 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.08em] leading-none", statusClassName(session.status))}>{session.status}</span>
                </div>
                {(session.outputSummary || session.stderrPreview) ? (
                  <pre className="mt-1.5 max-h-24 overflow-auto panel-card rounded p-2 font-mono-tech text-[9px] leading-4 text-foreground">
                    {session.outputSummary || session.stderrPreview}
                  </pre>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {run.errorMessage ? (
          <div className="flex items-start gap-2 panel-card rounded border-accent-red/30 bg-accent-red/10 px-2.5 py-2 font-mono-tech text-[9px] text-accent-red">
            <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
            {run.errorMessage}
          </div>
        ) : null}
      </div>
    </div>
  );
}
