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

const messagesQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(2000).optional()
});

export async function registerConversationRoutes(app: FastifyInstance) {
  const getConversationsSchema = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().min(1).max(100).default(50),
    // Optional title search — server-side so results are not limited to
    // the pages the client happens to have loaded (audit M3).
    q: z.string().min(1).max(200).optional()
  });

  app.get("/conversations", async (request, reply) => {
    const parsed = getConversationsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid query params" });
    }

    const { cursor, limit, q } = parsed.data;
    const user = await getLocalUser();

    const conversations = await prisma.conversation.findMany({
      where: {
        userId: user.id,
        ...(q ? { title: { contains: q } } : {})
      },
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

  // Total conversation count — powers the destructive Delete All confirm
  // with the true number instead of the loaded page size (audit M3).
  app.get("/conversations/count", async () => {
    const user = await getLocalUser();
    const count = await prisma.conversation.count({ where: { userId: user.id } });
    return { count };
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
            // Forks previously dropped the per-turn reasoning effort —
            // the first message after forking then fell back to the
            // provider default (audit M3).
            reasoningEffort: m.reasoningEffort,
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
      return reply.code(400).send({ message: "Invalid params", issues: params.error.issues });
    }

    const query = messagesQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return reply.code(400).send({ message: "Invalid query", issues: query.error.issues });
    }
    const limitParam = Math.max(1, Math.min(2_000, Math.floor(query.data.limit ?? 500)));

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

    // Bound the payload: conversations can grow unbounded, and the whole
    // array is serialized to the client in one response. Default 500 most
    // recent messages, oldest-first; `limit` query param adjusts (max 2000).
    const rawMessages = await prisma.message.findMany({
      where: { conversationId: params.data.id },
      orderBy: { createdAt: "desc" },
      take: limitParam
    });
    rawMessages.reverse();

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

  // Message-level deletion. Two modes (exactly one required):
  //  - { messageId }: delete a single message.
  //  - { afterMessageId }: delete every message AFTER that message — the
  //    server-side counterpart of "resend edit", which previously truncated
  //    the conversation locally only and duplicated history on reload
  //    (audit M1.3). AgentRun references to deleted messages are SetNull
  //    by schema, so run history survives with detached refs.
  const deleteMessagesSchema = z
    .object({
      messageId: z.string().min(1).optional(),
      afterMessageId: z.string().min(1).optional()
    })
    .refine((data) => (data.messageId ? !data.afterMessageId : !!data.afterMessageId), {
      message: "Provide exactly one of messageId or afterMessageId"
    });

  app.delete("/conversations/:id/messages", async (request, reply) => {
    const params = conversationParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ message: "Invalid params", issues: params.error.issues });
    }

    const body = deleteMessagesSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: body.error.issues });
    }

    const user = await getLocalUser();
    const conversation = await prisma.conversation.findFirst({
      where: { id: params.data.id, userId: user.id },
      select: { id: true }
    });
    if (!conversation) {
      return reply.code(404).send({ message: "Conversation not found" });
    }

    // Resolve the anchor message (the one to delete, or the one after
    // which everything is deleted). Both must belong to this conversation.
    const anchorId = body.data.messageId ?? body.data.afterMessageId;
    const anchor = await prisma.message.findFirst({
      where: { id: anchorId, conversationId: conversation.id },
      select: { id: true, createdAt: true }
    });
    if (!anchor) {
      return reply.code(404).send({ message: "Message not found" });
    }

    const where =
      body.data.messageId
        ? { id: body.data.messageId, conversationId: conversation.id }
        : { conversationId: conversation.id, createdAt: { gt: anchor.createdAt }, NOT: { id: anchor.id } };

    const result = await prisma.message.deleteMany({ where });

    // Message deletes change the conversation's effective updatedAt —
    // keep the sidebar ordering anchored to real activity.
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() }
    });

    return { ok: true, count: result.count };
  });

  // Mark an assistant message's interactive card as answered. Scoped to
  // the `interactive.answered` flag only — content is not editable here.
  const patchMessageSchema = z.object({
    interactiveAnswered: z.literal(true)
  });

  app.patch("/conversations/:id/messages/:messageId", async (request, reply) => {
    const params = z
      .object({ id: z.string().min(1), messageId: z.string().min(1) })
      .safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ message: "Invalid params", issues: params.error.issues });
    }

    const body = patchMessageSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: body.error.issues });
    }

    const user = await getLocalUser();
    const conversation = await prisma.conversation.findFirst({
      where: { id: params.data.id, userId: user.id },
      select: { id: true }
    });
    if (!conversation) {
      return reply.code(404).send({ message: "Conversation not found" });
    }

    const message = await prisma.message.findFirst({
      where: { id: params.data.messageId, conversationId: conversation.id },
      select: { id: true, metadata: true }
    });
    if (!message) {
      return reply.code(404).send({ message: "Message not found" });
    }

    const metadata =
      (message.metadata as Record<string, unknown> | null) ?? {};
    const interactive =
      (metadata.interactive as Record<string, unknown> | null | undefined) ?? {};
    const nextMetadata = {
      ...metadata,
      interactive: { ...interactive, answered: true }
    };

    const updated = await prisma.message.update({
      where: { id: message.id },
      data: { metadata: nextMetadata },
      select: { id: true }
    });

    return { ok: true, id: updated.id };
  });
}
