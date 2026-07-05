// Agent workspace resolution helpers.
//
// Determines which filesystem workspace an agent request should execute
// against. Multi-workspace aware: the caller must supply a workspaceId
// (directly or indirectly via conversation). We never auto-create or
// auto-activate workspaces here.

import { basename, resolve } from "node:path";
import { prisma, getLocalUser } from "../../lib/db.js";

export function getDefaultWorkspaceRoot() {
  const configuredRoot = process.env.DEFAULT_WORKSPACE_ROOT ?? process.env.WORKSPACE_ROOT ?? process.env.INIT_CWD;
  if (configuredRoot?.trim()) {
    return resolve(configuredRoot);
  }

  const cwd = process.cwd();
  return basename(cwd).toLowerCase() === "server" ? resolve(cwd, "..") : resolve(cwd);
}

/**
 * Resolve the workspace an agent request should run against.
 *
 * Multi-workspace behavior: there is no longer a single "active" workspace
 * that the agent falls back to. The caller MUST supply an explicit
 * `workspaceId` (either directly on the request, or indirectly via an
 * existing `conversationId` whose row already points at a workspace).
 *
 * If neither is available we surface a clear 400-style error so the frontend
 * can show the workspaces modal and ask the user to pick one. We do NOT
 * auto-create or auto-activate any workspace, because doing so was the
 * single biggest reason an in-flight agent in workspace A was getting
 * killed when the user touched workspace B.
 */
export async function resolveAgentWorkspace(
  userId: string,
  options: { workspaceId?: string; conversationId?: string }
): Promise<{ id: string; path: string; name: string; isActive: boolean }> {
  // 1. Explicit payload wins.
  if (options.workspaceId) {
    const workspace = await prisma.workspace.findFirst({
      where: { id: options.workspaceId, userId }
    });
    if (!workspace) {
      throw new Error("Workspace not found");
    }
    return workspace;
  }

  // 2. Existing conversation pins the workspace — this is the common case
  //    for "continue an in-flight agent in workspace A from any UI surface."
  if (options.conversationId) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: options.conversationId, userId },
      select: { workspaceId: true }
    });
    if (conversation?.workspaceId) {
      const workspace = await prisma.workspace.findFirst({
        where: { id: conversation.workspaceId, userId }
      });
      if (workspace) {
        return workspace;
      }
    }
  }

  // 3. Last-resort fallback for the very first run on a brand-new install:
  //    use the most recently updated workspace the user already has. We do
  //    NOT mutate `isActive` — that field is purely a UI hint now.
  const recent = await prisma.workspace.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" }
  });

  if (recent) {
    return recent;
  }

  throw new Error("No workspace selected. Please open a workspace first.");
}

export async function getOrCreateAgentWorkspace(userId: string, workspaceId?: string) {
  return workspaceId
    ? prisma.workspace.findFirst({ where: { id: workspaceId, userId } })
    : prisma.workspace.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } });
}

export async function resolveWorkspaceForUser(userId: string, workspaceId?: string) {
  const workspace = await getOrCreateAgentWorkspace(userId, workspaceId);
  if (!workspace) {
    throw new Error("No workspace selected. Please open a workspace first.");
  }
  return workspace;
}
