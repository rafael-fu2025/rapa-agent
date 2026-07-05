import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, getLocalUser } from "../lib/db.js";
import { encryptText, decryptText } from "../lib/crypto.js";

function maskKey() {
  return "••••••••••••";
}

function serializeKey(key: {
  id: string;
  name: string;
  isActive: boolean;
  autoSwitch: boolean;
  createdAt: Date;
}) {
  return {
    id: key.id,
    name: key.name,
    maskedKey: maskKey(),
    isActive: key.isActive,
    autoSwitch: key.autoSwitch,
    createdAt: key.createdAt.toISOString(),
  };
}

export async function registerServiceKeyRoutes(app: FastifyInstance) {
  const serviceSchema = z.object({ service: z.string().min(1) });

  // GET /service-keys?service=serper
  app.get("/service-keys", async (request, reply) => {
    const parsed = serviceSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ message: "service param required" });
    }
    const user = await getLocalUser();
    const keys = await prisma.serviceApiKey.findMany({
      where: { userId: user.id, service: parsed.data.service },
      orderBy: { createdAt: "asc" },
    });
    const autoSwitch = keys.some((k) => k.autoSwitch);
    return { keys: keys.map(serializeKey), autoSwitch };
  });

  // POST /service-keys
  const addKeySchema = z.object({
    service: z.string().min(1),
    name: z.string().min(1).max(80),
    apiKey: z.string().min(1),
  });

  app.post("/service-keys", async (request, reply) => {
    const parsed = addKeySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }
    const secret = process.env.APP_SECRET;
    if (!secret) return reply.code(500).send({ message: "APP_SECRET not configured" });

    const user = await getLocalUser();
    const { service, name, apiKey } = parsed.data;

    // Check name uniqueness
    const existing = await prisma.serviceApiKey.findUnique({
      where: { userId_service_name: { userId: user.id, service, name } },
    });
    if (existing) {
      return reply.code(409).send({ message: "A key with this name already exists" });
    }

    // Check if this is the first key — make it active
    const count = await prisma.serviceApiKey.count({ where: { userId: user.id, service } });
    const isFirstKey = count === 0;

    const created = await prisma.serviceApiKey.create({
      data: {
        userId: user.id,
        service,
        name,
        apiKeyEncrypted: encryptText(apiKey, secret),
        isActive: isFirstKey,
      },
    });

    return serializeKey(created);
  });

  // PATCH /service-keys/:id
  const updateKeySchema = z.object({
    name: z.string().min(1).max(80).optional(),
    apiKey: z.string().min(1).optional(),
  });

  app.patch("/service-keys/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateKeySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload" });
    }
    const secret = process.env.APP_SECRET;
    if (!secret) return reply.code(500).send({ message: "APP_SECRET not configured" });

    const user = await getLocalUser();
    const key = await prisma.serviceApiKey.findFirst({ where: { id, userId: user.id } });
    if (!key) return reply.code(404).send({ message: "Key not found" });

    const data: { name?: string; apiKeyEncrypted?: string } = {};
    if (parsed.data.name) data.name = parsed.data.name;
    if (parsed.data.apiKey) data.apiKeyEncrypted = encryptText(parsed.data.apiKey, secret);

    const updated = await prisma.serviceApiKey.update({ where: { id }, data });
    return serializeKey(updated);
  });

  // DELETE /service-keys/:id
  app.delete("/service-keys/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = await getLocalUser();
    const key = await prisma.serviceApiKey.findFirst({ where: { id, userId: user.id } });
    if (!key) return reply.code(404).send({ message: "Key not found" });

    await prisma.serviceApiKey.delete({ where: { id } });

    // If deleted key was active, promote the next one
    if (key.isActive) {
      const next = await prisma.serviceApiKey.findFirst({
        where: { userId: user.id, service: key.service },
        orderBy: { createdAt: "asc" },
      });
      if (next) {
        await prisma.serviceApiKey.update({ where: { id: next.id }, data: { isActive: true } });
      }
    }

    return { ok: true };
  });

  // POST /service-keys/active — set active key
  const activeSchema = z.object({
    service: z.string().min(1),
    keyId: z.string().min(1),
  });

  app.post("/service-keys/active", async (request, reply) => {
    const parsed = activeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ message: "Invalid payload" });

    const user = await getLocalUser();
    const { service, keyId } = parsed.data;

    // Verify key belongs to user
    const key = await prisma.serviceApiKey.findFirst({ where: { id: keyId, userId: user.id, service } });
    if (!key) return reply.code(404).send({ message: "Key not found" });

    // Deactivate all, activate selected
    await prisma.serviceApiKey.updateMany({ where: { userId: user.id, service }, data: { isActive: false } });
    await prisma.serviceApiKey.update({ where: { id: keyId }, data: { isActive: true } });

    return { ok: true };
  });

  // PATCH /service-keys/auto-switch — toggle auto-switch for a service
  const autoSwitchSchema = z.object({
    service: z.string().min(1),
    enabled: z.boolean(),
  });

  app.patch("/service-keys/auto-switch", async (request, reply) => {
    const parsed = autoSwitchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ message: "Invalid payload" });

    const user = await getLocalUser();
    await prisma.serviceApiKey.updateMany({
      where: { userId: user.id, service: parsed.data.service },
      data: { autoSwitch: parsed.data.enabled },
    });

    return { ok: true };
  });

  // GET /service-keys/:id/decrypt — get decrypted value for view/edit
  app.get("/service-keys/:id/decrypt", async (request, reply) => {
    const { id } = request.params as { id: string };
    const secret = process.env.APP_SECRET;
    if (!secret) return reply.code(500).send({ message: "APP_SECRET not configured" });

    const user = await getLocalUser();
    const key = await prisma.serviceApiKey.findFirst({ where: { id, userId: user.id } });
    if (!key) return reply.code(404).send({ message: "Key not found" });

    try {
      const decrypted = decryptText(key.apiKeyEncrypted, secret);
      return { id: key.id, name: key.name, apiKey: decrypted };
    } catch {
      return reply.code(400).send({ message: "Failed to decrypt key" });
    }
  });
}
