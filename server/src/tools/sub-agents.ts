import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { activateSpecialistMode } from "../lib/sub-agents.js";

// ---------------------------------------------------------------------------
// Child Agent Registry — in-memory tracking for spawned sub-agents
// ---------------------------------------------------------------------------

export type ChildAgentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * Typed child agents, mirroring ZCode/Claude Code's built-in agent types:
 *   - "explore": read-only codebase ANALYSIS agent — locates code, maps
 *     structure, cites file paths; fast, conclusions-only.
 *   - "general": open-ended read-only research with the specialist
 *     methodology (the historical spawn_agent behavior).
 */
export type ChildAgentType = "explore" | "general";
/** Explore thoroughness — drives the child's iteration budget and sweep depth. */
export type ExploreBreadth = "quick" | "medium" | "very_thorough";

export type ChildAgentHandle = {
  id: string;
  parentConversationId: string;
  parentRunId: string;
  task: string;
  taskContext?: string;
  agentType: ChildAgentType;
  breadth: ExploreBreadth;
  status: ChildAgentStatus;
  result?: string;
  error?: string;
  createdAt: Date;
  completedAt?: Date;
  toolCallCount: number;
  iterationCount: number;
  maxIterations: number;
  /** AbortController for cancelling the child agent */
  abortController?: AbortController;
};

class ChildAgentRegistry {
  private agents = new Map<string, ChildAgentHandle>();
  private nextId = 1;

  create(params: {
    parentConversationId: string;
    parentRunId: string;
    task: string;
    taskContext?: string;
    agentType?: ChildAgentType;
    breadth?: ExploreBreadth;
    maxIterations?: number;
  }): ChildAgentHandle {
    const id = `child-agent-${this.nextId++}-${Date.now().toString(36)}`;
    const handle: ChildAgentHandle = {
      id,
      parentConversationId: params.parentConversationId,
      parentRunId: params.parentRunId,
      task: params.task,
      taskContext: params.taskContext,
      agentType: params.agentType ?? "general",
      breadth: params.breadth ?? "medium",
      status: "pending",
      createdAt: new Date(),
      toolCallCount: 0,
      iterationCount: 0,
      maxIterations: params.maxIterations ?? 15,
      abortController: new AbortController()
    };
    this.agents.set(id, handle);
    return handle;
  }

  get(id: string): ChildAgentHandle | undefined {
    return this.agents.get(id);
  }

  update(id: string, updates: Partial<Pick<ChildAgentHandle, "status" | "result" | "error" | "toolCallCount" | "iterationCount" | "completedAt">>): ChildAgentHandle | undefined {
    const handle = this.agents.get(id);
    if (!handle) return undefined;
    Object.assign(handle, updates);
    return handle;
  }

  cancel(id: string): boolean {
    const handle = this.agents.get(id);
    if (!handle || handle.status === "completed" || handle.status === "failed" || handle.status === "cancelled") {
      return false;
    }
    handle.status = "cancelled";
    handle.completedAt = new Date();
    handle.abortController?.abort();
    return true;
  }

  listByParent(conversationId: string): ChildAgentHandle[] {
    return Array.from(this.agents.values())
      .filter((a) => a.parentConversationId === conversationId);
  }

  /** Clean up completed/failed/cancelled agents older than 30 minutes */
  cleanup(): void {
    const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
    for (const [id, handle] of this.agents) {
      if (
        (handle.status === "completed" || handle.status === "failed" || handle.status === "cancelled") &&
        handle.completedAt &&
        handle.completedAt.getTime() < thirtyMinAgo
      ) {
        this.agents.delete(id);
      }
    }
  }
}

export const childAgentRegistry = new ChildAgentRegistry();

// ---------------------------------------------------------------------------
// Existing DelegateTaskTool (prompt-injection specialist — unchanged)
// ---------------------------------------------------------------------------

export class DelegateTaskTool extends Tool {
  definition: ToolDefinition = {
    name: "delegate_task",
    description: "Activate a focused specialist mode inside the current agent. Use this when you want specialist guidance for research, debugging, planning, or codebase analysis without spawning a child agent.",
    category: "code",
    riskLevel: "read",
    parameters: {
      specialist: {
        type: "string",
        description: "Which specialist should handle the subtask.",
        required: true
      },
      task: {
        type: "string",
        description: "A concise, bounded task for the specialist to complete.",
        required: true
      },
      taskContext: {
        type: "string",
        description: "Optional supporting context, assumptions, or constraints for the specialist.",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const specialist = typeof params.specialist === "string" ? params.specialist.trim() : "";
    const task = typeof params.task === "string" ? params.task.trim() : "";
    const taskContext = typeof params.taskContext === "string" ? params.taskContext.trim() : undefined;

    if (!specialist) {
      return { success: false, error: "A specialist is required" };
    }
    if (!task) {
      return { success: false, error: "A task is required" };
    }

    return activateSpecialistMode({
      specialist,
      task,
      taskContext,
      userId: context.userId
    });
  }
}

// ---------------------------------------------------------------------------
// SpawnAgentTool — true sub-agent spawning
// ---------------------------------------------------------------------------

export class SpawnAgentTool extends Tool {
  definition: ToolDefinition = {
    name: "spawn_agent",
    description: `Spawn an isolated child agent with a FRESH context and a read-only toolset to complete one bounded task, then return its report as this tool's result. The child cannot see this conversation, cannot modify files, and cannot ask the user questions. Use it to investigate codebases, trace bugs, or gather evidence without flooding your own context — the parent only pays for the final report. Dispatch several spawn_agent calls in one turn to research independent questions in parallel.
Agent types:
- "explore" — codebase ANALYSIS: locate where things live, map structure, trace a code path, answer "how/where does X work". Returns concise conclusions with file paths (cite paths as file:line where possible). Reads excerpts, not whole files — it locates code, it does not review or audit it. Pick breadth: "quick" for a spot check, "medium" (default) for a standard sweep, "very_thorough" for an exhaustive multi-area sweep.
- "general" — open-ended research with the specialist methodology (research/debugging/planning lenses) for questions that need reasoning beyond locating code.`,
    category: "code",
    riskLevel: "read",
    requiresApproval: false,
    parameters: {
      task: {
        type: "string",
        description: "A clear, self-contained task description for the child agent. Include all necessary context since the child has no access to the parent conversation.",
        required: true
      },
      agentType: {
        type: "string",
        description: "\"explore\" for codebase analysis (locations, structure, code paths) or \"general\" for open-ended research. Defaults to \"general\".",
        enum: ["explore", "general"],
        required: false
      },
      breadth: {
        type: "string",
        description: "Only for agentType \"explore\": \"quick\", \"medium\", or \"very_thorough\". Controls how deep the sweep goes (and the default iteration budget: 5/10/20).",
        enum: ["quick", "medium", "very_thorough"],
        required: false
      },
      taskContext: {
        type: "string",
        description: "Optional additional context, constraints, or background information for the child agent.",
        required: false
      },
      maxIterations: {
        type: "number",
        description: "Maximum number of agent loop iterations. Defaults: general 15, explore 5/10/20 by breadth. Max 30.",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const task = typeof params.task === "string" ? params.task.trim() : "";
    const taskContext = typeof params.taskContext === "string" ? params.taskContext.trim() : undefined;
    const agentType: ChildAgentType = params.agentType === "explore" ? "explore" : "general";
    const breadth: ExploreBreadth = params.breadth === "quick" || params.breadth === "very_thorough"
      ? params.breadth
      : "medium";
    // Breadth-driven default budgets for explore runs (general keeps 15).
    const EXPLORE_BREADTH_BUDGET: Record<ExploreBreadth, number> = {
      quick: 5,
      medium: 10,
      very_thorough: 20
    };
    const defaultIterations = agentType === "explore" ? EXPLORE_BREADTH_BUDGET[breadth] : 15;
    const maxIterations = typeof params.maxIterations === "number"
      ? Math.max(1, Math.min(30, Math.floor(params.maxIterations)))
      : defaultIterations;

    if (!task) {
      return { success: false, error: "A task description is required" };
    }

    if (task.length < 20) {
      return { success: false, error: "Task description is too short (min 20 chars). Provide a clear, self-contained task with enough context for the child agent." };
    }

    // Clean up old agents
    childAgentRegistry.cleanup();

    const handle = childAgentRegistry.create({
      parentConversationId: context.conversationId,
      parentRunId: context.runId ?? context.conversationId,
      task,
      taskContext,
      agentType,
      breadth,
      maxIterations
    });

    // Synchronous delegation: run the child to completion here (dynamic
    // import keeps tools/sub-agents.ts out of the runner's eval-time
    // dependency graph — the runner imports the Agent loop, which imports
    // the tool registry, which imports this file).
    const { runChildAgent } = await import("../lib/sub-agent-runner.js");
    const outcome = await runChildAgent(context, undefined, handle);

    return {
      success: outcome.status !== "failed",
      output: outcome.report,
      error: outcome.status === "failed" ? outcome.report : undefined,
      data: {
        agentId: handle.id,
        status: handle.status,
        task: handle.task,
        maxIterations: handle.maxIterations,
        iterationsRun: outcome.iterationCount,
        toolCallsRun: outcome.toolCallCount,
        createdAt: handle.createdAt.toISOString(),
        completedAt: handle.completedAt?.toISOString(),
        report: outcome.report
      }
    };
  }
}

// ---------------------------------------------------------------------------
// CancelAgentTool — terminate a running child agent
// ---------------------------------------------------------------------------

export class CancelAgentTool extends Tool {
  definition: ToolDefinition = {
    name: "cancel_agent",
    description: "Cancel a running child agent. The agent will be stopped immediately and its partial results (if any) will be discarded.",
    category: "code",
    riskLevel: "read",
    parameters: {
      agentId: {
        type: "string",
        description: "The ID of the child agent to cancel.",
        required: true
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";

    if (!agentId) {
      return { success: false, error: "agentId is required" };
    }

    const handle = childAgentRegistry.get(agentId);
    if (!handle) {
      return { success: false, error: `Agent "${agentId}" not found.` };
    }

    if (handle.parentConversationId !== context.conversationId) {
      return { success: false, error: "Cannot cancel agents spawned by a different conversation." };
    }

    if (handle.status === "completed" || handle.status === "failed" || handle.status === "cancelled") {
      return {
        success: true,
        data: {
          agentId: handle.id,
          status: handle.status,
          message: `Agent was already ${handle.status}.`
        }
      };
    }

    const cancelled = childAgentRegistry.cancel(agentId);

    return {
      success: true,
      data: {
        agentId: handle.id,
        status: "cancelled",
        cancelled,
        completedAt: new Date().toISOString(),
        iterationsRun: handle.iterationCount,
        toolCallsRun: handle.toolCallCount,
        message: `Agent "${agentId}" has been cancelled after ${handle.iterationCount} iterations and ${handle.toolCallCount} tool calls.`
      }
    };
  }
}

// ---------------------------------------------------------------------------
// GetAgentStatusTool — inspect child agent progress
// ---------------------------------------------------------------------------

export class GetAgentStatusTool extends Tool {
  definition: ToolDefinition = {
    name: "get_agent_status",
    description: "Check the status and progress of a spawned child agent. Returns the agent's current state, iteration count, tool call count, and result (if completed).",
    category: "code",
    riskLevel: "read",
    parameters: {
      agentId: {
        type: "string",
        description: "The ID of the child agent to inspect. Omit to list all child agents for the current conversation.",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";

    if (!agentId) {
      // List all child agents for this conversation
      const agents = childAgentRegistry.listByParent(context.conversationId);
      if (agents.length === 0) {
        return {
          success: true,
          data: {
            agents: [],
            message: "No child agents found for this conversation."
          }
        };
      }

      return {
        success: true,
        data: {
          agents: agents.map((a) => ({
            id: a.id,
            status: a.status,
            agentType: a.agentType,
            breadth: a.breadth,
            task: a.task.slice(0, 200) + (a.task.length > 200 ? "..." : ""),
            iterations: a.iterationCount,
            maxIterations: a.maxIterations,
            toolCalls: a.toolCallCount,
            createdAt: a.createdAt.toISOString(),
            completedAt: a.completedAt?.toISOString()
          })),
          total: agents.length
        }
      };
    }

    const handle = childAgentRegistry.get(agentId);
    if (!handle) {
      return { success: false, error: `Agent "${agentId}" not found.` };
    }

    if (handle.parentConversationId !== context.conversationId) {
      return { success: false, error: "Cannot inspect agents spawned by a different conversation." };
    }

    return {
      success: true,
      data: {
        id: handle.id,
        status: handle.status,
        agentType: handle.agentType,
        breadth: handle.breadth,
        task: handle.task,
        taskContext: handle.taskContext,
        iterations: handle.iterationCount,
        maxIterations: handle.maxIterations,
        toolCalls: handle.toolCallCount,
        result: handle.result,
        error: handle.error,
        createdAt: handle.createdAt.toISOString(),
        completedAt: handle.completedAt?.toISOString()
      }
    };
  }
}
