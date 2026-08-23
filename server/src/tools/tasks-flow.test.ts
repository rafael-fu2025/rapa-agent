// Tests for the unified task store: plan_tasks (Prisma-backed, replace-all)
// round-tripping with update_task, the task lifecycle discipline, and the
// DB-unavailable in-memory fallback. The db module is mocked so tests never
// touch the developer's real dev.db.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  type Row = {
    conversationId: string;
    userId: string;
    taskId: string;
    content: string;
    status: string;
    order: number;
    createdAt: Date;
    updatedAt: Date;
  };
  const rows: Row[] = [];
  let dbDown = false;
  const failIfDown = () => {
    if (dbDown) throw new Error("Prisma Client failed: Can't reach database server (P1001)");
  };
  const agentTask = {
    findMany: async ({ where }: { where: { conversationId: string } }) => {
      failIfDown();
      return rows
        .filter((r) => r.conversationId === where.conversationId)
        .sort((a, b) => a.order - b.order);
    },
    findUnique: async ({ where }: { where: { conversationId_taskId: { conversationId: string; taskId: string } } }) => {
      failIfDown();
      const key = where.conversationId_taskId;
      return rows.find((r) => r.conversationId === key.conversationId && r.taskId === key.taskId) ?? null;
    },
    findFirst: async ({ where }: { where: { conversationId: string } }) => {
      failIfDown();
      const mine = rows.filter((r) => r.conversationId === where.conversationId).sort((a, b) => b.order - a.order);
      return mine[0] ?? null;
    },
    create: async ({ data }: { data: Omit<Row, "createdAt" | "updatedAt"> }) => {
      failIfDown();
      const now = new Date();
      const row: Row = { ...data, createdAt: now, updatedAt: now };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { conversationId_taskId: { conversationId: string; taskId: string } }; data: Partial<Row> }) => {
      failIfDown();
      const key = where.conversationId_taskId;
      const row = rows.find((r) => r.conversationId === key.conversationId && r.taskId === key.taskId);
      if (!row) throw new Error("Record not found");
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
    deleteMany: async ({ where }: { where: { conversationId: string } }) => {
      failIfDown();
      const mine = rows.filter((r) => r.conversationId === where.conversationId);
      for (const row of mine) rows.splice(rows.indexOf(row), 1);
      return { count: mine.length };
    }
  };
  const fakePrisma = {
    agentTask,
    $transaction: async (fn: (tx: { agentTask: typeof agentTask }) => unknown) => {
      failIfDown();
      return fn({ agentTask });
    }
  };
  return {
    rows,
    setDbDown: (down: boolean) => { dbDown = down; },
    fakePrisma
  };
});

vi.mock("../lib/db.js", () => ({
  prisma: harness.fakePrisma,
  getLocalUser: async () => ({ id: "u-test" })
}));

import { PlanTasksTool } from "./plan-tasks.js";
import { UpdateTaskTool } from "./tasks.js";
import { clearTaskStore } from "./task-store.js";
import type { ToolExecutionContext } from "../lib/tools.js";

const CONV = "conv-tasks-test";
const context: ToolExecutionContext = { workspaceRoot: "C:/tmp", userId: "u-test", conversationId: CONV };

const planTool = new PlanTasksTool();
const updateTool = new UpdateTaskTool();

beforeEach(() => {
  harness.rows.length = 0;
  harness.setDbDown(false);
  clearTaskStore(CONV);
});

afterEach(() => {
  clearTaskStore(CONV);
});

describe("unified task store (plan_tasks ↔ update_task)", () => {
  it("plan_tasks persists rows with replace-all semantics", async () => {
    await planTool.execute({ tasks: ["first", "second"] }, context);
    await planTool.execute({ tasks: ["alpha", "beta", "gamma"] }, context);

    expect(harness.rows.length).toBe(3);
    expect(harness.rows.map((r) => r.taskId)).toEqual(["task-1", "task-2", "task-3"]);
    expect(harness.rows[0].content).toBe("alpha");
  });

  it("update_task finds and updates tasks created by plan_tasks (the round-trip that used to fail)", async () => {
    await planTool.execute({ tasks: ["Install deps", "Write tests"] }, context);

    const started = await updateTool.execute({ id: "task-1", status: "in_progress" }, context);
    expect(started.success).toBe(true);

    const done = await updateTool.execute({ id: "task-1", status: "completed" }, context);
    expect(done.success).toBe(true);
    const tasks = (done.data as { tasks: Array<{ id: string; status: string }> }).tasks;
    expect(tasks.find((t) => t.id === "task-1")?.status).toBe("completed");
  });

  it("accepts a newline-delimited string plan", async () => {
    const result = await planTool.execute({ tasks: "1. first step\n2. second step" }, context);
    expect(result.success).toBe(true);
    expect(((result.data as { tasks: unknown[] }).tasks)).toHaveLength(2);
  });
});

describe("task lifecycle discipline", () => {
  it("blocks pending → completed when other tasks are still open", async () => {
    await planTool.execute({ tasks: ["one", "two"] }, context);
    const result = await updateTool.execute({ id: "task-1", status: "completed" }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/in_progress before completing/i);
  });

  it("allows pending → completed for the last open task (wrap-up relaxation)", async () => {
    await planTool.execute({ tasks: ["one"] }, context);
    const result = await updateTool.execute({ id: "task-1", status: "completed" }, context);
    expect(result.success).toBe(true);
  });

  it("allows pending → in_progress freely", async () => {
    await planTool.execute({ tasks: ["one", "two"] }, context);
    const result = await updateTool.execute({ id: "task-2", status: "in_progress" }, context);
    expect(result.success).toBe(true);
  });
});

describe("DB-unavailable fallback", () => {
  it("plan_tasks falls back to the in-memory store when the database is down", async () => {
    harness.setDbDown(true);
    const result = await planTool.execute({ tasks: ["fallback task"] }, context);
    expect(result.success).toBe(true);
    expect((result.data as { tasks: Array<{ content: string }> }).tasks[0].content).toBe("fallback task");
  });

  it("update_task round-trips against the in-memory fallback in the same DB-down environment", async () => {
    harness.setDbDown(true);
    await planTool.execute({ tasks: ["a", "b"] }, context);

    // Wrong id still gives a helpful failure…
    const started = await updateTool.execute({ id: "task-a", status: "in_progress" }, context);
    expect(started.success).toBe(false); // plan uses task-1/task-2 ids

    // …and the real round-trip works against the in-memory store.
    const ok = await updateTool.execute({ id: "task-2", status: "in_progress" }, context);
    expect(ok.success).toBe(true);
  });
});
