import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, getLocalUser } from "../lib/db.js";

const createConversationSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  workspaceId: z.string().min(1).optional()
});

const updateConversationSchema = z.object({
  title: z.string().min(1).max(120)
});

const conversationParamsSchema = z.object({
  id: z.string().min(1)
});

export async function registerConversationRoutes(app: FastifyInstance) {
  const getConversationsSchema = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().min(1).max(100).default(50)
  });

  app.get("/conversations", async (request, reply) => {
    const parsed = getConversationsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid query params" });
    }
    
    const { cursor, limit } = parsed.data;
    const user = await getLocalUser();
    
    const conversations = await prisma.conversation.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        title: true,
        updatedAt: true,
        workspaceId: true,
        workspace: {
          select: { name: true, path: true }
        },
        _count: { select: { messages: true } }
      }
    });

    let nextCursor: string | undefined = undefined;
    if (conversations.length > limit) {
      const nextItem = conversations.pop();
      nextCursor = nextItem?.id;
    }

    return { items: conversations, nextCursor };
  });

  app.post("/conversations/:id/fork", async (request, reply) => {
    const paramsParsed = conversationParamsSchema.safeParse(request.params);
    const bodyParsed = z.object({ messageId: z.string() }).safeParse(request.body ?? {});
    
    if (!paramsParsed.success || !bodyParsed.success) {
      return reply.code(400).send({ message: "Invalid parameters" });
    }

    const { id } = paramsParsed.data;
    const { messageId } = bodyParsed.data;
    const user = await getLocalUser();

    const original = await prisma.conversation.findUnique({
      where: { id, userId: user.id }
    });

    if (!original) {
      return reply.code(404).send({ message: "Conversation not found" });
    }

    const messages = await prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "asc" }
    });

    const targetIndex = messages.findIndex(m => m.id === messageId);
    if (targetIndex === -1) {
      return reply.code(404).send({ message: "Message not found in conversation" });
    }

    const messagesToCopy = messages.slice(0, targetIndex + 1);

    const forked = await prisma.conversation.create({
      data: {
        userId: user.id,
        title: `${original.title || 'Conversation'} (Forked)`,
        workspaceId: original.workspaceId,
        messages: {
          create: messagesToCopy.map(m => ({
            role: m.role,
            content: m.content,
            mode: m.mode,
            memoryText: m.memoryText,
            metadata: m.metadata ?? undefined,
            model: m.model,
            provider: m.provider,
            createdAt: m.createdAt
          }))
        }
      }
    });

    return forked;
  });

  app.post("/conversations", async (request, reply) => {
    const parsed = createConversationSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const user = await getLocalUser();

    // Validate workspace ownership if workspaceId is provided
    if (parsed.data.workspaceId) {
      const ws = await prisma.workspace.findFirst({
        where: { id: parsed.data.workspaceId, userId: user.id }
      });
      if (!ws) {
        return reply.code(400).send({ message: "Workspace not found" });
      }
    }

    const created = await prisma.conversation.create({
      data: {
        userId: user.id,
        workspaceId: parsed.data.workspaceId,
        title: parsed.data.title ?? "New chat"
      }
    });

    return created;
  });

  app.patch("/conversations/:id", async (request, reply) => {
    const params = conversationParamsSchema.safeParse(request.params);
    const body = updateConversationSchema.safeParse(request.body ?? {});

    if (!params.success || !body.success) {
      return reply.code(400).send({ message: "Invalid request" });
    }

    const user = await getLocalUser();
    const existing = await prisma.conversation.findFirst({
      where: {
        id: params.data.id,
        userId: user.id
      }
    });

    if (!existing) {
      return reply.code(404).send({ message: "Conversation not found" });
    }

    const updated = await prisma.conversation.update({
      where: { id: existing.id },
      data: {
        title: body.data.title,
        updatedAt: new Date()
      }
    });

    return updated;
  });

  app.delete("/conversations/:id", async (request, reply) => {
    const params = conversationParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ message: "Invalid params" });
    }

    const user = await getLocalUser();
    const existing = await prisma.conversation.findFirst({
      where: {
        id: params.data.id,
        userId: user.id
      }
    });

    if (!existing) {
      return reply.code(404).send({ message: "Conversation not found" });
    }

    await prisma.conversation.delete({ where: { id: existing.id } });

    return { ok: true };
  });

  app.delete("/conversations", async () => {
    const user = await getLocalUser();
    
    const result = await prisma.conversation.deleteMany({
      where: { userId: user.id }
    });

    return { ok: true, count: result.count };
  });

  app.get("/conversations/:id/messages", async (request, reply) => {
    const params = conversationParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ message: "Invalid params" });
    }

    const user = await getLocalUser();
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: params.data.id,
        userId: user.id
      },
      select: {
        id: true,
        workspaceId: true,
        workspace: {
          select: { name: true, path: true }
        }
      }
    });

    if (!conversation) {
      return reply.code(404).send({ message: "Conversation not found" });
    }

    const rawMessages = await prisma.message.findMany({
      where: { conversationId: params.data.id },
      orderBy: { createdAt: "asc" }
    });

    // Deduplicate: if consecutive messages have identical role and content
    // and were created within 5 minutes of each other, keep only the first.
    // This handles duplicates created by SSE stream retries.
    const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
    const messages: typeof rawMessages = [];

    for (const msg of rawMessages) {
      if (messages.length > 0) {
        const lastKept = messages[messages.length - 1];
        if (
          lastKept.role === msg.role &&
          lastKept.content === msg.content
        ) {
          // Same role, same content - check time difference
          const timeDiff = msg.createdAt.getTime() - lastKept.createdAt.getTime();
          if (timeDiff <= DEDUP_WINDOW_MS) {
            // Skip this duplicate
            continue;
          }
        }
      }
      messages.push(msg);
    }

    return { messages, workspaceId: conversation.workspaceId, workspace: conversation.workspace };
  });
}
