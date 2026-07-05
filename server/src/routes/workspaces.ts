// Workspace management routes

import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import {
  stat,
  access,
  readdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir as fsMkdir,
  rename as fsRename,
  rm as fsRm,
  copyFile as fsCopyFile
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { prisma, getLocalUser } from "../lib/db.js";
import {
  containsPathTraversal,
  resolveWorkspacePath,
  isWithinWorkspaceSymlinkSafe,
  toWorkspaceRelativePath
} from "../tools/filesystem.js";



const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(255),
  path: z.string().min(1)
});

const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  path: z.string().min(1).optional(),
  isActive: z.boolean().optional()
});

const workspaceParamsSchema = z.object({
  id: z.string().min(1)
});

const execFileAsync = promisify(execFile);

type PickWorkspaceFolderResult = {
  path: string | null;
  name: string | null;
  cancelled: boolean;
};

async function pickWorkspaceFolderNative(): Promise<PickWorkspaceFolderResult> {
  if (process.platform !== "win32") {
    throw new Error("Native folder browsing is only supported on Windows right now");
  }

  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = "Select the project folder"',
    "$dialog.ShowNewFolderButton = $false",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  Write-Output $dialog.SelectedPath",
    "}"
  ].join("; ");

  let lastError: unknown = null;

  for (const executable of ["pwsh", "powershell"]) {
    try {
      const { stdout } = await execFileAsync(executable, ["-NoProfile", "-STA", "-Command", script], {
        windowsHide: false,
        maxBuffer: 1024 * 1024
      });

      const selectedPath = stdout.trim();
      if (!selectedPath) {
        return {
          path: null,
          name: null,
          cancelled: true
        };
      }

      return {
        path: selectedPath,
        name: basename(selectedPath) || null,
        cancelled: false
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to open the native folder picker");
}

async function validateWorkspacePath(path: string): Promise<{ valid: boolean; error?: string }> {

  try {
    const resolvedPath = resolve(path);
    await access(resolvedPath);
    const stats = await stat(resolvedPath);

    if (!stats.isDirectory()) {
      return { valid: false, error: "Path is not a directory" };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Invalid path"
    };
  }
}

type WorkspaceTreeNode = {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
  children?: WorkspaceTreeNode[];
};

async function buildWorkspaceTree(
  rootPath: string,
  workspaceRoot: string,
  maxDepth = 8,
  currentDepth = 0
): Promise<WorkspaceTreeNode[]> {

  if (currentDepth > maxDepth) {
    return [];
  }

  const entries = await readdir(rootPath, { withFileTypes: true });
  const ignoredDirectories = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo"]);
  const filteredEntries = entries.filter((entry) => !ignoredDirectories.has(entry.name));

  const sortedEntries = filteredEntries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });


  const nodes = await Promise.all(
    sortedEntries.map(async (entry) => {
      const fullPath = join(rootPath, entry.name);
      const node: WorkspaceTreeNode = {
        name: entry.name,
        path: fullPath,
        relativePath: relative(workspaceRoot, fullPath),
        type: entry.isDirectory() ? "directory" : "file"
      };

      if (entry.isDirectory() && currentDepth < maxDepth) {
        try {
          const childNodes = await buildWorkspaceTree(fullPath, workspaceRoot, maxDepth, currentDepth + 1);
          node.children = childNodes;
        } catch {
          node.children = [];
        }
      }

      return node;
    })
  );

  return nodes;
}



export async function registerWorkspaceRoutes(app: FastifyInstance) {
  // List all workspaces
  app.get("/workspaces", async () => {
    const user = await getLocalUser();
    return prisma.workspace.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        name: true,
        path: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { conversations: true } }
      }
    });
  });

  // Get the "focus" workspace (the one with `isActive = true`).
  //
  // Multi-workspace behavior: `isActive` is now a pure UI hint — there is
  // no enforced singleton. This endpoint still returns whichever workspace
  // the user has most recently marked active, or `null` if they have
  // never done so (e.g. they only have one workspace and the UI has
  // never had to render a focus indicator). Returning 404 here used to
  // break the first-run experience.
  app.get("/workspaces/active", async () => {
    const user = await getLocalUser();
    const workspace = await prisma.workspace.findFirst({
      where: {
        userId: user.id,
        isActive: true
      }
    });

    if (!workspace) {
      return { workspace: null };
    }

    return { workspace };
  });

  app.post("/workspaces/pick-folder", async (_request, reply) => {
    try {
      return await pickWorkspaceFolderNative();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to open the folder picker";
      const statusCode = message.includes("only supported") ? 501 : 500;
      return reply.code(statusCode).send({ message });
    }
  });

  // Create workspace
  app.post("/workspaces", async (request, reply) => {

    const parsed = createWorkspaceSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const validation = await validateWorkspacePath(parsed.data.path);
    if (!validation.valid) {
      return reply.code(400).send({ message: validation.error });
    }

    const user = await getLocalUser();

    // Multi-workspace: do NOT auto-activate anything. `isActive` is a UI
    // focus hint, set explicitly by the user via PATCH /workspaces/:id
    // or by clicking the folder in the Workspaces modal. Auto-promoting
    // the first workspace here used to silently scope every agent to
    // whatever the user happened to add first.

    const workspace = await prisma.workspace.create({
      data: {
        userId: user.id,
        name: parsed.data.name,
        path: resolve(parsed.data.path),
        isActive: false
      }
    });

    return workspace;
  });

  // Update workspace
  app.patch("/workspaces/:id", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const body = updateWorkspaceSchema.safeParse(request.body ?? {});

    if (!params.success || !body.success) {
      return reply.code(400).send({ message: "Invalid request" });
    }

    const user = await getLocalUser();
    const existing = await prisma.workspace.findFirst({
      where: {
        id: params.data.id,
        userId: user.id
      }
    });

    if (!existing) {
      return reply.code(404).send({ message: "Workspace not found" });
    }

    // Validate new path if provided
    if (body.data.path) {
      const validation = await validateWorkspacePath(body.data.path);
      if (!validation.valid) {
        return reply.code(400).send({ message: validation.error });
      }
    }

    // If setting this workspace as active, deactivate others
    if (body.data.isActive === true) {
      await prisma.workspace.updateMany({
        where: { 
          userId: user.id,
          id: { not: params.data.id }
        },
        data: { isActive: false }
      });
    }

    const updated = await prisma.workspace.update({
      where: { id: existing.id },
      data: {
        name: body.data.name,
        path: body.data.path ? resolve(body.data.path) : undefined,
        isActive: body.data.isActive,
        updatedAt: new Date()
      }
    });

    return updated;
  });

  // Delete workspace
  app.delete("/workspaces/:id", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ message: "Invalid params" });
    }

    const user = await getLocalUser();
    const existing = await prisma.workspace.findFirst({
      where: {
        id: params.data.id,
        userId: user.id
      }
    });

    if (!existing) {
      return reply.code(404).send({ message: "Workspace not found" });
    }

    await prisma.workspace.delete({ where: { id: existing.id } });

    // Multi-workspace: do NOT auto-promote another workspace. If the
    // user had this one marked as `isActive`, the field is now simply
    // unset everywhere — the workspaces modal will show no focus
    // indicator until the user clicks one. Any in-flight agents that
    // were tied to this workspaceId are unaffected: the conversation
    // and its AgentRun rows still reference the (now-deleted)
    // workspaceId for forensic purposes, but no new requests will
    // resolve to it because `resolveAgentWorkspace` will 404 the
    // lookup.

    return { ok: true };
  });

  // Get workspace file tree
  app.get("/workspaces/:id/tree", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ message: "Invalid params" });
    }

    const user = await getLocalUser();
    const workspace = await prisma.workspace.findFirst({
      where: {
        id: params.data.id,
        userId: user.id
      }
    });

    if (!workspace) {
      return reply.code(404).send({ message: "Workspace not found" });
    }

    try {
      const tree = await buildWorkspaceTree(workspace.path, workspace.path, 8, 0);
      return {
        workspaceId: workspace.id,
        name: workspace.name,
        path: workspace.path,
        tree
      };
    } catch (error) {
      return reply.code(500).send({
        message: "Failed to read workspace files",
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }

  });

  // Read file content from workspace
  const fileQuerySchema = z.object({ path: z.string().min(1) });
  const MAX_FILE_SIZE = 1024 * 1024; // 1MB

  app.get("/workspaces/:id/file", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const query = fileQuerySchema.safeParse(request.query);

    if (!params.success || !query.success) {
      return reply.code(400).send({ message: "Invalid params" });
    }

    const filePath = query.data.path;

    // Layer 1: reject path traversal sequences
    if (containsPathTraversal(filePath)) {
      return reply.code(403).send({ message: "Access denied: invalid path" });
    }

    const user = await getLocalUser();
    const workspace = await prisma.workspace.findFirst({
      where: { id: params.data.id, userId: user.id }
    });

    if (!workspace) {
      return reply.code(404).send({ message: "Workspace not found" });
    }

    // Layer 2: resolve to absolute path
    const fullPath = resolveWorkspacePath(filePath, workspace.path);

    // Layer 3: symlink-safe boundary check
    if (!(await isWithinWorkspaceSymlinkSafe(fullPath, workspace.path))) {
      return reply.code(403).send({ message: "Access denied: path is outside workspace" });
    }

    try {
      const stats = await stat(fullPath);

      if (stats.isDirectory()) {
        return reply.code(400).send({ message: "Path is a directory, not a file" });
      }

      if (stats.size > MAX_FILE_SIZE) {
        return reply.code(413).send({
          message: `File too large (${(stats.size / 1024 / 1024).toFixed(1)}MB). Max 1MB for preview.`
        });
      }

      const content = await fsReadFile(fullPath, "utf-8");
      const lines = content.split("\n").length;

      return {
        content,
        path: filePath,
        size: stats.size,
        lines,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to read file";
      return reply.code(500).send({ message: "Failed to read file", error: message });
    }
  });

  // POST /api/workspaces/:id/reveal — open a file or folder in the OS
  // file explorer. The path is workspace-relative (or absolute, which we
  // canonicalize and then boundary-check). On Windows we use `explorer`
  // (with `/select` for files so the file gets highlighted). On macOS
  // `open -R` highlights the item. On Linux we fall back to `xdg-open`
  // on the parent directory.
  //
  // The endpoint never returns the spawned process; it only signals
  // success/failure so the UI can show a toast. The exec is fire-and-
  // forget because explorer/open detach from the parent.
  const revealSchema = z.object({
    path: z.string().min(1)
  });

  app.post("/workspaces/:id/reveal", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const body = revealSchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ message: "Invalid params" });
    }

    if (containsPathTraversal(body.data.path)) {
      return reply.code(403).send({ message: "Access denied: invalid path" });
    }

    const user = await getLocalUser();
    const workspace = await prisma.workspace.findFirst({
      where: { id: params.data.id, userId: user.id }
    });
    if (!workspace) {
      return reply.code(404).send({ message: "Workspace not found" });
    }

    const fullPath = resolveWorkspacePath(body.data.path, workspace.path);
    if (!(await isWithinWorkspaceSymlinkSafe(fullPath, workspace.path))) {
      return reply.code(403).send({ message: "Access denied: path is outside workspace" });
    }

    // Verify the path actually exists. We don't want explorer to silently
    // open the workspace root because of a stale tree entry.
    try {
      await access(fullPath);
    } catch {
      return reply.code(404).send({ message: "Path not found on disk" });
    }

    try {
      // Pick the right shell command per platform.
      if (process.platform === "win32") {
        // Windows quirk: `explorer.exe` exits with code 1 (and prints
        // nothing) even when the window opens successfully. This is
        // because explorer is a long-lived shell process that detaches
        // from its parent — the parent sees the GUI session close
        // immediately and treats that as a non-zero exit. Using
        // `await execFile` and treating exit code as success therefore
        // produces a false negative.
        //
        // The reliable fix is to use `spawn` with `detached: true` and
        // `unref()` so the parent doesn't wait for the child at all.
        // explorer then runs in its own session, and any "error" the
        // child sees after detach is invisible to us. We pre-validated
        // the path above (the `access()` call) so we can return success
        // the moment spawn() returns the child handle.
        const stats = await stat(fullPath);
        const { spawn } = await import("node:child_process");
        if (stats.isDirectory()) {
          const child = spawn("explorer.exe", [resolve(fullPath)], {
            detached: true,
            stdio: "ignore",
            windowsHide: false
          });
          child.unref();
        } else {
          // `explorer /select,<path>` highlights the file in its parent
          // folder. Note: the comma has to be attached to /select
          // (no space) — that's the documented syntax.
          const child = spawn("explorer.exe", [`/select,${resolve(fullPath)}`], {
            detached: true,
            stdio: "ignore",
            windowsHide: false
          });
          child.unref();
        }
      } else if (process.platform === "darwin") {
        // `open -R <path>` reveals in Finder. Always works for both files
        // and directories. execFile is fine here because `open` exits
        // with 0 immediately after handing off to Finder.
        await execFileAsync("open", ["-R", resolve(fullPath)]);
      } else {
        // Linux: xdg-open doesn't have a "reveal" mode, so we open the
        // parent directory for files, or the path itself for directories.
        const stats = await stat(fullPath);
        const target = stats.isDirectory() ? resolve(fullPath) : resolve(fullPath, "..");
        await execFileAsync("xdg-open", [target]);
      }
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to open file explorer";
      return reply.code(500).send({ message });
    }
  });

  // ===========================================================================
  // Tier 2 — file mutations. The endpoints below let the UI directly create,
  // rename, move, duplicate, and delete files/folders inside the workspace
  // without going through the agent loop. They use the same path-traversal
  // + symlink-safety guards as the agent's filesystem tools, so the
  // workspace boundary is enforced in exactly one place.
  //
  // Every endpoint:
  //   1. Validates the workspace belongs to the current user.
  //   2. Rejects path-traversal sequences in user-supplied paths.
  //   3. Resolves the path to an absolute location inside the workspace
  //      via resolveWorkspacePath + isWithinWorkspaceSymlinkSafe.
  //   4. Pre-checks the parent directory's existence for create/rename.
  //   5. Returns structured error codes (404/403/409/500) so the UI
  //      can show useful toasts.
  // ===========================================================================

  // Shared helper: validate a workspace-relative path against the
  // workspace boundary. Returns either { ok: true, fullPath } or
  // { ok: false, status, message }.
  async function validateWithinWorkspace(workspaceId: string, relativePath: string) {
    if (containsPathTraversal(relativePath)) {
      return { ok: false as const, status: 403, message: "Access denied: invalid path" };
    }
    const user = await getLocalUser();
    const workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId, userId: user.id }
    });
    if (!workspace) {
      return { ok: false as const, status: 404, message: "Workspace not found" };
    }
    const fullPath = resolveWorkspacePath(relativePath, workspace.path);
    if (!(await isWithinWorkspaceSymlinkSafe(fullPath, workspace.path))) {
      return { ok: false as const, status: 403, message: "Access denied: path is outside workspace" };
    }
    return { ok: true as const, workspace, fullPath };
  }

  // POST /api/workspaces/:id/file — create or overwrite a file.
  // Body: { path: string, content: string }
  const createFileSchema = z.object({
    path: z.string().min(1),
    content: z.string()
  });

  app.post("/workspaces/:id/file", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const body = createFileSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ message: "Invalid params" });
    }
    const v = await validateWithinWorkspace(params.data.id, body.data.path);
    if (!v.ok) return reply.code(v.status).send({ message: v.message });

    // Reject if the target path already exists as a directory.
    // Overwriting an existing file is allowed (matches the agent's
    // write_file tool behaviour and lets the UI save over edits).
    try {
      const s = await stat(v.fullPath);
      if (s.isDirectory()) {
        return reply.code(409).send({ message: "A folder already exists at that path" });
      }
    } catch {
      // ENOENT — file doesn't exist yet, that's the create case.
    }

    try {
      // mkdir -p for the parent (in case the user is creating a file
      // in a brand-new directory tree).
      await fsMkdir(dirname(v.fullPath), { recursive: true });
      await fsWriteFile(v.fullPath, body.data.content, "utf-8");
      return { success: true, path: body.data.path };
    } catch (err) {
      return reply.code(500).send({
        message: err instanceof Error ? err.message : "Failed to create file"
      });
    }
  });

  // POST /api/workspaces/:id/folder — create a directory.
  // Body: { path: string }
  const createFolderSchema = z.object({
    path: z.string().min(1)
  });

  app.post("/workspaces/:id/folder", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const body = createFolderSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ message: "Invalid params" });
    }
    const v = await validateWithinWorkspace(params.data.id, body.data.path);
    if (!v.ok) return reply.code(v.status).send({ message: v.message });

    // Reject if the path already exists as anything other than a directory.
    // mkdir with recursive:true is idempotent for directories but can
    // throw EEXIST on a file, so we pre-check to give a clean error.
    try {
      const s = await stat(v.fullPath);
      if (!s.isDirectory()) {
        return reply.code(409).send({ message: "A file already exists at that path" });
      }
      // Already a directory — treat as success (idempotent).
      return { success: true, path: body.data.path, alreadyExisted: true };
    } catch {
      // doesn't exist — proceed to create
    }

    try {
      await fsMkdir(v.fullPath, { recursive: true });
      return { success: true, path: body.data.path };
    } catch (err) {
      return reply.code(500).send({
        message: err instanceof Error ? err.message : "Failed to create folder"
      });
    }
  });

  // PATCH /api/workspaces/:id/path — rename or move a file or directory.
  // Body: { from: string, to: string }
  const renameSchema = z.object({
    from: z.string().min(1),
    to: z.string().min(1)
  });

  app.patch("/workspaces/:id/path", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const body = renameSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ message: "Invalid params" });
    }
    const fromV = await validateWithinWorkspace(params.data.id, body.data.from);
    if (!fromV.ok) return reply.code(fromV.status).send({ message: fromV.message });
    const toV = await validateWithinWorkspace(params.data.id, body.data.to);
    if (!toV.ok) return reply.code(toV.status).send({ message: toV.message });

    // Source must exist.
    try {
      await stat(fromV.fullPath);
    } catch {
      return reply.code(404).send({ message: "Source path not found" });
    }
    // Destination must not exist (or we could allow overwrite, but
    // rename is the safer default — fewer surprise data losses).
    try {
      await stat(toV.fullPath);
      return reply.code(409).send({ message: "Destination already exists" });
    } catch {
      // good — destination is free
    }
    // Parent of the destination must exist (rename() doesn't create
    // parent directories, unlike write_file).
    try {
      const parentStat = await stat(dirname(toV.fullPath));
      if (!parentStat.isDirectory()) {
        return reply.code(409).send({ message: "Destination parent is not a directory" });
      }
    } catch {
      return reply.code(404).send({ message: "Destination parent directory does not exist" });
    }

    try {
      await fsRename(fromV.fullPath, toV.fullPath);
      return { success: true, from: body.data.from, to: body.data.to };
    } catch (err) {
      return reply.code(500).send({
        message: err instanceof Error ? err.message : "Failed to rename"
      });
    }
  });

  // DELETE /api/workspaces/:id/path?path=...
  // The query is the path (path-traversal-safe). We use query for the
  // DELETE method because DELETE bodies are flaky across proxies.
  const deleteQuerySchema = z.object({
    path: z.string().min(1)
  });

  app.delete("/workspaces/:id/path", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const query = deleteQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ message: "Invalid params" });
    }
    const v = await validateWithinWorkspace(params.data.id, query.data.path);
    if (!v.ok) return reply.code(v.status).send({ message: v.message });

    // Refuse to delete the workspace root itself — that would orphan
    // the conversation/agent data tied to this workspace.
    if (resolve(v.fullPath) === resolve(v.workspace.path)) {
      return reply.code(400).send({ message: "Cannot delete the workspace root" });
    }

    try {
      await stat(v.fullPath);
    } catch {
      return reply.code(404).send({ message: "Path not found" });
    }

    try {
      // `rm` with recursive:true handles both files and directories.
      // `force:false` means we want a real error if the path vanished
      // between the stat() check and now (race-safe).
      await fsRm(v.fullPath, { recursive: true, force: false });
      return { success: true, path: query.data.path };
    } catch (err) {
      return reply.code(500).send({
        message: err instanceof Error ? err.message : "Failed to delete"
      });
    }
  });

  // POST /api/workspaces/:id/duplicate — duplicate a file.
  // Body: { path: string, newName?: string }
  // If newName is omitted, the duplicate gets " (copy)" appended
  // before the extension, e.g. "foo.ts" -> "foo (copy).ts".
  const duplicateSchema = z.object({
    path: z.string().min(1),
    newName: z.string().min(1).optional()
  });

  app.post("/workspaces/:id/duplicate", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const body = duplicateSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ message: "Invalid params" });
    }
    const v = await validateWithinWorkspace(params.data.id, body.data.path);
    if (!v.ok) return reply.code(v.status).send({ message: v.message });

    let sourceStat;
    try {
      sourceStat = await stat(v.fullPath);
    } catch {
      return reply.code(404).send({ message: "Source not found" });
    }
    if (sourceStat.isDirectory()) {
      return reply.code(400).send({ message: "Duplicating directories is not supported" });
    }

    // Compute the new file name. If the user didn't supply one, use
    // the VS Code convention: "<base> (copy)<ext>". If a copy already
    // exists, increment to " (copy 2)", " (copy 3)", etc.
    const sourceName = basename(v.fullPath);
    const ext = extname(sourceName);
    const base = sourceName.slice(0, sourceName.length - ext.length);
    const dir = dirname(v.fullPath);
    const newName = body.data.newName ?? await pickFreeCopyName(dir, base, ext);
    const newFullPath = join(dir, newName);
    if (containsPathTraversal(newFullPath)) {
      return reply.code(403).send({ message: "Access denied: invalid path" });
    }
    if (!(await isWithinWorkspaceSymlinkSafe(newFullPath, v.workspace.path))) {
      return reply.code(403).send({ message: "Access denied: path is outside workspace" });
    }

    try {
      await fsCopyFile(v.fullPath, newFullPath);
      return {
        success: true,
        path: body.data.path,
        newPath: toWorkspaceRelativePath(newFullPath, v.workspace.path)
      };
    } catch (err) {
      return reply.code(500).send({
        message: err instanceof Error ? err.message : "Failed to duplicate"
      });
    }
  });

  // Pick a free name like "foo (copy).ts", "foo (copy 2).ts", "foo (copy 3).ts".
  // We probe up to 1000 to avoid infinite loops on weird filesystems.
  async function pickFreeCopyName(
    dir: string,
    base: string,
    ext: string
  ): Promise<string> {
    for (let i = 1; i <= 1000; i++) {
      const candidate = i === 1
        ? `${base} (copy)${ext}`
        : `${base} (copy ${i})${ext}`;
      try {
        await stat(join(dir, candidate));
        // exists — try the next index
      } catch {
        // doesn't exist — free
        return candidate;
      }
    }
    // Fallback: timestamp suffix to guarantee uniqueness.
    return `${base} (copy ${Date.now()})${ext}`;
  }

  // GET /api/workspaces/:id/raw?path=... — download a file's contents
  // as a binary stream. Used by the file tree's "Download" action.
  // No file size cap (the /file preview endpoint caps at 1MB; this
  // is the full-content endpoint).
  const rawQuerySchema = z.object({ path: z.string().min(1) });

  app.get("/workspaces/:id/raw", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const query = rawQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ message: "Invalid params" });
    }
    const v = await validateWithinWorkspace(params.data.id, query.data.path);
    if (!v.ok) return reply.code(v.status).send({ message: v.message });

    try {
      const s = await stat(v.fullPath);
      if (s.isDirectory()) {
        return reply.code(400).send({ message: "Cannot download a directory" });
      }
    } catch {
      return reply.code(404).send({ message: "File not found" });
    }

    try {
      const buffer = await fsReadFile(v.fullPath);
      const filename = basename(v.fullPath);
      // application/octet-stream is the universal "save as" content
      // type — the browser will respect the Content-Disposition
      // filename rather than trying to render the file inline.
      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
      reply.header("Content-Length", String(buffer.length));
      return reply.send(buffer);
    } catch (err) {
      return reply.code(500).send({
        message: err instanceof Error ? err.message : "Failed to read file"
      });
    }
  });

  // GET /api/workspaces/:id/stat?path=... — file/directory metadata
  // (size, mtime, type). Used by the file tree's hover tooltip to show
  // "1.4 KB · modified 2 hours ago" without having to read the file
  // contents. Returns:
  //   {
  //     path: string,         // workspace-relative path
  //     size: number,         // bytes (0 for directories)
  //     mtime: number,        // ms since epoch
  //     isDirectory: boolean,
  //     childCount?: number   // direct children for directories
  //   }
  const statQuerySchema = z.object({ path: z.string().min(1) });

  app.get("/workspaces/:id/stat", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const query = statQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ message: "Invalid params" });
    }
    const v = await validateWithinWorkspace(params.data.id, query.data.path);
    if (!v.ok) return reply.code(v.status).send({ message: v.message });

    try {
      const s = await stat(v.fullPath);
      const result: {
        path: string;
        size: number;
        mtime: number;
        isDirectory: boolean;
        childCount?: number;
      } = {
        path: query.data.path,
        size: s.size,
        mtime: s.mtimeMs,
        isDirectory: s.isDirectory()
      };
      // For directories, also count the direct children so the hover
      // tooltip can show "12 items" without a second round-trip.
      if (s.isDirectory()) {
        try {
          const entries = await readdir(v.fullPath);
          result.childCount = entries.length;
        } catch {
          // If we can't read the directory (permission, race), skip
          // the child count rather than failing the whole stat call.
        }
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to stat path";
      return reply.code(500).send({ message });
    }
  });

  // ===========================================================================
  // Tier 4 — Go to file (Ctrl+P) and Find in files (Ctrl+Shift+F).
  //
  // Both endpoints work over the same flat list of files that the
  // file tree uses, but skip the recursive `children` payload — the
  // caller only needs a flat list of paths to score/match against.
  // We use the same ignored-directories list as buildWorkspaceTree
  // so users don't see results from node_modules / .git / etc.
  // ===========================================================================

  // Flatten a workspace tree into a list of { relativePath, name, isDir }.
  // We re-implement the recursion here (rather than calling
  // buildWorkspaceTree) so the response is independent of the tree
  // depth limit and can be cached separately.
  type FlatEntry = { relativePath: string; name: string; isDir: boolean };
  const IGNORED_DIRS = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    "web-dist",
    ".next",
    ".turbo",
    ".cache"
  ]);

  async function listAllFiles(
    rootPath: string,
    workspaceRoot: string,
    maxDepth = 12,
    currentDepth = 0
  ): Promise<FlatEntry[]> {
    if (currentDepth > maxDepth) return [];
    let entries;
    try {
      entries = await readdir(rootPath, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: FlatEntry[] = [];
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue; // skip dotfiles
      const fullPath = join(rootPath, entry.name);
      const rel = relative(workspaceRoot, fullPath);
      const isDir = entry.isDirectory();
      out.push({ relativePath: rel, name: entry.name, isDir });
      if (isDir) {
        const nested = await listAllFiles(fullPath, workspaceRoot, maxDepth, currentDepth + 1);
        out.push(...nested);
      }
    }
    return out;
  }

  // GET /api/workspaces/:id/files/match?q=<query>&limit=<n>
  // Fuzzy file-path match for the "Go to file" command palette
  // (Ctrl+P). Scoring is intentionally simple but covers the
  // common cases:
  //   - exact substring of the basename: +100
  //   - exact substring of the relative path: +50
  //   - prefix of basename: +30
  //   - segment match (any path segment starts with q): +20
  //   - case-insensitive fuzz: any character of q in order in name: +5
  // The best matches are returned, sorted by score desc.
  const matchQuerySchema = z.object({
    q: z.string().min(1).max(200),
    limit: z.coerce.number().int().min(1).max(100).optional()
  });

  app.get("/workspaces/:id/files/match", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const query = matchQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ message: "Invalid params" });
    }
    const user = await getLocalUser();
    const workspace = await prisma.workspace.findFirst({
      where: { id: params.data.id, userId: user.id }
    });
    if (!workspace) {
      return reply.code(404).send({ message: "Workspace not found" });
    }

    const limit = query.data.limit ?? 20;
    const q = query.data.q.toLowerCase();
    const all = await listAllFiles(workspace.path, workspace.path);

    type Scored = FlatEntry & { score: number; matchedField: "basename" | "path" | "fuzzy" };
    const scored: Scored[] = [];
    for (const entry of all) {
      if (entry.isDir) continue; // Go-to-file only matches files
      const lowerName = entry.name.toLowerCase();
      const lowerPath = entry.relativePath.toLowerCase();
      let score = 0;
      let matchedField: Scored["matchedField"] = "fuzzy";
      if (lowerName === q) {
        score = 200;
        matchedField = "basename";
      } else if (lowerName.includes(q)) {
        score = 100 + (lowerName.startsWith(q) ? 20 : 0);
        matchedField = "basename";
      } else if (lowerPath.includes(q)) {
        score = 50;
        matchedField = "path";
      } else {
        // Fuzzy: every char of q appears in lowerName in order
        let lastIdx = -1;
        let ok = true;
        for (const ch of q) {
          const i = lowerName.indexOf(ch, lastIdx + 1);
          if (i < 0) {
            ok = false;
            break;
          }
          lastIdx = i;
        }
        if (ok) {
          score = 5;
          matchedField = "fuzzy";
        } else {
          continue;
        }
      }
      // Boost files in shallow paths (more relevant)
      const depth = entry.relativePath.split(/[\\/]/).length;
      score -= depth;
      scored.push({ ...entry, score, matchedField });
    }

    scored.sort((a, b) => b.score - a.score);
    return {
      matches: scored.slice(0, limit).map((m) => ({
        path: m.relativePath,
        name: m.name,
        matchedField: m.matchedField
      }))
    };
  });

  // GET /api/workspaces/:id/search?q=<query>&limit=<n>
  // Full-text search across the workspace. Returns one match per
  // (file, line) where the query appears. The implementation walks
  // the file tree, opens each text file (size-capped), and scans
  // line-by-line for the query. We deliberately skip binary files
  // (those that contain NUL bytes within the first 8 KB).
  //
  // The match preview is the matching line with surrounding
  // context, similar to grep -n output. This is a simple substring
  // search — regex support can be added later by upgrading the
  // client UI.
  const searchQuerySchema = z.object({
    q: z.string().min(1).max(200),
    limit: z.coerce.number().int().min(1).max(500).optional()
  });

  // We cap each individual file at this size when scanning. Files
  // larger than this (e.g. generated bundles, lockfiles) are
  // skipped — they almost never contain user-relevant matches and
  // would dominate the response time.
  const SEARCH_MAX_FILE_SIZE = 1024 * 1024; // 1 MB
  const SEARCH_MAX_LINE_LENGTH = 500;

  app.get("/workspaces/:id/search", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const query = searchQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ message: "Invalid params" });
    }
    const user = await getLocalUser();
    const workspace = await prisma.workspace.findFirst({
      where: { id: params.data.id, userId: user.id }
    });
    if (!workspace) {
      return reply.code(404).send({ message: "Workspace not found" });
    }

    const limit = query.data.limit ?? 200;
    const q = query.data.q;
    const qLower = q.toLowerCase();
    const all = await listAllFiles(workspace.path, workspace.path);

    type Match = {
      path: string;
      line: number;
      column: number;
      preview: string;
    };
    const matches: Match[] = [];

    // Read+scan files in parallel for throughput, but bounded so
    // we don't open 1000 file handles at once. 16 is a good
    // balance between wall-time and memory.
    const filesToScan = all.filter((e) => !e.isDir);
    const PARALLEL = 16;
    for (let i = 0; i < filesToScan.length && matches.length < limit; i += PARALLEL) {
      const slice = filesToScan.slice(i, i + PARALLEL);
      await Promise.all(
        slice.map(async (entry) => {
          const fullPath = join(workspace.path, entry.relativePath);
          try {
            const stats = await stat(fullPath);
            if (stats.size > SEARCH_MAX_FILE_SIZE) return;
            if (stats.size === 0) return;
            const content = await fsReadFile(fullPath, "utf-8");
            // Binary-file heuristic: a NUL byte in the first 8 KB.
            // We slice the string to avoid scanning huge files.
            const probe = content.slice(0, 8192);
            if (probe.includes("\u0000")) return;
            const lines = content.split(/\r?\n/);
            for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
              const line = lines[lineIdx];
              if (line.length > SEARCH_MAX_LINE_LENGTH) continue;
              const col = line.toLowerCase().indexOf(qLower);
              if (col >= 0) {
                matches.push({
                  path: entry.relativePath,
                  line: lineIdx + 1,
                  column: col + 1,
                  preview: line
                });
                if (matches.length >= limit) return;
              }
            }
          } catch {
            // Skip unreadable / permission-denied files.
          }
        })
      );
    }

    // Sort by path then by line number for stable output.
    matches.sort((a, b) => {
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.line - b.line;
    });

    return {
      query: q,
      count: matches.length,
      matches: matches.slice(0, limit)
    };
  });
}
