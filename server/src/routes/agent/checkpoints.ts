// Checkpoint restore helpers.
//
// When the user clicks "Restore" on a checkpoint, these functions reverse
// the file changes recorded by the agent (write, edit, rename, mkdir).

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isWithinWorkspace, resolveWorkspacePath } from "../../tools/filesystem.js";

function getJsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function getStringValue(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function resolveCheckpointRestorePath(checkpoint: {
  path: string;
  workspace: { path: string } | null;
  run: { workspace: { path: string } | null };
}) {
  const workspacePath = checkpoint.workspace?.path ?? checkpoint.run.workspace?.path;
  if (!workspacePath) {
    throw new Error("Checkpoint workspace is no longer available");
  }

  const fullPath = resolveWorkspacePath(checkpoint.path, workspacePath);
  if (!isWithinWorkspace(fullPath, workspacePath)) {
    throw new Error("Checkpoint path is outside workspace");
  }

  return { workspacePath, fullPath };
}

export async function restoreTextCheckpoint(params: {
  fullPath: string;
  beforeContent: string | null;
  afterContent: string | null;
}) {
  const { fullPath, beforeContent, afterContent } = params;

  if (beforeContent === null && afterContent === null) {
    throw new Error("Checkpoint does not contain restorable file content");
  }

  if (beforeContent !== null && afterContent === null) {
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, beforeContent, "utf-8");
    return "Restored deleted file content";
  }

  const currentContent = await readFile(fullPath, "utf-8");

  if (beforeContent === null && afterContent !== null) {
    if (currentContent !== afterContent) {
      throw new Error("Current file content no longer matches the checkpoint output");
    }
    await rm(fullPath, { force: false });
    return "Removed file created by checkpoint";
  }

  if (beforeContent !== null && afterContent !== null) {
    if (currentContent === afterContent) {
      await writeFile(fullPath, beforeContent, "utf-8");
      return "Restored full file content";
    }

    const matches = currentContent.split(afterContent).length - 1;
    if (matches === 1) {
      await writeFile(fullPath, currentContent.replace(afterContent, beforeContent), "utf-8");
      return "Restored edited file section";
    }

    throw new Error("Current file content no longer matches the checkpoint output");
  }

  throw new Error("Checkpoint does not contain restorable file content");
}

export async function restoreRenameCheckpoint(params: {
  workspacePath: string;
  checkpointPath: string;
  toolCall: { parameters: unknown; resultData: unknown };
}) {
  const parameters = getJsonRecord(params.toolCall.parameters);
  const resultEnvelope = getJsonRecord(params.toolCall.resultData);
  const resultData = getJsonRecord(resultEnvelope?.data);
  const oldPath = getStringValue(resultData, "oldPath") ?? getStringValue(parameters, "oldPath");
  const newPath = getStringValue(resultData, "newPath") ?? getStringValue(parameters, "newPath") ?? params.checkpointPath;

  if (!oldPath || !newPath) {
    throw new Error("Rename checkpoint is missing source or target paths");
  }

  const currentPath = resolveWorkspacePath(newPath, params.workspacePath);
  const restoredPath = resolveWorkspacePath(oldPath, params.workspacePath);
  if (!isWithinWorkspace(currentPath, params.workspacePath) || !isWithinWorkspace(restoredPath, params.workspacePath)) {
    throw new Error("Rename checkpoint path is outside workspace");
  }

  await mkdir(dirname(restoredPath), { recursive: true });
  await rename(currentPath, restoredPath);
  return `Renamed ${newPath} back to ${oldPath}`;
}

export async function restoreMkdirCheckpoint(fullPath: string) {
  await rm(fullPath, { recursive: false, force: false });
  return "Removed directory created by checkpoint";
}
