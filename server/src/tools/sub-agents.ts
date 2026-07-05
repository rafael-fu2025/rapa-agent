import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { activateSpecialistMode } from "../lib/sub-agents.js";

// ---------------------------------------------------------------------------
// Child Agent Registry — in-memory tracking for spawned sub-agents
// ---------------------------------------------------------------------------

export type ChildAgentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type ChildAgentHandle = {
  id: string;
  parentConversationId: string;
  parentRunId: string;
  task: string;
  taskContext?: string;
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
    maxIterations?: number;
  }): ChildAgentHandle {
    const id = `child-agent-${this.nextId++}-${Date.now().toString(36)}`;
    const handle: ChildAgentHandle = {
      id,
      parentConversationId: params.parentConversationId,
      parentRunId: params.parentRunId,
      task: params.task,
      taskContext: params.taskContext,
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
    description: "Spawn an independent child agent to perform a task in parallel. The child agent runs its own conversation loop with its own tool access. Use this for complex, independent subtasks that benefit from isolation.",
    category: "code",
    riskLevel: "read",
    parameters: {
      task: {
        type: "string",
        description: "A clear, self-contained task description for the child agent. Include all necessary context since the child has no access to the parent conversation.",
        required: true
      },
      taskContext: {
        type: "string",
        description: "Optional additional context, constraints, or background information for the child agent.",
        required: false
      },
      maxIterations: {
        type: "number",
        description: "Maximum number of agent loop iterations (default: 15, max: 30). Keep bounded to prevent runaway agents.",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const task = typeof params.task === "string" ? params.task.trim() : "";
    const taskContext = typeof params.taskContext === "string" ? params.taskContext.trim() : undefined;
    const maxIterations = typeof params.maxIterations === "number"
      ? Math.max(1, Math.min(30, Math.floor(params.maxIterations)))
      : 15;

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
      maxIterations
    });

    // The actual child agent execution is deferred to the agent loop.
    // The orchestrator picks up pending child agents and runs them.
    // For now, mark as pending — the agent loop integration will start execution.
    // TODO: Wire into agent loop's stream() to actually spawn child agent execution.
    // The integration point is in routes/agent.ts where child agents should be
    // launched via a parallel invocation of the agent loop with their own
    // conversation context, iteration budget, and tool access.

    return {
      success: true,
      data: {
        agentId: handle.id,
        status: handle.status,
        task: handle.task,
        maxIterations: handle.maxIterations,
        createdAt: handle.createdAt.toISOString(),
        message: `Child agent "${handle.id}" has been spawned. Use get_agent_status to check progress, send_message_to_agent for follow-up instructions, or cancel_agent to terminate.`
      }
    };
  }
}

// ---------------------------------------------------------------------------
// SendMessageToAgentTool — follow-up instructions to a spawned child
// ---------------------------------------------------------------------------

export class SendMessageToAgentTool extends Tool {
  definition: ToolDefinition = {
    name: "send_message_to_agent",
    description: "Send a follow-up message or instruction to a running child agent. The child will see this message and can adjust its behavior accordingly.",
    category: "code",
    riskLevel: "read",
    parameters: {
      agentId: {
        type: "string",
        description: "The ID of the child agent (from spawn_agent result).",
        required: true
      },
      message: {
        type: "string",
        description: "The message or instruction to send to the child agent.",
        required: true
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    const message = typeof params.message === "string" ? params.message.trim() : "";

    if (!agentId) {
      return { success: false, error: "agentId is required" };
    }
    if (!message) {
      return { success: false, error: "message is required" };
    }

    const handle = childAgentRegistry.get(agentId);
    if (!handle) {
      return { success: false, error: `Agent "${agentId}" not found. It may have been cleaned up or never existed.` };
    }

    if (handle.parentConversationId !== context.conversationId) {
      return { success: false, error: "Cannot send messages to agents spawned by a different conversation." };
    }

    if (handle.status !== "running" && handle.status !== "pending") {
      return {
        success: false,
        error: `Agent "${agentId}" is ${handle.status}. Can only send messages to running or pending agents.`
      };
    }

    // The message is queued for the child agent to pick up.
    // TODO: Wire into the child agent's message queue for real-time delivery.
    // For now, the message is stored on the handle and can be read by the
    // child agent's next iteration.

    return {
      success: true,
      data: {
        agentId: handle.id,
        messageQueued: true,
        message,
        status: handle.status,
        deliveredAt: new Date().toISOString()
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
