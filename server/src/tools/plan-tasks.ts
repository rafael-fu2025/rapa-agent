/**
 * plan_tasks tool — batch task planning, matching QoderWork's TodoWrite pattern.
 * Accepts an array of tasks in a single call, replacing the entire task list.
 * This reduces N tool calls to 1 for task planning.
 *
 * Persistence: tasks are written to the `AgentTask` Prisma table (same store
 * as add_task / update_task / list_tasks) so the plan survives server
 * restarts and update_task can act on it. If the database is unavailable,
 * falls back to the in-memory store so planning still works.
 */

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { prisma, getLocalUser } from "../lib/db.js";
import { type TaskStatus, type AgentTask, getTaskStore, clearTaskStore } from "./task-store.js";

/**
 * Extract task description from various possible field names.
 * Different models may use different field names for the task text.
 */
function extractDescription(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (!input || typeof input === "object") return "";
  const obj = input as Record<string, unknown>;
  // Try common field names in priority order
  for (const key of ["description", "content", "text", "task", "name", "title", "label"]) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  // Last resort: stringify the first string value found
  for (const val of Object.values(obj)) {
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return "";
}

function extractStatus(input: unknown): TaskStatus {
  if (!input || typeof input !== "object") return "pending";
  const rawStatus = (input as Record<string, unknown>).status;
  if (typeof rawStatus === "string" && ["pending", "in_progress", "completed", "cancelled"].includes(rawStatus)) {
    return rawStatus as TaskStatus;
  }
  return "pending";
}

/**
 * Normalize the raw `tasks` parameter into an ordered list of task specs.
 * Accepts an array of strings/objects, or a single newline-delimited string.
 */
function normalizeTaskInput(raw: unknown): Array<{ content: string; status: TaskStatus }> | null {
  if (typeof raw === "string") {
    const lines = raw.split(/\n/).map((l) => l.replace(/^\d+[.)]\s*/, "").trim()).filter(Boolean);
    if (lines.length === 0) return null;
    return lines.map((content) => ({ content, status: "pending" as TaskStatus }));
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.map((item, index) => ({
    // Placeholder instead of failing the whole plan for junk items — the
    // agent can fix the description later via update_task.
    content: extractDescription(item) || `Task ${index + 1}`,
    status: extractStatus(item)
  }));
}

export class PlanTasksTool extends Tool {
  definition: ToolDefinition = {
    name: "plan_tasks",
    description: [
      "Create or replace the task plan for the current execution.",
      "Pass an array of task description strings.",
      "Example: { tasks: ['Install dependencies', 'Build the server', 'Write tests', 'Run tests', 'Final verification'] }",
      "Always include a final verification task."
    ].join(" "),
    category: "system",
    riskLevel: "none",
    requiresApproval: false,
    parameters: {
      tasks: {
        type: "array",
        description: 'Array of task description strings. Example: ["Install deps", "Build server", "Write tests", "Run tests", "Verify all tests pass"]',
        required: true,
        items: {
          type: "string",
          description: "A task description string"
        }
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const specs = normalizeTaskInput(params.tasks);
    if (!specs) {
      return {
        success: false,
        error: [
          "tasks array is required and must not be empty.",
          "Example: {\"tasks\": [\"Install dependencies\", \"Build the server\", \"Write tests\", \"Run tests\", \"Verify all tests pass\"]}"
        ].join(" ")
      };
    }

    // Same result shape whichever store backs the plan, so the frontend's
    // extractTasks and buildTaskSummary see one unified list.
    const summary = (tasks: AgentTask[]) => {
      const lines = tasks.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n");
      return `Plan set (${tasks.length} tasks):\n${lines}`;
    };

    try {
      const user = await getLocalUser();
      const created = await prisma.$transaction(async (tx) => {
        // Replace-all semantics: the new plan IS the task list.
        await tx.agentTask.deleteMany({ where: { conversationId: context.conversationId } });
        const rows: AgentTask[] = [];
        for (let i = 0; i < specs.length; i += 1) {
          const row = await tx.agentTask.create({
            data: {
              conversationId: context.conversationId,
              userId: user.id,
              taskId: `task-${i + 1}`,
              content: specs[i].content,
              status: specs[i].status,
              order: i
            }
          });
          rows.push({
            id: row.taskId,
            content: row.content,
            status: row.status as TaskStatus,
            updatedAt: row.updatedAt.toISOString()
          });
        }
        return rows;
      });

      // Keep the in-memory mirror empty — Prisma is the source of truth.
      clearTaskStore(context.conversationId);
      return { success: true, data: { tasks: created }, output: summary(created) };
    } catch {
      // Database unavailable — fall back to the in-memory store so
      // planning still works (and update_task's own fallback stays
      // consistent with it).
      clearTaskStore(context.conversationId);
      const store = getTaskStore(context.conversationId);
      const now = new Date().toISOString();
      const created: AgentTask[] = specs.map((spec, i) => {
        const task: AgentTask = { id: `task-${i + 1}`, content: spec.content, status: spec.status, updatedAt: now };
        store.set(task.id, task);
        return task;
      });
      return { success: true, data: { tasks: created }, output: summary(created) };
    }
  }
}
