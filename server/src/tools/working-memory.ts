/**
 * update_working_memory tool — lets the agent track its task progress
 * in a file-based scratchpad (.rapa/working-memory.md) that survives
 * context compaction AND process restarts.
 *
 * Unlike the previous in-memory approach, this writes directly to disk.
 * The model can also read/update the file with read_file/edit_file.
 */

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import {
  createWorkingMemory,
  updateWorkingMemory,
  loadWorkingMemory,
  persistWorkingMemory,
  type WorkingMemoryUpdate
} from "../lib/agent/working-memory.js";

export class UpdateWorkingMemoryTool extends Tool {
  definition: ToolDefinition = {
    name: "update_working_memory",
    description: "Update the working memory file (.rapa/working-memory.md) to track task progress. Call this every ~3 iterations during long tasks to record: current task, completed steps, pending steps, key decisions, and modified files. This file persists across sessions and survives context compaction.",
    category: "system",
    riskLevel: "none",
    requiresApproval: false,
    parameters: {
      currentTask: {
        type: "string",
        description: "What you are currently working on",
        required: false
      },
      addCompleted: {
        type: "string",
        description: "A step or task that was just completed",
        required: false
      },
      addPending: {
        type: "string",
        description: "A step or task that still needs to be done",
        required: false
      },
      removePending: {
        type: "string",
        description: "Remove a pending step (exact match)",
        required: false
      },
      addDecision: {
        type: "string",
        description: "A key decision made and its rationale",
        required: false
      },
      addError: {
        type: "string",
        description: "An error encountered and how it was handled",
        required: false
      },
      addFile: {
        type: "string",
        description: "A file path that was modified",
        required: false
      },
      clearCompleted: {
        type: "boolean",
        description: "Clear all completed steps",
        required: false
      },
      clearPending: {
        type: "boolean",
        description: "Clear all pending steps",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    if (!context.workspaceRoot) {
      return { success: false, error: "No workspace root available." };
    }

    try {
      // Load existing or create new working memory
      let memory = await loadWorkingMemory(context.workspaceRoot);
      if (!memory) {
        memory = createWorkingMemory(
          typeof context.conversationId === "string" ? context.conversationId : "agent-task"
        );
      }

      // Build the update from params
      const update: WorkingMemoryUpdate = {};
      if (typeof params.currentTask === "string") update.currentTask = params.currentTask;
      if (typeof params.addCompleted === "string") update.addCompleted = params.addCompleted;
      if (typeof params.addPending === "string") update.addPending = params.addPending;
      if (typeof params.removePending === "string") update.removePending = params.removePending;
      if (typeof params.addDecision === "string") update.addDecision = params.addDecision;
      if (typeof params.addError === "string") update.addError = params.addError;
      if (typeof params.addFile === "string") update.addFile = params.addFile;
      if (params.clearCompleted === true) update.clearCompleted = true;
      if (params.clearPending === true) update.clearPending = true;

      // Apply update and persist to disk
      memory = updateWorkingMemory(memory, update);
      await persistWorkingMemory(context.workspaceRoot, memory);

      const parts: string[] = [];
      if (update.currentTask) parts.push(`current task updated`);
      if (update.addCompleted) parts.push(`+completed: "${update.addCompleted}"`);
      if (update.addPending) parts.push(`+pending: "${update.addPending}"`);
      if (update.removePending) parts.push(`-pending: "${update.removePending}"`);
      if (update.addDecision) parts.push(`+decision`);
      if (update.addError) parts.push(`+error`);
      if (update.addFile) parts.push(`+file: ${update.addFile}`);

      return {
        success: true,
        data: { file: ".rapa/working-memory.md" },
        output: `Working memory updated: ${parts.join(", ")}. File: .rapa/working-memory.md`
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update working memory"
      };
    }
  }
}
