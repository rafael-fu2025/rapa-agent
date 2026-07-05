/**
 * plan_tasks tool — batch task planning, matching QoderWork's TodoWrite pattern.
 * Accepts an array of tasks in a single call, replacing the entire task list.
 * This reduces N tool calls to 1 for task planning.
 */

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { type TaskStatus, type AgentTask, getTaskStore, clearTaskStore } from "./task-store.js";

/**
 * Extract task description from various possible field names.
 * Different models may use different field names for the task text.
 */
function extractDescription(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (!input || typeof input !== "object") return "";
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
    const tasksInput = params.tasks as unknown[];

    if (!Array.isArray(tasksInput) || tasksInput.length === 0) {
      // Check if tasks was sent as a single string with newlines
      if (typeof params.tasks === "string") {
        const lines = (params.tasks as string).split(/\n/).map((l: string) => l.replace(/^\d+[\.\)]\s*/, "").trim()).filter(Boolean);
        if (lines.length > 0) {
          clearTaskStore(context.conversationId);
          const store = getTaskStore(context.conversationId);
          const now = new Date().toISOString();
          const createdTasks: AgentTask[] = [];
          for (let i = 0; i < lines.length; i++) {
            const id = `task-${i + 1}`;
            const task: AgentTask = { id, content: lines[i], status: "pending", updatedAt: now };
            store.set(id, task);
            createdTasks.push(task);
          }
          const summary = createdTasks.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n");
          return { success: true, data: { tasks: createdTasks }, output: `Plan set (${createdTasks.length} tasks):\n${summary}` };
        }
      }
      return { success: false, error: "tasks array is required and must not be empty" };
    }

    clearTaskStore(context.conversationId);
    const store = getTaskStore(context.conversationId);
    const now = new Date().toISOString();

    const createdTasks: AgentTask[] = [];
    for (let i = 0; i < tasksInput.length; i++) {
      const description = extractDescription(tasksInput[i]);

      // If the model sent empty objects {} or other unparseable items,
      // create a placeholder task instead of failing the entire plan.
      // The agent can update the description later via update_task.
      const finalDescription = description || `Task ${i + 1}`;

      // Extract status if available
      let status: TaskStatus = "pending";
      if (tasksInput[i] && typeof tasksInput[i] === "object") {
        const rawStatus = (tasksInput[i] as Record<string, unknown>).status;
        if (typeof rawStatus === "string" && ["pending", "in_progress", "completed", "cancelled"].includes(rawStatus)) {
          status = rawStatus as TaskStatus;
        }
      }

      const id = `task-${i + 1}`;
      const task: AgentTask = { id, content: finalDescription, status, updatedAt: now };
      store.set(id, task);
      createdTasks.push(task);
    }

    if (createdTasks.length === 0) {
      return {
        success: false,
        error: [
          "tasks array is required and must not be empty.",
          "Example: {\"tasks\": [\"Install dependencies\", \"Build the server\", \"Write tests\", \"Run tests\", \"Verify all tests pass\"]}"
        ].join(" ")
      };
    }

    const summary = createdTasks.map((t, i) =>
      `${i + 1}. [${t.status}] ${t.content}`
    ).join("\n");

    return {
      success: true,
      data: { tasks: createdTasks },
      output: `Plan set (${createdTasks.length} tasks):\n${summary}`
    };
  }
}
