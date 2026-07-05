import { CheckCircle, AlertCircle, LoaderCircle, CircleDashed } from "lucide-react";
import { cn } from "../../lib/utils";

export type AgentProgressBarStatus = "idle" | "running" | "completed" | "error";

export type AgentProgressBarProps = {
  currentIteration: number;
  maxIterations: number;
  status: AgentProgressBarStatus;
  className?: string;
};

function StatusIcon({ status }: { status: AgentProgressBarStatus }) {
  if (status === "running") {
    return <LoaderCircle className="h-3.5 w-3.5 animate-spin text-accent-blue" />;
  }
  if (status === "completed") {
    return <CheckCircle className="h-3.5 w-3.5 text-accent-green" />;
  }
  if (status === "error") {
    return <AlertCircle className="h-3.5 w-3.5 text-accent-red" />;
  }
  return <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />;
}

function getStatusLabel(status: AgentProgressBarStatus) {
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "error") return "Error";
  return "Idle";
}

function getStatusBadgeClass(status: AgentProgressBarStatus) {
  if (status === "running") return "border-accent-blue/30 bg-accent-blue/15 text-accent-blue";
  if (status === "completed") return "border-accent-green/30 bg-accent-green/15 text-accent-green";
  if (status === "error") return "border-accent-red/30 bg-accent-red/15 text-accent-red";
  return "border-border/40 bg-card-3/50 text-muted-foreground";
}

function getBarColor(status: AgentProgressBarStatus) {
  if (status === "running") return "bg-accent-blue";
  if (status === "completed") return "bg-accent-green";
  if (status === "error") return "bg-accent-red";
  return "bg-muted-foreground/40";
}

export function AgentProgressBar({
  currentIteration,
  maxIterations,
  status,
  className,
}: AgentProgressBarProps) {
  const progress = maxIterations > 0 ? (currentIteration / maxIterations) * 100 : 0;

  return (
    <div className={cn("analytics-panel rounded-lg px-4 py-3", className)}>
      {/* Header row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <StatusIcon status={status} />
          <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-foreground">
            Agent Progress
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Iteration counter */}
          <span className="font-mono-tech text-[10px] text-muted-foreground">
            {currentIteration} / {maxIterations}
          </span>
          {/* Status badge */}
          <span className={cn("rounded border px-1.5 py-0.5 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.08em]", getStatusBadgeClass(status))}>
            {getStatusLabel(status)}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-3">
        <div className="h-1 w-full overflow-hidden rounded-full bg-border/20">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500 ease-out",
              getBarColor(status),
              status === "running" && "animate-pulse"
            )}
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
      </div>

      {/* Progress percentage */}
      <div className="mt-2 flex justify-end">
        <span className="font-mono-tech text-[9px] text-muted-foreground tabular-nums">
          {Math.round(progress)}%
        </span>
      </div>
    </div>
  );
}
