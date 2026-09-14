// Agent API client

import {
  consumeSseStream,
  type ApiKeySwitchInfo,
  type AskUserInteractive,
  type TokenUsage
} from "./api";
import { fetchWithAuth } from "./http";

export type ToolDefinition = {
  name: string;
  description: string;
  category: string;
  requiresApproval: boolean;
  parameters: Record<string, unknown>;
};

export type AgentApprovalData = {
  requiresApproval?: boolean;
  approvalId?: string;
  conversationId?: string;
  callId?: string;
  tool?: string;
  parameters?: Record<string, unknown>;
};

export type AgentToolResult = {
  success: boolean;
  data?: unknown;
  error?: string;
  output?: string;
};


export type AgentToolCall = {
  id: string;
  name: string;
  parameters: Record<string, unknown>;
};

export type AgentStep = {
  iteration: number;
  reasoning?: string;
  toolCalls: AgentToolCall[];
  toolResults: AgentToolResult[];
  response?: string;
  timestamp: string;
};

export type AgentExecutionResult = {
  conversationId: string;
  response: string;
  steps: AgentStep[];
  iterations: number;
  tokenUsage?: TokenUsage;
  agentRunId?: string;
  assistantMessageId?: string;
};

export type AgentCheckpoint = {
  id: string;
  runId: string;
  stepId?: string | null;
  toolCallId?: string | null;
  workspaceId?: string | null;
  path: string;
  status: string;
  diffPreview?: string | null;
  restoreNote?: string | null;
  restoredAt?: string | null;
  createdAt: string;
  updatedAt: string;
  canRestore?: boolean;
  toolCall?: {
    id: string;
    name: string;
    status: string;
  } | null;
};

export type AgentRunProcessSession = {
  id: string;
  kind: string;
  status: string;
  command: string;
  cwd: string;
  pid?: number | null;
  exitCode?: number | null;
  stdoutPreview?: string | null;
  stderrPreview?: string | null;
  outputSummary?: string | null;
  startedAt: string;
  completedAt?: string | null;
};

export type AgentRunDetail = {
  id: string;
  conversationId: string;
  workspaceId?: string | null;
  status: string;
  provider?: string | null;
  model?: string | null;
  promptPreview?: string | null;
  responsePreview?: string | null;
  runSummary?: string | null;
  errorMessage?: string | null;
  tokenUsage?: TokenUsage | null;
  iterationCount: number;
  startedAt: string;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  checkpoints: AgentCheckpoint[];
  processSessions: AgentRunProcessSession[];
  steps?: unknown[];
  toolCalls?: Array<{ id: string; name: string | null; createdAt: string; [key: string]: unknown }>;
};

export type AgentRunSummary = {
  id: string;
  conversationId: string;
  workspaceId?: string | null;
  triggerMessageId?: string | null;
  assistantMessageId?: string | null;
  status: string;
  provider?: string | null;
  model?: string | null;
  promptPreview?: string | null;
  responsePreview?: string | null;
  runSummary?: string | null;
  errorMessage?: string | null;
  tokenUsage?: TokenUsage | null;
  iterationCount: number;
  startedAt: string;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  conversation?: { title?: string | null } | null;
  workspace?: { name?: string | null; path?: string | null } | null;
  _count?: {
    steps: number;
    toolCalls: number;
    checkpoints: number;
    processSessions: number;
  };
};


export type AgentToolCallStatus = "pending" | "running" | "completed" | "failed" | "requires_approval";


export type AgentLiveToolCall = {
  iteration: number;
  status: AgentToolCallStatus;
  call: AgentToolCall;
  result?: AgentToolResult;
};

export type AgentExecutionEvent =
  | {
      type: "start";
      conversationId: string;
      model: string;
      /** Present when the run was persisted — addresses the exit-hatch control routes. */
      runId?: string;
    }
  | {
      type: "thinking";
      iteration: number;
      reasoning?: string;
    }
  | ({
      type: "tool_call";
    } & AgentLiveToolCall)
  | {
      type: "assistant";
      iteration: number;
      content: string;
      final: boolean;
      interactive?: AskUserInteractive;
    }
  | {
      type: "step";
      step: AgentStep;
    }
  | {
      type: "done";
      status?: "completed" | "max_iterations";
      response: string;
      steps: AgentStep[];
      iterations: number;
      tokenUsage?: TokenUsage;
      agentRunId?: string;
      assistantMessageId?: string;
      apiKeySwitch?: ApiKeySwitchInfo;
      interactive?: AskUserInteractive;
    }


  | {
      type: "error";
      message: string;
      iteration?: number;
    };

export async function listTools(): Promise<{ tools: ToolDefinition[] }> {
  const response = await fetchWithAuth(`/agent/tools`);
  if (!response.ok) {
    throw new Error("Failed to fetch tools");
  }
  return response.json();
}

export async function submitAgentToolApproval(payload: { approvalId: string; approved: boolean; message?: string }) {
  const response = await fetchWithAuth(`/agent/approvals`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(error?.message || "Failed to submit tool approval");
  }

  return response.json() as Promise<{ ok: true; approvalId: string; approved: boolean }>;
}

export type PendingApprovalInfo = {
  approvalId: string;
  conversationId: string;
  toolName: string;
  command: string;
  createdAt: number;
};

/** Pending (unanswered) approvals — re-presents prompts after a reload. */
export async function listPendingApprovals(conversationId?: string) {
  const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
  const response = await fetchWithAuth(`/agent/approvals/pending${query}`);
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(error?.message || "Failed to fetch pending approvals");
  }
  return response.json() as Promise<{ approvals: PendingApprovalInfo[] }>;
}

/* ---- Exit-hatch run controls (abort / pause / resume) ---- */

async function runControlRequest(runId: string, action: "abort" | "pause" | "resume"): Promise<{ ok: boolean; status?: string }> {
  const response = await fetchWithAuth(`/agent/runs/${encodeURIComponent(runId)}/${action}`, { method: "POST" });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(error?.message || `Failed to ${action} run`);
  }
  return response.json() as Promise<{ ok: boolean; status?: string }>;
}

export function abortAgentRun(runId: string) {
  return runControlRequest(runId, "abort");
}

export function pauseAgentRun(runId: string) {
  return runControlRequest(runId, "pause");
}

export function resumeAgentRun(runId: string) {
  return runControlRequest(runId, "resume");
}

/* ---- Run fetch cache ----
   Opening a conversation with N agent messages used to fire N full
   GET /agent/runs/:id requests just to recover tool display names
   (audit M3). Cache responses per run id (short TTL, since runs are
   immutable once finished) and dedupe in-flight requests. */

const agentRunCache = new Map<string, { promise: Promise<{ run: AgentRunDetail }>; expiresAt: number }>();
const AGENT_RUN_CACHE_TTL_MS = 60_000;

export async function getAgentRun(runId: string) {
  const cached = agentRunCache.get(runId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }
  const promise = (async () => {
    const response = await fetchWithAuth(`/agent/runs/${encodeURIComponent(runId)}`);
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { message?: string } | null;
      throw new Error(error?.message || "Failed to fetch agent run");
    }
    return response.json() as Promise<{ run: AgentRunDetail }>;
  })();
  // Never cache failures — a rejected promise must not poison the entry.
  promise.catch(() => agentRunCache.delete(runId));
  // Bounded memory: evict expired entries, then oldest beyond 50.
  if (agentRunCache.size > 50) {
    const now = Date.now();
    for (const [key, entry] of agentRunCache) {
      if (entry.expiresAt <= now) agentRunCache.delete(key);
    }
    while (agentRunCache.size > 50) {
      const oldest = agentRunCache.keys().next().value;
      if (oldest === undefined) break;
      agentRunCache.delete(oldest);
    }
  }
  agentRunCache.set(runId, { promise, expiresAt: Date.now() + AGENT_RUN_CACHE_TTL_MS });
  return promise;
}

export async function listAgentRuns(params?: { conversationId?: string; workspaceId?: string; limit?: number }) {
  const searchParams = new URLSearchParams();
  if (params?.conversationId) searchParams.set("conversationId", params.conversationId);
  if (params?.workspaceId) searchParams.set("workspaceId", params.workspaceId);
  if (typeof params?.limit === "number") searchParams.set("limit", String(params.limit));
  const query = searchParams.toString();
  const response = await fetchWithAuth(`/agent/runs${query ? `?${query}` : ""}`);
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(error?.message || "Failed to fetch agent runs");
  }
  return response.json() as Promise<{ runs: AgentRunSummary[] }>;
}

export async function restoreAgentCheckpoint(
  checkpointId: string,
  options: { confirmation?: string } = {}
) {
  const response = await fetchWithAuth(`/agent/checkpoints/${encodeURIComponent(checkpointId)}/restore`, {
    method: "POST",
    headers: { ...(options.confirmation ? { "Content-Type": "application/json" } : {}) },
    body: options.confirmation ? JSON.stringify({ confirmation: options.confirmation }) : undefined
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as
      | { message?: string; requiresConfirmation?: boolean; expectedConfirmation?: string }
      | null;
    if (error?.requiresConfirmation) {
      const err = new Error(error.message || "Confirmation required to restore this checkpoint") as Error & {
        requiresConfirmation?: boolean;
        expectedConfirmation?: string;
      };
      err.requiresConfirmation = true;
      err.expectedConfirmation = error.expectedConfirmation;
      throw err;
    }
    throw new Error(error?.message || "Failed to restore checkpoint");
  }
  return response.json() as Promise<{
    ok: true;
    checkpoint: Pick<AgentCheckpoint, "id" | "status" | "restoredAt" | "restoreNote">;
  }>;
}

export async function previewAgentCheckpoint(checkpointId: string) {
  const response = await fetchWithAuth(`/agent/checkpoints/${encodeURIComponent(checkpointId)}/preview`);
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(error?.message || "Failed to load checkpoint preview");
  }
  return response.json() as Promise<{
    id: string;
    path: string;
    status: string;
    canRestore: boolean;
    diffPreview: string | null;
    beforeContent: string | null;
    afterContent: string | null;
    toolCall: { name: string; parameters: unknown } | null;
    run: { id: string; conversationId: string } | null;
    previewOnly: true;
  }>;
}

export async function listAgentCheckpoints(params: {
  workspaceId?: string;
  runId?: string;
  status?: "created" | "restored" | "failed";
  limit?: number;
  offset?: number;
} = {}) {
  const searchParams = new URLSearchParams();
  if (params.workspaceId) searchParams.set("workspaceId", params.workspaceId);
  if (params.runId) searchParams.set("runId", params.runId);
  if (params.status) searchParams.set("status", params.status);
  if (typeof params.limit === "number") searchParams.set("limit", String(params.limit));
  if (typeof params.offset === "number") searchParams.set("offset", String(params.offset));
  const query = searchParams.toString();
  const response = await fetchWithAuth(`/agent/checkpoints${query ? `?${query}` : ""}`);
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(error?.message || "Failed to fetch checkpoints");
  }
  return response.json() as Promise<{
    items: Array<{
      id: string;
      runId: string;
      stepId: string | null;
      toolCallId: string | null;
      path: string;
      status: string;
      diffPreview: string | null;
      restoreNote: string | null;
      restoredAt: string | null;
      createdAt: string;
      toolCall: { name: string; status: string } | null;
      run: { id: string; status: string; conversationId: string; startedAt: string };
    }>;
    total: number;
    limit: number;
    offset: number;
  }>;
}

export async function validateAgentTool(payload: {
  name: string;
  parameters?: Record<string, unknown>;
  mode?: "chat" | "agent" | "plan";
}) {
  const response = await fetchWithAuth(`/agent/tools/validate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(error?.message || "Failed to validate tool parameters");
  }

  return response.json() as Promise<{
    valid: boolean;
    errors: string[];
    tool: { name: string; category: string; requiresApproval: boolean };
  }>;
}

export async function runAgentLintDiagnostics(payload?: { workspaceId?: string; workdir?: string; timeout?: number }) {
  const response = await fetchWithAuth(`/agent/diagnostics/lint`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload ?? {})
  });

  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(error?.message || "Failed to run lint diagnostics");
  }

  return response.json() as Promise<Record<string, unknown>>;
}

export async function runAgentTestDiagnostics(payload?: { workspaceId?: string; workdir?: string; timeout?: number }) {
  const response = await fetchWithAuth(`/agent/diagnostics/test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload ?? {})
  });

  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(error?.message || "Failed to run test diagnostics");
  }

  return response.json() as Promise<Record<string, unknown>>;
}

export type AgentRule = {
  id: string;
  name: string;
  content: string;
  scope: "global" | "workspace" | "conversation";
  priority: number;
  enabled: boolean;
  workspaceId?: string | null;
  conversationId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentSkill = {
  id: string;
  name: string;
  description?: string | null;
  source?: string | null;
  version?: string | null;
  enabled: boolean;
  config?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentSpecialist = {
  name: string;
  description: string;
  instructions: string;
  whenToUse: string[];
  suggestedTools: string[];
  source: "builtin" | "database";
  builtinDescription?: string | null;
  builtinInstructions?: string | null;
};

export type AgentMcpServer = {
  id: string;
  name: string;
  endpoint: string;
  transport: "sse" | "ws" | "http";
  enabled: boolean;
  authType: "none" | "bearer" | "basic" | "apiKey";
  config?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentIntegration = {
  id: string;
  name: string;
  provider: string;
  type: "deploy" | "database";
  enabled: boolean;
  status: "disconnected" | "connected" | "error";
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export async function listAgentRules() {
  const response = await fetchWithAuth(`/agent/rules`);
  if (!response.ok) throw new Error("Failed to load agent rules");
  return response.json() as Promise<{ rules: AgentRule[] }>;
}

export async function upsertAgentRule(payload: {
  id?: string;
  name: string;
  content: string;
  scope?: "global" | "workspace" | "conversation";
  priority?: number;
  enabled?: boolean;
  workspaceId?: string | null;
  conversationId?: string | null;
}) {
  const response = await fetchWithAuth(`/agent/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Failed to save agent rule");
  return response.json() as Promise<{ rule: AgentRule }>;
}

export async function listAgentSkills() {
  const response = await fetchWithAuth(`/agent/skills`);
  if (!response.ok) throw new Error("Failed to load agent skills");
  return response.json() as Promise<{ skills: AgentSkill[] }>;
}

/** Remove a stored skill / specialist override entirely. */
export async function deleteAgentSkill(id: string) {
  const response = await fetchWithAuth(`/agent/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error("Failed to delete skill");
  return response.json() as Promise<{ ok: true }>;
}

/* ---- Auto-approve patterns (progressive trust) ---- */

export type AutoApprovePattern = {
  id: string;
  userId: string;
  workspaceId?: string | null;
  conversationId?: string | null;
  name: string;
  pattern: string;
  matchType: "exact" | "prefix" | "wildcard" | "regex";
  toolName?: string | null;
  scope: "global" | "workspace" | "conversation";
  enabled: boolean;
  useCount: number;
  lastUsedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function listAutoApprovePatterns() {
  const response = await fetchWithAuth(`/agent/auto-approve-patterns`);
  if (!response.ok) throw new Error("Failed to load auto-approve patterns");
  return response.json() as Promise<{ patterns: AutoApprovePattern[] }>;
}

export async function upsertAutoApprovePattern(payload: {
  id?: string;
  name: string;
  pattern: string;
  matchType?: "exact" | "prefix" | "wildcard" | "regex";
  toolName?: string;
  scope?: "global" | "workspace" | "conversation";
  enabled?: boolean;
  workspaceId?: string | null;
  conversationId?: string | null;
}) {
  const response = await fetchWithAuth(`/agent/auto-approve-patterns`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(error?.message || "Failed to save auto-approve pattern");
  }
  return response.json() as Promise<{ pattern: AutoApprovePattern }>;
}

export async function deleteAutoApprovePattern(id: string) {
  const response = await fetchWithAuth(`/agent/auto-approve-patterns/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
  if (!response.ok) throw new Error("Failed to delete auto-approve pattern");
  return response.json() as Promise<{ ok: true }>;
}

export async function listAgentSpecialists() {
  const response = await fetchWithAuth(`/agent/specialists`);
  if (!response.ok) throw new Error("Failed to load agent specialists");
  return response.json() as Promise<{ specialists: AgentSpecialist[] }>;
}

export async function upsertAgentSkill(payload: {
  id?: string;
  name: string;
  description?: string;
  source?: string;
  version?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}) {
  const response = await fetchWithAuth(`/agent/skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Failed to save agent skill");
  return response.json() as Promise<{ skill: AgentSkill }>;
}

export async function listAgentMcpServers() {
  const response = await fetchWithAuth(`/agent/mcp/servers`);
  if (!response.ok) throw new Error("Failed to load MCP servers");
  return response.json() as Promise<{ servers: AgentMcpServer[] }>;
}

export async function upsertAgentMcpServer(payload: {
  id?: string;
  name: string;
  endpoint: string;
  transport?: "sse" | "ws" | "http";
  enabled?: boolean;
  authType?: "none" | "bearer" | "basic" | "apiKey";
  config?: Record<string, unknown>;
}) {
  const response = await fetchWithAuth(`/agent/mcp/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Failed to save MCP server");
  return response.json() as Promise<{ server: AgentMcpServer }>;
}

export async function listAgentIntegrations() {
  const response = await fetchWithAuth(`/agent/integrations`);
  if (!response.ok) throw new Error("Failed to load agent integrations");
  return response.json() as Promise<{ integrations: AgentIntegration[] }>;
}

export async function upsertAgentIntegration(payload: {
  id?: string;
  name: string;
  provider: string;
  type?: "deploy" | "database";
  enabled?: boolean;
  status?: "disconnected" | "connected" | "error";
  metadata?: Record<string, unknown>;
}) {
  const response = await fetchWithAuth(`/agent/integrations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Failed to save agent integration");
  return response.json() as Promise<{ integration: AgentIntegration }>;
}

export async function executeAgent(params: {


  prompt: string;
  provider: string;
  model?: string;
  conversationId?: string;
  workspaceId?: string;
  maxIterations?: number;
  autoApproveTools?: string[];
}): Promise<AgentExecutionResult> {
  const response = await fetchWithAuth(`/agent/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params)
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || "Agent execution failed");
  }

  return response.json();
}

export async function streamAgent(
  params: {
    prompt: string;
    provider: string;
    model?: string;
    conversationId?: string;
    workspaceId?: string;
    maxIterations?: number;
    autoApproveTools?: string[];
    mode?: "agent" | "plan";
    /**
     * Per-request reasoning / thinking-mode depth. Translated to the
     * provider's native field shape (reasoning_effort for OpenAI,
     * thinking_budget for Gemini, thinking+budget_tokens for Claude,
     * etc.) by the backend's reasoning-translator.
     *   off     → don't add any reasoning parameter (provider default)
     *   low     → light thinking, fastest + cheapest
     *   medium  → balanced (typical default for OpenAI o-series)
     *   high    → deep thinking, slower, better for complex agentic work
     *   max     → maximum effort (DeepSeek, Claude 4.7+ maps to high)
     * Omit to use the provider default.
     */
    reasoningEffort?: "off" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "on";
  },
  handlers: {
    onStart?: (event: Extract<AgentExecutionEvent, { type: "start" }>) => void;
    onThinking?: (event: Extract<AgentExecutionEvent, { type: "thinking" }>) => void;
    onToolCall?: (event: Extract<AgentExecutionEvent, { type: "tool_call" }>) => void;
    onAssistant?: (event: Extract<AgentExecutionEvent, { type: "assistant" }>) => void;
    onStep?: (event: Extract<AgentExecutionEvent, { type: "step" }>) => void;
    onDone?: (event: Extract<AgentExecutionEvent, { type: "done" }>) => void;
    onError?: (message: string, event?: Extract<AgentExecutionEvent, { type: "error" }>) => void;
    onReconnect?: (attempt: number, maxAttempts: number) => void;
  },
  options?: {
    signal?: AbortSignal;
  }
) {
  let attempt = 0;
  // Capped at 3 (was 30): each retry re-POSTs the full prompt, and the agent
  // may re-execute side-effectful tools on every attempt. A few quick retries
  // cover transient drops; anything longer needs the user to decide.
  const maxAttempts = 3;
  const baseDelay = 1000;
  const maxDelay = 5000;

  // Mutable params copy — updated with conversationId from start events
  // so that retries don't create duplicate conversations.
  const liveParams = { ...params };
  // Set the moment the run performs anything side-effectful (a tool call or
  // a committed step). Once set, auto-reconnect is disabled — re-running
  // could duplicate file writes and shell commands. The user sees the error
  // and decides whether to resend.
  let sideEffectsOccurred = false;

  while (attempt < maxAttempts) {
    try {
      if (options?.signal?.aborted) return;

      const response = await fetchWithAuth(`/agent/execute/stream`, {
        method: "POST",
        body: JSON.stringify(liveParams),
        signal: options?.signal
      });

      if (response.status === 401) {
        // fetchWithAuth already attempted a silent refresh and, when the
        // token is provably invalid, redirected to /login. Nothing to do.
        return;
      }

      let receivedDone = false;
      let receivedError = false;
      await consumeSseStream<AgentExecutionEvent>(response, {
        onEvent: (event) => {
          if (event.type === "start") {
            // Capture the server-assigned conversationId for retries
            if (typeof event.conversationId === "string" && event.conversationId) {
              liveParams.conversationId = event.conversationId;
            }
            handlers.onStart?.(event);
          } else if (event.type === "thinking") {
            handlers.onThinking?.(event);
          } else if (event.type === "tool_call") {
            sideEffectsOccurred = true;
            handlers.onToolCall?.(event);
          } else if (event.type === "assistant") {
            handlers.onAssistant?.(event);
          } else if (event.type === "step") {
            sideEffectsOccurred = true;
            handlers.onStep?.(event);
          } else if (event.type === "done") {
            receivedDone = true;
            handlers.onDone?.(event);
          } else if (event.type === "error") {
            receivedError = true;
            handlers.onError?.(event.message, event);
          }
        },
        onInvalidEvent: () => {
          handlers.onError?.("Invalid agent stream event received");
        }
      });

      if (receivedDone || receivedError || options?.signal?.aborted) {
        return; // Success, exit retry loop
      }
      throw new Error("Stream closed before receiving done event");

    } catch (err) {
      if (options?.signal?.aborted || err instanceof DOMException && err.name === "AbortError") {
        return; // User aborted, don't retry
      }

      if (sideEffectsOccurred) {
        // Never auto-resend a run that already executed tools — the retry
        // would re-run them from scratch.
        handlers.onError?.(
          err instanceof Error
            ? `Connection lost after the agent had already executed tools: ${err.message}. The run's results so far are saved — resend the message manually if you want to continue.`
            : "Connection lost after the agent had already executed tools. The run's results so far are saved — resend the message manually if you want to continue."
        );
        return;
      }

      attempt++;
      if (attempt >= maxAttempts) {
        handlers.onError?.(err instanceof Error ? err.message : "Agent stream connection failed");
        return;
      }

      handlers.onReconnect?.(attempt, maxAttempts);
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay) + Math.random() * 500;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
