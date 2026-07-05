// Agent control routes (research UX P2-C).
//
// The Exit Hatch and related mid-run interventions: pause, resume, redirect,
// abort. These are the only routes that can change the behaviour of a
// running agent loop. They mutate the in-memory `exitHatchRegistry` state
// (which the agent loop checks at safe points), and the agent emits SSE
// events back to the frontend to confirm the state change.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { exitHatchRegistry, buildExitHatchEvent } from "../lib/exit-hatch.js";
import { getLocalUser, prisma } from "../lib/db.js";

const pauseSchema = z.object({
  reason: z.string().max(200).optional()
});

const redirectSchema = z.object({
  prompt: z.string().min(1).max(8000)
});

const abortSchema = z.object({
  reason: z.string().max(200).optional()
});

async function assertRunAccess(runId: string) {
  const user = await getLocalUser();
  const run = await prisma.agentRun.findFirst({
    where: {
      id: runId,
      conversation: { userId: user.id }
    },
    select: { id: true, status: true, conversationId: true }
  });
  if (!run) return { user, run: null };
  return { user, run };
}

export async function registerAgentControlRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/agent/runs/:id/pause
  app.post("/agent/runs/:id/pause", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ message: "Invalid params", issues: params.error.issues });
    }
    const body = pauseSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ message: "Invalid body", issues: body.error.issues });
    }
    const { run } = await assertRunAccess(params.data.id);
    if (!run) return reply.code(404).send({ message: "Run not found" });
    if (run.status !== "running") {
      return reply.code(409).send({ message: `Run is ${run.status}, cannot pause` });
    }
    const state = exitHatchRegistry().pause(run.id);
    return { ok: true, event: buildExitHatchEvent(state) };
  });

  // POST /api/agent/runs/:id/resume
  app.post("/agent/runs/:id/resume", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ message: "Invalid params", issues: params.error.issues });
    }
    const { run } = await assertRunAccess(params.data.id);
    if (!run) return reply.code(404).send({ message: "Run not found" });
    const state = exitHatchRegistry().resume(run.id);
    return { ok: true, event: buildExitHatchEvent(state) };
  });

  // POST /api/agent/runs/:id/redirect
  app.post("/agent/runs/:id/redirect", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ message: "Invalid params", issues: params.error.issues });
    }
    const body = redirectSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ message: "Invalid body", issues: body.error.issues });
    }
    const { run } = await assertRunAccess(params.data.id);
    if (!run) return reply.code(404).send({ message: "Run not found" });
    if (run.status !== "running") {
      return reply.code(409).send({ message: `Run is ${run.status}, cannot redirect` });
    }
    const state = exitHatchRegistry().redirect(run.id, body.data.prompt);
    return { ok: true, event: buildExitHatchEvent(state) };
  });

  // POST /api/agent/runs/:id/abort
  app.post("/agent/runs/:id/abort", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ message: "Invalid params", issues: params.error.issues });
    }
    const body = abortSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ message: "Invalid body", issues: body.error.issues });
    }
    const { run } = await assertRunAccess(params.data.id);
    if (!run) return reply.code(404).send({ message: "Run not found" });
    const state = exitHatchRegistry().abort(run.id);
    // Mark the run as failed in the DB so the next /runs query shows it correctly.
    try {
      await prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: "aborted",
          errorMessage: body.data.reason ?? "Aborted by user",
          completedAt: new Date()
        }
      });
    } catch {
      // Best-effort.
    }
    return { ok: true, event: buildExitHatchEvent(state) };
  });

  // GET /api/agent/runs/:id/exit-hatch — read current state
  app.get("/agent/runs/:id/exit-hatch", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ message: "Invalid params", issues: params.error.issues });
    }
    const { run } = await assertRunAccess(params.data.id);
    if (!run) return reply.code(404).send({ message: "Run not found" });
    const state = exitHatchRegistry().get(run.id);
    return {
      runId: run.id,
      status: run.status,
      hatch: state ? buildExitHatchEvent(state) : null
    };
  });
}
