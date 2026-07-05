import type { FastifyInstance } from "fastify";
import "@fastify/websocket";
import { z } from "zod";
import { resolve } from "node:path";

import { getLocalUser, prisma } from "../lib/db.js";
import {
  containsPathTraversal,
  resolveWorkspacePath,
  isWithinWorkspaceSymlinkSafe
} from "../tools/filesystem.js";
import {
  closeTerminalSession,
  ensureTerminalSession,
  listTerminalSessions,
  resizeTerminalSession,
  startBackgroundCommand,
  subscribeToTerminalSession,
  writeToTerminalSession
} from "../tools/shell.js";

const sessionQuerySchema = z.object({
  workspaceId: z.string().optional(),
  conversationId: z.string().optional(),
  sessionId: z.string().optional(),
  // Optional workspace-relative path used as the starting cwd for the
  // PTY session. When omitted, the session starts in the workspace
  // root. Validated against the same path-traversal + symlink-safety
  // guards as the file/tree routes so the terminal can't escape the
  // workspace.
  cwd: z.string().optional()
});

const sessionMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("input"),
    data: z.string()
  }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(20).max(400),
    rows: z.number().int().min(5).max(200)
  }),
  z.object({
    type: z.literal("run"),
    command: z.string().min(1)
  }),
  z.object({
    type: z.literal("close")
  })
]);

async function resolveWorkspace(userId: string, workspaceId?: string) {
  if (workspaceId) {
    return prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        userId
      }
    });
  }

  return prisma.workspace.findFirst({
    where: {
      userId,
      isActive: true
    }
  });
}

function buildSessionId(userId: string, workspacePath: string, conversationId?: string, providedSessionId?: string, cwd?: string) {
  // The session key is intentionally parameterized by `cwd` so that
  // "Open in terminal" on different sub-folders spawns distinct PTY
  // sessions. Without this, the first call to getOrCreateSession with a
  // different cwd would kill the existing session (see shell.ts), losing
  // the user's command history. Including cwd in the key means each
  // sub-folder gets its own persistent session, just like a real
  // terminal app would create new tabs.
  if (providedSessionId?.trim()) return providedSessionId.trim();
  const cwdKey = cwd ? `:${cwd}` : "";
  return `${userId}:${workspacePath}:${conversationId ?? "terminal"}${cwdKey}`;
}

export async function registerTerminalRoutes(app: FastifyInstance) {
  app.get("/terminal/sessions", async () => {
    const user = await getLocalUser();
    return {
      sessions: listTerminalSessions(user.id)
    };
  });

  const websocketHandler = async (socket: { on: (event: string, listener: (payload: Buffer | string) => void) => void; send: (data: string) => void; close: () => void }, request: { query: unknown }) => {
    const parsedQuery = sessionQuerySchema.safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      socket.send(JSON.stringify({ type: "error", message: "Invalid terminal session query" }));
      socket.close();
      return;
    }

    const user = await getLocalUser();
    const workspace = await resolveWorkspace(user.id, parsedQuery.data.workspaceId);

    if (!workspace) {
      socket.send(JSON.stringify({ type: "error", message: "No workspace selected. Please open a workspace first." }));
      socket.close();
      return;
    }

    // Resolve the optional `cwd` query param. We require it to be a
    // workspace-relative path (or "." for the root) and validate it
    // with the same path-traversal + symlink-safety guards used by
    // /file and /tree, so a malicious client can't open a shell
    // anywhere on the host.
    let effectiveCwd = workspace.path;
    if (parsedQuery.data.cwd && parsedQuery.data.cwd.length > 0) {
      if (containsPathTraversal(parsedQuery.data.cwd)) {
        socket.send(JSON.stringify({ type: "error", message: "Invalid terminal cwd" }));
        socket.close();
        return;
      }
      const resolved = resolveWorkspacePath(parsedQuery.data.cwd, workspace.path);
      if (!(await isWithinWorkspaceSymlinkSafe(resolved, workspace.path))) {
        socket.send(JSON.stringify({ type: "error", message: "Terminal cwd is outside the workspace" }));
        socket.close();
        return;
      }
      effectiveCwd = resolved;
    }

    const sessionId = buildSessionId(user.id, workspace.path, parsedQuery.data.conversationId, parsedQuery.data.sessionId, effectiveCwd);
    const subscription = await subscribeToTerminalSession(
      {
        sessionId,
        cwd: effectiveCwd,
        ownerId: user.id,
        conversationId: parsedQuery.data.conversationId
      },
      (data) => {
        socket.send(JSON.stringify({ type: "output", data }));
      }
    );

    socket.send(JSON.stringify({
      type: "ready",
      session: subscription.session,
      output: subscription.output
    }));

    socket.on("message", async (rawPayload) => {
      try {
        const payloadText = typeof rawPayload === "string" ? rawPayload : rawPayload.toString("utf-8");
        const parsedMessage = sessionMessageSchema.safeParse(JSON.parse(payloadText));

        if (!parsedMessage.success) {
          socket.send(JSON.stringify({ type: "error", message: "Invalid terminal message" }));
          return;
        }

        if (parsedMessage.data.type === "input") {
          await writeToTerminalSession({
            sessionId,
            cwd: effectiveCwd,
            ownerId: user.id,
            conversationId: parsedQuery.data.conversationId,
            data: parsedMessage.data.data
          });
          return;
        }

        if (parsedMessage.data.type === "resize") {
          const session = resizeTerminalSession(sessionId, user.id, parsedMessage.data.cols, parsedMessage.data.rows);
          socket.send(JSON.stringify({ type: "resized", session }));
          return;
        }

        if (parsedMessage.data.type === "run") {
          const session = await startBackgroundCommand({
            sessionId,
            cwd: effectiveCwd,
            ownerId: user.id,
            conversationId: parsedQuery.data.conversationId,
            command: parsedMessage.data.command
          });
          socket.send(JSON.stringify({ type: "started", session, command: parsedMessage.data.command }));
          return;
        }

        closeTerminalSession(sessionId, user.id);
        subscription.unsubscribe();
        socket.send(JSON.stringify({ type: "closed", sessionId }));
        socket.close();
      } catch (error) {
        socket.send(JSON.stringify({
          type: "error",
          message: error instanceof Error ? error.message : "Terminal message failed"
        }));
      }
    });

    socket.on("close", () => {
      subscription.unsubscribe();
    });
  };

  app.get("/ws/pty", { websocket: true }, websocketHandler);
  app.get("/ws/procws", { websocket: true }, websocketHandler);
}
