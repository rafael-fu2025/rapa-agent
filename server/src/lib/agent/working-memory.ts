/**
 * Working memory — a file-based scratchpad that tracks the agent's current
 * task state across iterations and survives context compaction AND process
 * restarts.
 *
 * Unlike the previous in-memory approach, this writes to `.rapa/working-memory.md`
 * in the workspace. The model can read it with read_file, write to it with
 * edit_file, and it persists across sessions. This matches how Claude Code
 * uses CLAUDE.md for durable project memory.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

export const WORKING_MEMORY_DIR = ".rapa";
export const WORKING_MEMORY_FILE = "working-memory.md";
export const WORKING_MEMORY_PATH = join(WORKING_MEMORY_DIR, WORKING_MEMORY_FILE);

export type WorkingMemory = {
  goal: string;
  currentTask: string;
  completedSteps: string[];
  pendingSteps: string[];
  keyDecisions: string[];
  filesModified: string[];
  errors: string[];
  updatedAt: number;
};

export function createWorkingMemory(goal: string): WorkingMemory {
  return {
    goal: goal.slice(0, 500),
    currentTask: "",
    completedSteps: [],
    pendingSteps: [],
    keyDecisions: [],
    filesModified: [],
    errors: [],
    updatedAt: Date.now()
  };
}

export type WorkingMemoryUpdate = {
  currentTask?: string;
  addCompleted?: string;
  addPending?: string;
  removePending?: string;
  addDecision?: string;
  addError?: string;
  addFile?: string;
  clearCompleted?: boolean;
  clearPending?: boolean;
};

export function updateWorkingMemory(memory: WorkingMemory, update: WorkingMemoryUpdate): WorkingMemory {
  const next: WorkingMemory = {
    ...memory,
    completedSteps: update.clearCompleted ? [] : [...memory.completedSteps],
    pendingSteps: update.clearPending ? [] : [...memory.pendingSteps],
    keyDecisions: [...memory.keyDecisions],
    filesModified: [...memory.filesModified],
    errors: [...memory.errors],
    updatedAt: Date.now()
  };

  if (update.currentTask !== undefined) {
    next.currentTask = update.currentTask.slice(0, 300);
  }

  if (update.addCompleted) {
    const item = update.addCompleted.slice(0, 200);
    if (!next.completedSteps.includes(item)) {
      next.completedSteps.push(item);
      if (next.completedSteps.length > 20) {
        next.completedSteps = next.completedSteps.slice(-20);
      }
    }
  }

  if (update.addPending) {
    const item = update.addPending.slice(0, 200);
    if (!next.pendingSteps.includes(item)) {
      next.pendingSteps.push(item);
    }
  }

  if (update.removePending) {
    next.pendingSteps = next.pendingSteps.filter((s) => s !== update.removePending);
  }

  if (update.addDecision) {
    const item = update.addDecision.slice(0, 200);
    if (!next.keyDecisions.includes(item)) {
      next.keyDecisions.push(item);
      if (next.keyDecisions.length > 15) {
        next.keyDecisions = next.keyDecisions.slice(-15);
      }
    }
  }

  if (update.addError) {
    const item = update.addError.slice(0, 200);
    if (!next.errors.includes(item)) {
      next.errors.push(item);
      if (next.errors.length > 10) {
        next.errors = next.errors.slice(-10);
      }
    }
  }

  if (update.addFile) {
    const item = update.addFile;
    if (!next.filesModified.includes(item)) {
      next.filesModified.push(item);
      if (next.filesModified.length > 30) {
        next.filesModified = next.filesModified.slice(-30);
      }
    }
  }

  return next;
}

/**
 * Format working memory as a markdown file that's both human-readable
 * and parseable by the model.
 */
export function formatWorkingMemory(memory: WorkingMemory): string {
  const timestamp = new Date(memory.updatedAt).toISOString();
  const lines: string[] = [
    `# Working Memory`,
    `> Last updated: ${timestamp}`,
    ``,
    `## Goal`,
    memory.goal,
    ``
  ];

  if (memory.currentTask) {
    lines.push(`## Current Task`, memory.currentTask, ``);
  }

  if (memory.completedSteps.length > 0) {
    lines.push(`## Completed (${memory.completedSteps.length})`);
    for (const step of memory.completedSteps) {
      lines.push(`- [x] ${step}`);
    }
    lines.push(``);
  }

  if (memory.pendingSteps.length > 0) {
    lines.push(`## Pending (${memory.pendingSteps.length})`);
    for (const step of memory.pendingSteps) {
      lines.push(`- [ ] ${step}`);
    }
    lines.push(``);
  }

  if (memory.keyDecisions.length > 0) {
    lines.push(`## Key Decisions`);
    for (const d of memory.keyDecisions) {
      lines.push(`- ${d}`);
    }
    lines.push(``);
  }

  if (memory.filesModified.length > 0) {
    lines.push(`## Files Modified (${memory.filesModified.length})`);
    for (const f of memory.filesModified) {
      lines.push(`- \`${f}\``);
    }
    lines.push(``);
  }

  if (memory.errors.length > 0) {
    lines.push(`## Errors Encountered`);
    for (const e of memory.errors) {
      lines.push(`- ${e}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

/**
 * Persist working memory to disk as a markdown file.
 * Creates the .rapa/ directory if it doesn't exist.
 */
export async function persistWorkingMemory(
  workspacePath: string,
  memory: WorkingMemory
): Promise<void> {
  const filePath = join(workspacePath, WORKING_MEMORY_PATH);
  const dirPath = dirname(filePath);

  try {
    await mkdir(dirPath, { recursive: true });
    await writeFile(filePath, formatWorkingMemory(memory), "utf-8");
  } catch {
    // Non-fatal: workspace may be read-only or path may be invalid
  }
}

/**
 * Load working memory from disk. Returns null if the file doesn't exist
 * or can't be parsed.
 */
export async function loadWorkingMemory(
  workspacePath: string
): Promise<WorkingMemory | null> {
  const filePath = join(workspacePath, WORKING_MEMORY_PATH);

  try {
    const content = await readFile(filePath, "utf-8");
    return parseWorkingMemory(content);
  } catch {
    return null;
  }
}

/**
 * Parse a working memory markdown file back into a structured object.
 * This is a best-effort parser — if the format doesn't match, returns null.
 */
function parseWorkingMemory(content: string): WorkingMemory | null {
  try {
    const lines = content.split("\n");
    let goal = "";
    let currentTask = "";
    const completedSteps: string[] = [];
    const pendingSteps: string[] = [];
    const keyDecisions: string[] = [];
    const filesModified: string[] = [];
    const errors: string[] = [];

    let section = "";
    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed === "## Goal") { section = "goal"; continue; }
      if (trimmed === "## Current Task") { section = "currentTask"; continue; }
      if (trimmed.startsWith("## Completed")) { section = "completed"; continue; }
      if (trimmed.startsWith("## Pending")) { section = "pending"; continue; }
      if (trimmed === "## Key Decisions") { section = "decisions"; continue; }
      if (trimmed.startsWith("## Files Modified")) { section = "files"; continue; }
      if (trimmed === "## Errors Encountered") { section = "errors"; continue; }
      if (trimmed.startsWith("# Working Memory") || trimmed.startsWith("> Last updated")) continue;

      if (section === "goal" && trimmed) {
        goal = goal ? `${goal}\n${trimmed}` : trimmed;
      } else if (section === "currentTask" && trimmed) {
        currentTask = currentTask ? `${currentTask}\n${trimmed}` : trimmed;
      } else if (section === "completed" && trimmed.startsWith("- [x] ")) {
        completedSteps.push(trimmed.slice(6));
      } else if (section === "pending" && trimmed.startsWith("- [ ] ")) {
        pendingSteps.push(trimmed.slice(6));
      } else if (section === "decisions" && trimmed.startsWith("- ")) {
        keyDecisions.push(trimmed.slice(2));
      } else if (section === "files" && trimmed.startsWith("- `") && trimmed.endsWith("`")) {
        filesModified.push(trimmed.slice(3, -1));
      } else if (section === "errors" && trimmed.startsWith("- ")) {
        errors.push(trimmed.slice(2));
      }
    }

    if (!goal) return null;

    return {
      goal,
      currentTask,
      completedSteps,
      pendingSteps,
      keyDecisions,
      filesModified,
      errors,
      updatedAt: Date.now()
    };
  } catch {
    return null;
  }
}
