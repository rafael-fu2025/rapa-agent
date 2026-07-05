import { useMemo } from "react";
import { CheckCircle2, CircleDashed, ListTodo, LoaderCircle, XCircle } from "lucide-react";
import type { AgentLiveToolCall, AgentStep } from "../../lib/agent-api";
import { cn } from "../../lib/utils";

export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type AgentTask = {
  id: string;
  content: string;
  status: TaskStatus;
  updatedAt?: string;
};

type TaskListProps = {
  steps: AgentStep[];
  liveToolCalls?: AgentLiveToolCall[];
  isAgentActive?: boolean;
  embedded?: boolean;
  showEmpty?: boolean;
  className?: string;
};

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled";
}

function normalizeTask(value: unknown): AgentTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const task = value as Partial<AgentTask>;
  if (typeof task.id !== "string" || !task.id.trim()) return null;
  if (typeof task.content !== "string" || !task.content.trim()) return null;

  return {
    id: task.id.trim(),
    content: task.content.trim(),
    status: isTaskStatus(task.status) ? task.status : "pending",
    updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : undefined
  };
}

function mergeTaskSnapshot(current: AgentTask[], next: AgentTask[]) {
  if (next.length === 0) return current;
  return next;
}

function taskSnapshotFromResult(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];

  const rawTasks = (data as { tasks?: unknown }).tasks;
  if (!Array.isArray(rawTasks)) return [];

  return rawTasks.map(normalizeTask).filter((task): task is AgentTask => task !== null);
}

function taskFromLiveCall(toolCall: AgentLiveToolCall): AgentTask | null {
  const name = toolCall.call?.name;
  if (name !== "add_task" && name !== "update_task") return null;

  const params = toolCall.call.parameters ?? {};
  const id = typeof params.id === "string" ? params.id.trim() : "";
  const content = typeof params.content === "string" ? params.content.trim() : "";
  if (!id || !content) return null;

  return {
    id,
    content,
    status: isTaskStatus(params.status) ? params.status : "in_progress"
  };
}

export function extractTasks(steps: AgentStep[], liveToolCalls: AgentLiveToolCall[] = []) {
  let tasks: AgentTask[] = [];

  for (const step of steps) {
    step.toolResults.forEach((result) => {
      if (!result.success) return;
      tasks = mergeTaskSnapshot(tasks, taskSnapshotFromResult(result.data));
    });
  }

  liveToolCalls.forEach((toolCall) => {
    if (toolCall.result?.success) {
      tasks = mergeTaskSnapshot(tasks, taskSnapshotFromResult(toolCall.result.data));
      return;
    }

    const liveTask = taskFromLiveCall(toolCall);
    if (!liveTask) return;

    const existingIndex = tasks.findIndex((task) => task.id === liveTask.id);
    if (existingIndex === -1) {
      tasks = [...tasks, liveTask];
      return;
    }

    tasks = tasks.map((task, index) => index === existingIndex ? { ...task, ...liveTask } : task);
  });

  return tasks;
}

function StatusIcon({ status, isAgentActive }: { status: TaskStatus, isAgentActive: boolean }) {
  if (status === "completed") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-accent-green" />;
  }

  if (status === "in_progress") {
    return <LoaderCircle className={cn("h-3.5 w-3.5 text-accent-blue", isAgentActive && "animate-spin")} />;
  }

  if (status === "cancelled") {
    return <XCircle className="h-3.5 w-3.5 text-accent-red" />;
  }

  return <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />;
}

function statusLabel(status: TaskStatus) {
  if (status === "in_progress") return "In progress";
  if (status === "completed") return "Completed";
  if (status === "cancelled") return "Cancelled";
  return "Pending";
}

function getStatusClassName(status: TaskStatus) {
  if (status === "completed") return "border-accent-green/30 bg-accent-green/15 text-accent-green";
  if (status === "in_progress") return "border-accent-blue/30 bg-accent-blue/15 text-accent-blue";
  if (status === "cancelled") return "border-accent-red/30 bg-accent-red/15 text-accent-red";
  return "border-border/40 bg-card-3/50 text-muted-foreground";
}

export function TaskList({ steps, liveToolCalls = [], isAgentActive = false, embedded = false, showEmpty = false, className }: TaskListProps) {
  const tasks = useMemo(() => extractTasks(steps, liveToolCalls), [steps, liveToolCalls]);
  const completedCount = tasks.filter((task) => task.status === "completed").length;
  const hasActiveTask = isAgentActive && tasks.some((task) => task.status === "in_progress");

  if (tasks.length === 0 && !showEmpty) return null;

  const content = tasks.length === 0 ? (
    <div className="panel-card rounded border-dashed px-4 py-5 font-mono-tech text-[10px] leading-5 text-muted-foreground">
      No task updates yet. The agent will show its plan here when it creates tasks.
    </div>
  ) : (
    <div className="space-y-2">
      {tasks.map((task) => (
        <div key={task.id} className="panel-card rounded px-3 py-2.5">
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border/40 bg-card-3/30">
              <StatusIcon status={task.status} isAgentActive={isAgentActive} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="whitespace-pre-wrap font-mono-tech text-[10px] leading-5 text-foreground">{task.content}</div>
              <div className="mt-1 flex items-center gap-2">
                <span className={cn("rounded border px-1.5 py-0.5 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.08em] leading-none", getStatusClassName(task.status))}>
                  {statusLabel(task.status)}
                </span>
                <code className="font-mono-tech text-[9px] text-muted-foreground">{task.id}</code>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  if (embedded) {
    return <div className={cn("space-y-2", className)}>{content}</div>;
  }

  return (
    <div className={cn("analytics-panel rounded-lg overflow-hidden", className)}>
      <div className="flex items-center justify-between border-b border-border/30 px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded bg-accent-blue/15 text-accent-blue">
            <ListTodo className="h-3 w-3" />
          </div>
          <div>
            <div className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-foreground">Agent plan</div>
            <div className="font-mono-tech text-[10px] text-muted-foreground">{completedCount}/{tasks.length} tasks completed</div>
          </div>
        </div>
        {hasActiveTask ? (
          <span className="inline-flex items-center gap-1 rounded border border-accent-blue/30 bg-accent-blue/15 px-2 py-0.5 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.08em] text-accent-blue">
            <span className="h-1 w-1 rounded-full bg-accent-blue animate-pulse" />
            Working
          </span>
        ) : null}
      </div>
      <div className="p-2.5">{content}</div>
    </div>
  );
}
