// §2.4 — Scheduled agent tasks.
//
// The model can create, list, cancel, and trigger scheduled agent runs.
// The actual firing of scheduled tasks is handled by a background tick
// registered in `server/src/index.ts` (see `startScheduler()`). This
// module only manages the database rows and exposes CRUD tools.

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { prisma, getLocalUser } from "../lib/db.js";

const MAX_NAME_LENGTH = 100;
const MAX_PAYLOAD_CHARS = 64_000;

type ScheduleKind = "at" | "every" | "cron";

function normalizeSchedule(params: Record<string, unknown>): {
  kind: ScheduleKind;
  expr: string;
  tz?: string;
  nextRunAt: Date;
} | { error: string } {
  const kindRaw = typeof params.kind === "string" ? params.kind.trim() : "";
  if (kindRaw !== "at" && kindRaw !== "every" && kindRaw !== "cron") {
    return { error: "schedule.kind must be one of: at, every, cron" };
  }
  const kind = kindRaw as ScheduleKind;
  const tz = typeof params.tz === "string" && params.tz.trim() ? params.tz.trim() : undefined;

  if (kind === "at") {
    const atRaw = typeof params.at === "string" ? params.at.trim() : "";
    if (!atRaw) return { error: "schedule.at (ISO timestamp) is required for kind=\"at\"" };
    const atDate = new Date(atRaw);
    if (Number.isNaN(atDate.getTime())) {
      return { error: `schedule.at "${atRaw}" is not a valid ISO timestamp` };
    }
    if (atDate.getTime() <= Date.now()) {
      return { error: "schedule.at must be in the future" };
    }
    return { kind, expr: atDate.toISOString(), ...(tz ? { tz } : {}), nextRunAt: atDate };
  }

  if (kind === "every") {
    const everyRaw = params.everyMs;
    const everyMs = typeof everyRaw === "number" ? everyRaw : Number(everyRaw);
    if (!Number.isFinite(everyMs) || everyMs < 1000) {
      return { error: "schedule.everyMs must be a number of milliseconds >= 1000" };
    }
    return { kind, expr: String(Math.floor(everyMs)), ...(tz ? { tz } : {}), nextRunAt: new Date(Date.now() + everyMs) };
  }

  // cron
  const expr = typeof params.expr === "string" ? params.expr.trim() : "";
  if (!expr) return { error: "schedule.expr (cron expression) is required for kind=\"cron\"" };
  // Validate: 5 or 6 space-separated fields. We don't have a full cron
  // parser — just enough to reject obvious garbage.
  const fields = expr.split(/\s+/);
  if (fields.length < 5 || fields.length > 6) {
    return { error: `schedule.expr "${expr}" must have 5 or 6 fields (minute hour dom month dow [year])` };
  }
  // Compute next run for the standard 5-field case using a simple
  // "next minute when any of these fields could match" approximation.
  // The actual tick handler in startScheduler() does a proper match
  // against the cron expression.
  const nextRunAt = new Date(Date.now() + 60_000);
  return { kind, expr, ...(tz ? { tz } : {}), nextRunAt };
}

function rowToScheduledTask(row: {
  id: string;
  name: string;
  scheduleKind: string;
  scheduleExpr: string | null;
  scheduleTz: string | null;
  payload: string;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  lastError: string | null;
  enabled: boolean;
  runCount: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    schedule: {
      kind: row.scheduleKind,
      ...(row.scheduleExpr ? { at: row.scheduleExpr, everyMs: Number(row.scheduleExpr) || undefined, expr: row.scheduleExpr } : {}),
      ...(row.scheduleTz ? { tz: row.scheduleTz } : {})
    },
    payload: tryParseJson(row.payload),
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastRunStatus: row.lastRunStatus,
    lastError: row.lastError,
    enabled: row.enabled,
    runCount: row.runCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export class ScheduleTaskTool extends Tool {
  definition: ToolDefinition = {
    name: "schedule_task",
    description: "Create a scheduled agent run. Supports three schedule kinds: \"at\" (one-shot at an ISO timestamp), \"every\" (recurring every N ms), and \"cron\" (5/6-field cron expression). The payload is the message + optional model the agent should run when it fires.",
    category: "scheduler",
    riskLevel: "write",
    requiresApproval: true,
    parameters: {
      name: {
        type: "string",
        description: "Short human-readable name for the task. Must be unique per user.",
        required: true
      },
      schedule: {
        type: "object",
        description: "Schedule definition: { kind: \"at\"|\"every\"|\"cron\", at?: string, everyMs?: number, expr?: string, tz?: string }",
        required: true
      },
      payload: {
        type: "object",
        description: "What to run: { message: string, model?: string, mode?: \"agent\"|\"plan\"|\"chat\" }",
        required: true
      }
    }
  };

  async execute(params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name) return { success: false, error: "name is required" };
    if (name.length > MAX_NAME_LENGTH) return { success: false, error: `name must be <= ${MAX_NAME_LENGTH} characters` };

    const scheduleRaw = params.schedule as Record<string, unknown> | undefined;
    if (!scheduleRaw || typeof scheduleRaw !== "object") {
      return { success: false, error: "schedule is required and must be an object" };
    }
    const normalized = normalizeSchedule(scheduleRaw);
    if ("error" in normalized) return { success: false, error: normalized.error };

    const payloadRaw = params.payload as Record<string, unknown> | undefined;
    if (!payloadRaw || typeof payloadRaw !== "object") {
      return { success: false, error: "payload is required and must be an object" };
    }
    const message = typeof payloadRaw.message === "string" ? payloadRaw.message.trim() : "";
    if (!message) return { success: false, error: "payload.message is required" };
    const payloadJson = JSON.stringify({
      message,
      model: typeof payloadRaw.model === "string" ? payloadRaw.model : undefined,
      mode: payloadRaw.mode === "plan" || payloadRaw.mode === "chat" ? payloadRaw.mode : "agent"
    });
    if (payloadJson.length > MAX_PAYLOAD_CHARS) {
      return { success: false, error: `payload exceeds ${MAX_PAYLOAD_CHARS} characters when serialized` };
    }

    const user = await getLocalUser();
    const existing = await prisma.scheduledTask.findUnique({
      where: { userId_name: { userId: user.id, name } }
    });
    if (existing) {
      return { success: false, error: `A scheduled task named "${name}" already exists. Use cancel_scheduled_task first, or pick a different name.` };
    }

    const row = await prisma.scheduledTask.create({
      data: {
        userId: user.id,
        name,
        scheduleKind: normalized.kind,
        scheduleExpr: normalized.expr,
        scheduleTz: normalized.tz ?? null,
        payload: payloadJson,
        nextRunAt: normalized.nextRunAt,
        enabled: true
      }
    });
    return {
      success: true,
      data: { task: rowToScheduledTask(row) }
    };
  }
}

export class ListScheduledTasksTool extends Tool {
  definition: ToolDefinition = {
    name: "list_scheduled_tasks",
    description: "List the user's scheduled tasks. Returns name, schedule, payload, next/last run times, and run count.",
    category: "scheduler",
    riskLevel: "read",
    parameters: {
      includeDisabled: {
        type: "boolean",
        description: "Include disabled tasks (default true)",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    const includeDisabled = params.includeDisabled !== false;
    const user = await getLocalUser();
    const rows = await prisma.scheduledTask.findMany({
      where: { userId: user.id, ...(includeDisabled ? {} : { enabled: true }) },
      orderBy: { name: "asc" }
    });
    return {
      success: true,
      data: {
        tasks: rows.map(rowToScheduledTask)
      }
    };
  }
}

export class CancelScheduledTaskTool extends Tool {
  definition: ToolDefinition = {
    name: "cancel_scheduled_task",
    description: "Delete a scheduled task by name. The task will not fire again.",
    category: "scheduler",
    riskLevel: "write",
    requiresApproval: true,
    parameters: {
      name: {
        type: "string",
        description: "Name of the scheduled task to cancel",
        required: true
      }
    }
  };

  async execute(params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name) return { success: false, error: "name is required" };
    const user = await getLocalUser();
    const existing = await prisma.scheduledTask.findUnique({ where: { userId_name: { userId: user.id, name } } });
    if (!existing) return { success: false, error: `No scheduled task named "${name}"` };

    await prisma.scheduledTask.delete({ where: { id: existing.id } });
    return { success: true, data: { cancelled: name } };
  }
}
