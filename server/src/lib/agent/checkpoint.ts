// AgentCheckpoint helpers (research C5).
//
// Stores byte-level snapshots of files before they're modified by the agent,
// so we can roll back if a later test/QA step fails. Lightweight in-memory
// implementation keyed by `AgentRun.id` — for production you'd persist these
// to the `AgentCheckpoint` table that already exists in schema.prisma.

import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type CheckpointEntry = {
  checkpointId: string;
  runId: string;
  absolutePath: string;
  /** Path to the snapshot on disk (or null if the file didn't exist). */
  snapshotPath: string | null;
  /** True if the file existed at snapshot time. */
  existed: boolean;
  /** Original mtime (ms since epoch) for verification. */
  originalMtimeMs?: number;
  createdAt: number;
};

export type CheckpointHandle = {
  runId: string;
  rootDir: string;
  entries: CheckpointEntry[];
};

const activeHandles = new Map<string, CheckpointHandle>();
const DEFAULT_CHECKPOINT_DIR = join(process.cwd(), ".rapa-checkpoints");

function getCheckpointStorePath(checkpointId: string): string {
  return join(DEFAULT_CHECKPOINT_DIR, `${checkpointId}.bin`);
}

/** Open a new checkpoint handle for a run. */
export function openCheckpoint(runId: string, rootDir: string): CheckpointHandle {
  const handle: CheckpointHandle = { runId, rootDir, entries: [] };
  activeHandles.set(runId, handle);
  return handle;
}

export function getCheckpoint(runId: string): CheckpointHandle | undefined {
  return activeHandles.get(runId);
}

/** Snapshot a file before modification. Stores a copy on disk. */
export async function snapshotFile(
  handle: CheckpointHandle,
  filePath: string
): Promise<CheckpointEntry> {
  const absolute = resolve(handle.rootDir, filePath);
  if (!absolute.startsWith(resolve(handle.rootDir))) {
    throw new Error(`Refusing to snapshot file outside workspace: ${filePath}`);
  }
  const checkpointId = randomUUID();
  const snapshotPath = getCheckpointStorePath(checkpointId);
  await mkdir(dirname(snapshotPath), { recursive: true });

  let existed = false;
  let originalMtimeMs: number | undefined;
  try {
    const stats = await stat(absolute);
    existed = true;
    originalMtimeMs = stats.mtimeMs;
    await copyFile(absolute, snapshotPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // File didn't exist — record that so rollback can recreate this state.
    } else {
      throw error;
    }
  }

  const entry: CheckpointEntry = {
    checkpointId,
    runId: handle.runId,
    absolutePath: absolute,
    snapshotPath: existed ? snapshotPath : null,
    existed,
    originalMtimeMs,
    createdAt: Date.now()
  };
  handle.entries.push(entry);
  return entry;
}

/**
 * Roll back all files in this handle to their snapshot state. Idempotent.
 * Returns the list of files rolled back.
 */
export async function rollbackCheckpoint(handle: CheckpointHandle): Promise<string[]> {
  const rolledBack: string[] = [];
  for (const entry of handle.entries) {
    if (!entry.existed || !entry.snapshotPath) {
      // File didn't exist before — ensure it doesn't exist now either.
      try {
        await rm(entry.absolutePath, { force: true });
        rolledBack.push(relative(handle.rootDir, entry.absolutePath));
      } catch {
        // Ignore.
      }
      continue;
    }
    try {
      await mkdir(dirname(entry.absolutePath), { recursive: true });
      await copyFile(entry.snapshotPath, entry.absolutePath);
      rolledBack.push(relative(handle.rootDir, entry.absolutePath));
    } catch {
      // Continue on best-effort basis.
    }
  }
  return rolledBack;
}

/** Release a handle and clean up its snapshot files. */
export async function closeCheckpoint(handle: CheckpointHandle, keepSnapshots: boolean = false): Promise<void> {
  if (!keepSnapshots) {
    for (const entry of handle.entries) {
      if (entry.snapshotPath) {
        try {
          await rm(entry.snapshotPath, { force: true });
        } catch {
          // Ignore.
        }
      }
    }
  }
  activeHandles.delete(handle.runId);
}
