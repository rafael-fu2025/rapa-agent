/**
 * Shared task store — single source of truth for task management.
 *
 * Both `plan_tasks` (plan-tasks.ts) and `add_task` / `update_task` (tasks.ts)
 * MUST import from this module so they share the same in-memory Map.
 *
 * Without this shared store, plan_tasks writes tasks into one Map while
 * update_task reads from a different Map, so update_task never finds the
 * tasks that plan_tasks created.
 */

export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type AgentTask = {
  id: string;
  content: string;
  status: TaskStatus;
  updatedAt: string;
};

/**
 * The single shared store. Keyed by conversationId → Map<taskId, AgentTask>.
 * Every task tool (plan_tasks, add_task, update_task) imports this exact Map.
 */
const tasksByConversation = new Map<string, Map<string, AgentTask>>();

export function getTaskStore(conversationId: string): Map<string, AgentTask> {
  let store = tasksByConversation.get(conversationId);
  if (!store) {
    store = new Map<string, AgentTask>();
    tasksByConversation.set(conversationId, store);
  }
  return store;
}

export function listTasks(store: Map<string, AgentTask>): AgentTask[] {
  return Array.from(store.values()).sort((a, b) => {
    // Sort by ID numerically (task-1, task-2, ...) or alphabetically
    const numA = parseInt(a.id.replace(/\D/g, ""), 10);
    const numB = parseInt(b.id.replace(/\D/g, ""), 10);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Build a compact summary string of the current task list.
 * Used for injecting into the agent's context between iterations.
 *
 * Reads from BOTH the in-memory plan-mode store AND the persistent
 * `AgentTask` Prisma table. Tasks added via `add_task` are now
 * persistent; tasks added via `plan_tasks` (in plan mode) are still
 * in-memory. We merge them so the agent sees a single unified list.
 */
export async function buildTaskSummary(conversationId: string): Promise<string | null> {
  // In-memory plan tasks (legacy)
  const store = tasksByConversation.get(conversationId);
  const inMemory = store ? listTasks(store) : [];

  // Persistent AgentTask rows (§4.1)
  let persistent: Array<{ id: string; content: string; status: string; order: number }> = [];
  try {
    const { prisma } = await import("../lib/db.js");
    const rows = await prisma.agentTask.findMany({
      where: { conversationId },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }]
    });
    persistent = rows.map((r) => ({
      id: r.taskId,
      content: r.content,
      status: r.status,
      order: r.order
    }));
  } catch {
    // DB unavailable — fall back to in-memory only
  }

  const tasks = [...inMemory, ...persistent];
  if (tasks.length === 0) return null;

  const completed = tasks.filter((t) => t.status === "completed").length;
  const total = tasks.length;

  const lines = tasks.map((t, i) => {
    const marker = t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "○";
    return `  ${marker} ${i + 1}. [${t.status}] ${t.content}`;
  });

  return `Task plan (${completed}/${total} completed):\n${lines.join("\n")}`;
}

/**
 * Clear the task store for a conversation (used when plan_tasks replaces the list).
 */
export function clearTaskStore(conversationId: string): void {
  const store = tasksByConversation.get(conversationId);
  if (store) store.clear();
}
