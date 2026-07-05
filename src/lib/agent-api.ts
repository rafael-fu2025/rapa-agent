// Agent API client

import {
  API_BASE,
  consumeSseStream,
  type ApiKeySwitchInfo,
  type AskUserInteractive,
  type TokenUsage
} from "./api";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Thin wrapper around fetch that retries on 429 (rate limit) with
 * exponential backoff.  Used by the polling endpoints (agent run status,
 * registry, conversations list) so the UI degrades gracefully when the
 * server rate limiter kicks in instead of silently failing.
 */
async function fetchWithRateLimitRetry(
  url: string,
  init?: RequestInit,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      // Network-level failure (DNS, connection refused, etc.). Surface
      // a clear message so the UI can show a useful error instead of
      // the raw "Failed to fetch" TypeError.
      const message = err instanceof Error ? err.message : "Unknown network error";
      throw new Error(
        `Couldn't reach ${url}: ${message}. ` +
          "Is the backend running? Try `cd server && npm run dev` in a terminal."
      );
    }
    if (response.status !== 429 || attempt === maxRetries) return response;
    const retryAfter = response.headers.get("retry-after");
    const delayMs = retryAfter
      ? Math.min(parseInt(retryAfter, 10) * 1000, 30_000)
      : Math.min(1000 * Math.pow(2, attempt), 10_000);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  // Unreachable, but TS needs it
  return fetch(url, init);
}


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
  toolCalls?: unknown[];
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
  const response = await fetch(`${API_BASE}/agent/tools`, { headers: authHeaders() });
  if (!response.ok) {
    throw new Error("Failed to fetch tools");
  }
  return response.json();
}

export async function submitAgentToolApproval(payload: { approvalId: string; approved: boolean; message?: string }) {
  const response = await fetch(`${API_BASE}/agent/approvals`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(error?.message || "Failed to submit tool approval");
  }

  return response.json() as Promise<{ ok: true; approvalId: string; approved: boolean }>;
}

export async function getAgentRun(runId: string) {
  const response = await fetchWithRateLimitRetry(`${API_BASE}/agent/runs/${encodeURIComponent(runId)}`, { headers: authHeaders() });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(error?.message || "Failed to fetch agent run");
  }
  return response.json() as Promise<{ run: AgentRunDetail }>;
}

export async function listAgentRuns(params?: { conversationId?: string; workspaceId?: string; limit?: number }) {
  const searchParams = new URLSearchParams();
  if (params?.conversationId) searchParams.set("conversationId", params.conversationId);
  if (params?.workspaceId) searchParams.set("workspaceId", params.workspaceId);
  if (typeof params?.limit === "number") searchParams.set("limit", String(params.limit));
  const query = searchParams.toString();
  const response = await fetchWithRateLimitRetry(`${API_BASE}/agent/runs${query ? `?${query}` : ""}`, { headers: authHeaders() });
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
  const response = await fetch(`${API_BASE}/agent/checkpoints/${encodeURIComponent(checkpointId)}/restore`, {
    method: "POST",
    headers: { ...(options.confirmation ? { "Content-Type": "application/json" } : {}), ...authHeaders() },
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
  const response = await fetch(`${API_BASE}/agent/checkpoints/${encodeURIComponent(checkpointId)}/preview`, { headers: authHeaders() });
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
  const response = await fetch(`${API_BASE}/agent/checkpoints${query ? `?${query}` : ""}`, { headers: authHeaders() });
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
  const response = await fetch(`${API_BASE}/agent/tools/validate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
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
  const response = await fetch(`${API_BASE}/agent/diagnostics/lint`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
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
  const response = await fetch(`${API_BASE}/agent/diagnostics/test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
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
  const response = await fetch(`${API_BASE}/agent/rules`, { headers: authHeaders() });
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
  const response = await fetch(`${API_BASE}/agent/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Failed to save agent rule");
  return response.json() as Promise<{ rule: AgentRule }>;
}

export async function listAgentSkills() {
  const response = await fetch(`${API_BASE}/agent/skills`, { headers: authHeaders() });
  if (!response.ok) throw new Error("Failed to load agent skills");
  return response.json() as Promise<{ skills: AgentSkill[] }>;
}

export async function listAgentSpecialists() {
  const response = await fetch(`${API_BASE}/agent/specialists`, { headers: authHeaders() });
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
  const response = await fetch(`${API_BASE}/agent/skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Failed to save agent skill");
  return response.json() as Promise<{ skill: AgentSkill }>;
}

export async function listAgentMcpServers() {
  const response = await fetch(`${API_BASE}/agent/mcp/servers`, { headers: authHeaders() });
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
  const response = await fetch(`${API_BASE}/agent/mcp/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Failed to save MCP server");
  return response.json() as Promise<{ server: AgentMcpServer }>;
}

export async function listAgentIntegrations() {
  const response = await fetch(`${API_BASE}/agent/integrations`, { headers: authHeaders() });
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
  const response = await fetch(`${API_BASE}/agent/integrations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
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
  const response = await fetch(`${API_BASE}/agent/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
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
    reasoningEffort?: "off" | "low" | "medium" | "high" | "max";
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
  const maxAttempts = 30;
  const baseDelay = 1000;
  const maxDelay = 5000;

  // Mutable params copy — updated with conversationId from start events
  // so that retries don't create duplicate conversations.
  const liveParams = { ...params };

  while (attempt < maxAttempts) {
    try {
      if (options?.signal?.aborted) return;

      const headers = new Headers({
        "Content-Type": "application/json"
      });
      const token = localStorage.getItem("auth_token");
      if (token) headers.set("Authorization", `Bearer ${token}`);

      const response = await fetch(`${API_BASE}/agent/execute/stream`, {
        method: "POST",
        headers,
        body: JSON.stringify(liveParams),
        signal: options?.signal
      });

      if (response.status === 401) {
        localStorage.removeItem("auth_token");
        window.location.href = "/login";
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
            handlers.onToolCall?.(event);
          } else if (event.type === "assistant") {
            handlers.onAssistant?.(event);
          } else if (event.type === "step") {
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
