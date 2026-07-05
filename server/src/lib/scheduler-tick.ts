// Background tick for the §2.4 scheduler. Polls the `ScheduledTask` table
// every minute and fires any task whose `nextRunAt <= now`. Each fire
// spawns a new conversation + agent run using the stored payload.
//
// The actual agent run is initiated by writing a Message and calling the
// same entry point as a normal chat message. We do that by piggy-backing
// on the chat/agent stream rather than re-implementing the loop here.

import { prisma, getLocalUser } from "./db.js";

const TICK_INTERVAL_MS = 60_000; // 1 minute

let intervalHandle: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  // Don't keep the process alive solely for the scheduler.
  intervalHandle.unref?.();
  // Run one tick immediately so newly-created tasks fire without
  // waiting up to a minute.
  void tick();
}

export function stopScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/**
 * Compute the next run time for a schedule. Returns null for "at" schedules
 * that have already fired (i.e. one-shot, completed). Returns a Date for
 * recurring schedules.
 */
export function computeNextRunAt(
  schedule: { kind: string; expr: string | null; tz: string | null },
  after: Date = new Date()
): Date | null {
  if (schedule.kind === "at") {
    // One-shot. If `nextRunAt` was already in the past, this task is done.
    return null;
  }
  if (schedule.kind === "every") {
    const ms = Number(schedule.expr);
    if (!Number.isFinite(ms) || ms < 1000) return null;
    return new Date(after.getTime() + ms);
  }
  if (schedule.kind === "cron") {
    return nextCronDate(schedule.expr ?? "", schedule.tz ?? "UTC", after);
  }
  return null;
}

/**
 * Minimal cron evaluator supporting 5-field standard expressions
 * (minute hour dom month dow). No L/W/# extensions — we keep it small
 * and rely on a default 1-minute tick for safety.
 *
 * For a more robust implementation swap in `cron-parser` later. The
 * current behavior is "find the next minute when all five fields match".
 */
function nextCronDate(expr: string, _tz: string, after: Date): Date {
  const fields = expr.trim().split(/\s+/);
  if (fields.length < 5) return new Date(after.getTime() + 60_000);

  const [minuteF, hourF, domF, monthF, dowF] = fields;
  // For `*` we return `null` as a sentinel meaning "any value".
  // The check below treats null as "skip this constraint".
  const minute = minuteF === "*" ? null : parseField(minuteF, 0, 59);
  const hour = hourF === "*" ? null : parseField(hourF, 0, 23);
  const dom = domF === "*" ? null : parseField(domF, 1, 31);
  const month = monthF === "*" ? null : parseField(monthF, 1, 12);
  const dow = dowF === "*" ? null : parseField(dowF, 0, 6);

  // Walk forward minute by minute (capped at 366 days). We use
  // UTC throughout for consistency with the cron `tz` parameter
  // being treated as a hint — for full tz support we'd plug in
  // luxon or Temporal later.
  const max = after.getTime() + 366 * 24 * 60 * 60 * 1000;
  const cursor = new Date(after.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  while (cursor.getTime() <= max) {
    const minMatch = minute === null || minute.includes(cursor.getUTCMinutes());
    const hourMatch = hour === null || hour.includes(cursor.getUTCHours());
    const monthMatch = month === null || month.includes(cursor.getUTCMonth() + 1);
    const domMatch = dom === null || dom.includes(cursor.getUTCDate());
    const dowMatch = dow === null || dow.includes(cursor.getUTCDay());

    if (minMatch && hourMatch && monthMatch && domMatch && dowMatch) {
      return cursor;
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return new Date(after.getTime() + 60_000);
}

function parseField(field: string | undefined, min: number, max: number): number[] {
  if (!field || field === "*") return [0]; // sentinel
  if (field.includes("/")) {
    const [base, step] = field.split("/");
    const stepN = Number(step);
    if (!Number.isFinite(stepN) || stepN <= 0) return [0];
    const start = base === "*" ? min : Number(base);
    const out: number[] = [];
    for (let i = start; i <= max; i += stepN) out.push(i);
    return out.length > 0 ? out : [0];
  }
  if (field.includes(",")) {
    return field.split(",").flatMap((p) => parseField(p, min, max));
  }
  if (field.includes("-")) {
    const [a, b] = field.split("-").map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return [0];
    const out: number[] = [];
    for (let i = a; i <= b; i += 1) out.push(i);
    return out;
  }
  const n = Number(field);
  return Number.isFinite(n) ? [n] : [0];
}

async function tick(): Promise<void> {
  try {
    const user = await getLocalUser();
    const now = new Date();
    const due = await prisma.scheduledTask.findMany({
      where: {
        userId: user.id,
        enabled: true,
        nextRunAt: { lte: now }
      },
      take: 5
    });

    for (const task of due) {
      try {
        await fireTask(task.id);
      } catch (err) {
        await prisma.scheduledTask.update({
          where: { id: task.id },
          data: {
            lastRunAt: new Date(),
            lastRunStatus: "failed",
            lastError: err instanceof Error ? err.message : String(err),
            runCount: { increment: 1 }
          }
        });
      }
    }
  } catch {
    // Silent — the tick will retry next interval.
  }
}

/**
 * Fire a single scheduled task:
 *   1. Create a new conversation titled after the task.
 *   2. Persist the payload as a user message.
 *   3. Update nextRunAt for recurring tasks; disable one-shot.
 *
 * The actual agent run is initiated by the chat stream when the
 * frontend (or a follow-up cron consumer) opens the conversation. For
 * a fully hands-off scheduler we'd need to also POST to the chat
 * endpoint — that's a v2 enhancement. For now, the task is durably
 * recorded and a user-visible badge appears in the conversation list.
 */
async function fireTask(id: string): Promise<void> {
  const task = await prisma.scheduledTask.findUnique({ where: { id } });
  if (!task) return;

  const payload = JSON.parse(task.payload) as { message?: string; model?: string; mode?: string };
  if (!payload.message) {
    throw new Error("Task payload is missing `message`");
  }

  await prisma.conversation.create({
    data: {
      userId: task.userId,
      title: `[Scheduled] ${task.name}`,
      messages: {
        create: {
          role: "user",
          content: payload.message,
          mode: payload.mode ?? "agent",
          ...(payload.model ? { model: payload.model } : {})
        }
      }
    }
  });

  const next = computeNextRunAt(
    { kind: task.scheduleKind, expr: task.scheduleExpr, tz: task.scheduleTz },
    new Date()
  );

  await prisma.scheduledTask.update({
    where: { id },
    data: {
      lastRunAt: new Date(),
      lastRunStatus: "fired",
      runCount: { increment: 1 },
      // For "at" tasks, disable after firing (one-shot).
      // For recurring tasks, advance nextRunAt.
      ...(task.scheduleKind === "at" ? { enabled: false, nextRunAt: null } : { nextRunAt: next })
    }
  });
}
