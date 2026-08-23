// §4.1 — Persistent agent task list (add_task / update_task / list_tasks).
//
// Tasks live in the `AgentTask` Prisma model, so they survive server
// restarts and resume with the conversation. `plan_tasks` writes to the
// same table (replace-all semantics), making it the single task store.
// When the database is unavailable, tools fall back to the in-memory
// mirror in `task-store.ts` so task flows keep working.

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { prisma, getLocalUser } from "../lib/db.js";
import { Suggest } from "../lib/suggestions.js";
import { getTaskStore, listTasks as listInMemoryTasks } from "./task-store.js";

export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

const VALID_STATUSES: ReadonlySet<TaskStatus> = new Set(["pending", "in_progress", "completed", "cancelled"]);

/**
 * Normalize a task id. Accepts bare numeric IDs as shorthand: "5" → "task-5".
 * The user is the model and we want the call site to be forgiving.
 */
function normalizeTaskId(id: string): string {
  if (/^\d+$/.test(id.trim())) return `task-${id.trim()}`;
  return id.trim();
}

type AgentTaskRow = {
  taskId: string;
  content: string;
  status: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
};

function rowToAgentTask(row: AgentTaskRow) {
  return {
    id: row.taskId,
    content: row.content,
    status: row.status as TaskStatus,
    order: row.order,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

async function listTasksForConversation(conversationId: string) {
  const rows = await prisma.agentTask.findMany({
    where: { conversationId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }]
  });
  return rows.map(rowToAgentTask);
}

/**
 * In-memory fallback read (DB-unavailable environments). Returns plain
 * AgentTask objects shaped like the Prisma rows so result shapes match.
 */
function listTasksInMemory(conversationId: string) {
  return listInMemoryTasks(getTaskStore(conversationId)).map((t) => ({
    id: t.id,
    content: t.content,
    status: t.status,
    order: 0,
    createdAt: t.updatedAt,
    updatedAt: t.updatedAt
  }));
}

function isDbUnavailableError(error: unknown): boolean {
  // Prisma throws when the DB is down/uninitialized; a plain "not found"
  // never throws, so this distinguishes infrastructure failure from a
  // missing row.
  return error instanceof Error && /prisma|database|can't reach|connection|P1\d{3}/i.test(error.message);
}

abstract class BaseTaskTool extends Tool {
  protected buildTaskResult(task: ReturnType<typeof rowToAgentTask>, all: ReturnType<typeof rowToAgentTask>[]): ToolResult {
    return {
      success: true,
      data: {
        task,
        tasks: all
      }
    };
  }
}

export class AddTaskTool extends BaseTaskTool {
  definition: ToolDefinition = {
    name: "add_task",
    description: "Add a task to the current agent execution task list. Tasks persist across server restarts and are restored when the conversation is resumed.",
    category: "system",
    riskLevel: "none",
    parameters: {
      id: {
        type: "string",
        description: "Unique task id (e.g. \"task-1\", \"task-2\"). Numeric shorthand like \"5\" is also accepted and stored as \"task-5\".",
        required: true
      },
      content: {
        type: "string",
        description: "Task description",
        required: true
      },
      status: {
        type: "string",
        description: "Initial task status. Defaults to \"pending\".",
        required: false,
        enum: ["pending", "in_progress", "completed", "cancelled"]
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const rawId = (params.id as string | undefined)?.trim();
    const content = (params.content as string | undefined)?.trim();
    const status = ((params.status as TaskStatus | undefined) ?? "pending");

    if (!rawId || !content) {
      return Suggest.generic(
        { success: false, error: "Task id and content are required" },
        "Provide both `id` (e.g. \"task-1\") and `content` (a short imperative sentence describing the task)."
      );
    }
    if (!VALID_STATUSES.has(status)) {
      return Suggest.generic(
        { success: false, error: `Invalid status "${status}"` },
        "Use one of: pending | in_progress | completed | cancelled."
      );
    }

    const taskId = normalizeTaskId(rawId);

    try {
      const user = await getLocalUser();
      const existing = await prisma.agentTask.findUnique({
        where: { conversationId_taskId: { conversationId: context.conversationId, taskId } }
      });
      if (existing) {
        return Suggest.generic(
          { success: false, error: `Task ${taskId} already exists` },
          "Use a different id, or call update_task to change the existing one."
        );
      }

      const highest = await prisma.agentTask.findFirst({
        where: { conversationId: context.conversationId },
        orderBy: { order: "desc" }
      });
      const nextOrder = (highest?.order ?? -1) + 1;

      const row = await prisma.agentTask.create({
        data: {
          conversationId: context.conversationId,
          userId: user.id,
          taskId,
          content,
          status,
          order: nextOrder
        }
      });

      const all = await listTasksForConversation(context.conversationId);
      return this.buildTaskResult(rowToAgentTask(row), all);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to add task"
      };
    }
  }
}

export class UpdateTaskTool extends BaseTaskTool {
  definition: ToolDefinition = {
    name: "update_task",
    description: "Update a task in the current agent execution task list. Can change the content, status, or both.",
    category: "system",
    riskLevel: "none",
    parameters: {
      id: {
        type: "string",
        description: "Existing task id",
        required: true
      },
      content: {
        type: "string",
        description: "Updated task description (optional)",
        required: false
      },
      status: {
        type: "string",
        description: "Updated task status (optional)",
        required: false,
        enum: ["pending", "in_progress", "completed", "cancelled"]
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const rawId = (params.id as string | undefined)?.trim();
    const content = typeof params.content === "string" ? params.content.trim() : undefined;
    const status = params.status as TaskStatus | undefined;

    if (!rawId) {
      return { success: false, error: "Task id is required" };
    }
    if (content === undefined && status === undefined) {
      return Suggest.generic(
        { success: false, error: "At least one of content or status must be provided" },
        "Pass `content` to update the task description, `status` to mark it in_progress / completed / cancelled, or both."
      );
    }
    if (status !== undefined && !VALID_STATUSES.has(status)) {
      return Suggest.generic(
        { success: false, error: `Invalid status "${status}"` },
        "Use one of: pending | in_progress | completed | cancelled."
      );
    }

    const taskId = normalizeTaskId(rawId);

    // ── DB-unavailable fallback: operate on the in-memory mirror ──────────
    // plan_tasks writes there when Prisma is down; keep the round-trip
    // working in the same environment.
    const tryInMemoryUpdate = (): ToolResult | null => {
      const store = getTaskStore(context.conversationId);
      const task = store.get(taskId);
      if (!task) return null;
      if (status !== undefined) {
        const lifecycleError = checkTaskLifecycle(taskId, task.status, status, listInMemoryTasks(store));
        if (lifecycleError) return lifecycleError;
        task.status = status;
      }
      if (content !== undefined) task.content = content;
      task.updatedAt = new Date().toISOString();
      const asRow = (t: { id: string; content: string; status: TaskStatus; updatedAt: string }) => ({
        id: t.id,
        content: t.content,
        status: t.status,
        order: 0,
        createdAt: t.updatedAt,
        updatedAt: t.updatedAt
      });
      const all = listInMemoryTasks(store).map(asRow);
      return this.buildTaskResult(asRow(task), all);
    };

    /**
     * Task lifecycle discipline: a task must pass through in_progress
     * before being marked completed, so "completed" reflects real work
     * rather than optimism. Relaxed when no OTHER task is still open —
     * models legitimately batch-complete the last task at wrap-up.
     */
    const checkTaskLifecycle = (
      currentId: string,
      currentStatus: string,
      next: TaskStatus,
      siblings: Array<{ id: string; status: string }>
    ): ToolResult | null => {
      if (currentStatus === "pending" && next === "completed") {
        const others = siblings.filter((t) => t.id !== currentId && t.status !== "completed" && t.status !== "cancelled");
        if (others.length > 0) {
          return Suggest.generic(
            { success: false, error: `Task ${taskId} is still pending — mark it in_progress before completing it.` },
            "Call update_task({ id, status: \"in_progress\" }) when you start the task, then \"completed\" when it's done."
          );
        }
      }
      return null;
    };

    try {
      const existing = await prisma.agentTask.findUnique({
        where: { conversationId_taskId: { conversationId: context.conversationId, taskId } }
      });
      if (!existing) {
        const all = await listTasksForConversation(context.conversationId);
        return Suggest.generic(
          {
            success: false,
            error: `Task ${rawId} does not exist. Available tasks: ${all.map((t) => t.id).join(", ") || "(none)"}`
          },
          "Call add_task with a fresh id, or list_tasks to see what's already in the list."
        );
      }

      if (status !== undefined) {
        const siblings = await listTasksForConversation(context.conversationId);
        const lifecycleError = checkTaskLifecycle(existing.taskId, existing.status, status, siblings);
        if (lifecycleError) return lifecycleError;
      }

      const row = await prisma.agentTask.update({
        where: { conversationId_taskId: { conversationId: context.conversationId, taskId } },
        data: {
          ...(content !== undefined ? { content } : {}),
          ...(status !== undefined ? { status } : {})
        }
      });

      const all = await listTasksForConversation(context.conversationId);
      return this.buildTaskResult(rowToAgentTask(row), all);
    } catch (error) {
      if (isDbUnavailableError(error)) {
        const fallback = tryInMemoryUpdate();
        if (fallback) return fallback;
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update task"
      };
    }
  }
}

/**
 * §4.1 — list_tasks. Read-only tool that returns the full task list
 * for the current conversation. Useful when the agent resumes work
 * after a server restart and needs to know what's already done.
 */
export class ListTasksTool extends BaseTaskTool {
  definition: ToolDefinition = {
    name: "list_tasks",
    description: "List all tasks in the current agent execution task list. Returns id, content, and status for every task. Use this to recover state after a resume or to confirm what remains.",
    category: "system",
    riskLevel: "none",
    parameters: {
      status: {
        type: "string",
        description: "Optional filter — only return tasks with this status",
        required: false,
        enum: ["pending", "in_progress", "completed", "cancelled", "all"]
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const filter = (params.status as TaskStatus | "all" | undefined) ?? "all";
    try {
      const all = await listTasksForConversation(context.conversationId);
      return this.renderList(all, filter);
    } catch (error) {
      if (isDbUnavailableError(error)) {
        const inMemory = listTasksInMemory(context.conversationId);
        if (inMemory.length > 0 || getTaskStore(context.conversationId).size > 0) {
          return this.renderList(inMemory, filter);
        }
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to list tasks"
      };
    }
  }

  private renderList(all: Array<{ id: string; content: string; status: string }>, filter: TaskStatus | "all"): ToolResult {
    const filtered = filter === "all" ? all : all.filter((t) => t.status === filter);
    const summary = {
      total: all.length,
      completed: all.filter((t) => t.status === "completed").length,
      inProgress: all.filter((t) => t.status === "in_progress").length,
      pending: all.filter((t) => t.status === "pending").length,
      cancelled: all.filter((t) => t.status === "cancelled").length
    };
    return {
      success: true,
      data: {
        tasks: filtered,
        summary,
        filter
      }
    };
  }
}
