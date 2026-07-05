import type { FastifyInstance } from "fastify";

import { prisma } from "../lib/db.js";
import { toolCircuitBreaker } from "../lib/agent/circuit-breaker.js";
import { toolRegistry } from "../tools/index.js";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async (_, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true, ts: new Date().toISOString(), db: "connected", uptime: process.uptime() };
    } catch (err) {
      reply.status(503).send({ ok: false, ts: new Date().toISOString(), db: "disconnected", uptime: process.uptime() });
    }
  });

  /**
   * Circuit-breaker dashboard endpoint. Returns the current state of every
   * tool's circuit breaker. Useful for ops dashboards and the production
   * readiness rollout (research Phase 5).
   */
  app.get("/health/circuits", async () => {
    const snapshot: Record<string, ReturnType<typeof toolCircuitBreaker.snapshot>> = {};
    for (const def of toolRegistry.list()) {
      snapshot[def.name] = toolCircuitBreaker.snapshot(def.name);
    }
    return {
      ts: new Date().toISOString(),
      circuits: snapshot
    };
  });
}
