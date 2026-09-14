export type ChatAttachment = {
  id: string;
  file?: File;
  kind: "image" | "file";
  name: string;
  mimeType: string;
  dataUrl?: string;
  textContent?: string;
};

export type TokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type ApiKeySwitchInfo = {
  fromKeyName: string;
  toKeyName: string;
};

export type AskUserOption = {
  label: string;
  description?: string;
  preview?: string;
  defaultOption?: boolean;
};

export type AskUserQuestion = {
  question: string;
  header: string;
  options: AskUserOption[];
  multiSelect: boolean;
};

export type AskUserInteractive = {
  type: "ask_user";
  questions: AskUserQuestion[];
};

export type StreamEvent = {
  type: "start" | "chunk" | "done" | "error";
  conversationId?: string;
  model?: string;
  content?: string;
  message?: string;
  tokenUsage?: TokenUsage;
  apiKeySwitch?: ApiKeySwitchInfo;
  interactive?: (
    AskUserInteractive
    | {
        type: "mode_switch";
        suggestedMode: "agent" | "plan";
        prompt: string;
        sourceConversationId?: string;
        approveLabel?: string;
        cancelLabel?: string;
      }
  );
};

export type ConversationMessage = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  mode?: "chat" | "agent" | "plan" | null;
  content: string;
  memoryText?: string | null;
  metadata?: Record<string, unknown> | null;
  model?: string;
  provider?: string;
  /// Reasoning / thinking-mode effort used for this turn. Restored when
  /// reopening the conversation so subsequent messages keep the same
  /// setting. null = unset / use provider default.
  reasoningEffort?: ReasoningEffort | null;
  createdAt: string;
};

export type ConversationListItem = {
  id: string;
  title: string;
  updatedAt: string;
  workspaceId: string | null;
  workspace: { name: string; path: string } | null;
  _count: {
    messages: number;
  };
};

export type ProviderApiKeyRef = {
  id: string;
  name: string;
  maskedKey: string;
  isActive: boolean;
};

export type ProviderSettings = {
  provider: string;
  enabled: boolean;
  baseUrl: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  apiKeys: ProviderApiKeyRef[];
  activeApiKeyId: string | null;
  autoSwitchApiKey: boolean;
  models: string[];
};

export type ApiKeyTestResponse = {
  ok: boolean;
  message?: string;
  keyName?: string;
};

export type GeneralSettingsResponse = {
  provider: string;
  theme: string;
};

export type UsageAnalyticsProviderModel = {
  provider: string;
  model?: string;
  requests: number;
  conversations: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  chatRequests: number;
  agentRequests: number;
  lastUsedAt: string | null;
};

export type UsageAnalyticsResponse = {
  totalRequests: number;
  totalConversations: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  providers: UsageAnalyticsProviderModel[];
  models: UsageAnalyticsProviderModel[];
  dailyUsage: Array<{ date: string; tokens: number; requests: number }>;
};

export type AgentWorkspaceResponse = {
  root: string;
  name: string;
};

export type Provider = {
  provider: string;
  displayName: string;
  isCustom: boolean;
  enabled?: boolean;
  baseUrl?: string;
  models?: string[] | null;
};

export type ProvidersResponse = {
  providers: Provider[];
};

export type ChatResponse = {
  message: ConversationMessage;
};

// API_BASE lives in ./http (shared with agent-api.ts and workspace-api.ts).
// It defaults to `127.0.0.1` (IPv4 loopback) rather than `localhost` to avoid
// IPv6/IPv4 resolution flakiness on Windows — on some machines
// `localhost` resolves to `::1` first and our backend only binds to
// IPv4, so requests would silently fail. The user can override via
// the Vite env `VITE_API_URL` (e.g. "http://192.168.1.5:8787" for
// LAN access).
import { API_BASE, fetchWithAuth, forceAuthLogout, refreshAuthToken } from "./http";

export { API_BASE };

export async function consumeSseStream<TEvent>(
  response: Response,
  handlers: {
    onEvent: (event: TEvent) => void;
    onInvalidEvent?: () => void;
  },
  options?: {
    idleTimeoutMs?: number;
  }
) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Stream body is unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const idleTimeoutMs = options?.idleTimeoutMs ?? 30000;

  // try/finally on every exit path: a throwing onEvent handler or an aborted
  // read used to leave the reader locked and the HTTP stream unconsumed.
  try {
    while (true) {
      // Race reader.read() against an idle timeout
      const timeoutId = setTimeout(() => {
        reader.cancel().catch(() => {});
      }, idleTimeoutMs);

      const { done, value } = await reader.read();
      clearTimeout(timeoutId);

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundaryIndex = buffer.indexOf("\n\n");
      while (boundaryIndex !== -1) {
        const rawEvent = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);

        const dataLines = rawEvent
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());

        if (dataLines.length > 0) {
          const data = dataLines.join("\n");

          try {
            handlers.onEvent(JSON.parse(data) as TEvent);
          } catch {
            handlers.onInvalidEvent?.();
          }
        }

        boundaryIndex = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  // Auth injection, silent token refresh on 401, 429 backoff, and the
  // friendly network-error message all live in fetchWithAuth (http.ts).
  const response = await fetchWithAuth(path, init);

  if (!response.ok) {
    const text = await response.text();
    // A 401 here means the refresh already failed (or the path is an
    // auth path) — forceAuthLogout has run where appropriate. Surface
    // the error text like any other failure.
    throw new Error(text || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function getSettings(provider = "gemini") {
  return apiRequest<ProviderSettings>(`/settings?provider=${encodeURIComponent(provider)}`);
}

export function saveSettings(payload: {
  provider?: string;
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  apiKeyName?: string;
  selectedApiKeyId?: string | null;
  autoSwitchApiKey?: boolean;
  removeApiKeyIds?: string[];
  models?: string[];
}) {
  return apiRequest<ProviderSettings>("/settings", {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function testApiKey(payload: { provider?: string; apiKeyId?: string }) {
  return apiRequest<ApiKeyTestResponse>("/settings/test-key", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export type RefreshModelsResponse = {
  models: string[];
  added: string[];
  removed: string[];
  /** Which response shape the parser detected. */
  source: "openai" | "gemini" | "bare-array" | "unknown";
  /** True if the existing list was replaced; false if it was merged. */
  replaced: boolean;
};

/**
 * Call the provider's upstream `/models` endpoint, parse the response, and
 * persist the result to `ProviderSetting.models`. The caller is expected to
 * apply `response.models` to its UI state so the change is reflected
 * immediately.
 */
export function refreshModels(payload: {
  provider: string;
  apiKeyId?: string;
  merge?: boolean;
}) {
  return apiRequest<RefreshModelsResponse>("/settings/refresh-models", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export type ApiKeyDetailResponse = {
  id: string;
  name: string;
  apiKey: string;
  isActive: boolean;
};

export function getApiKey(payload: { provider: string; apiKeyId: string }) {
  return apiRequest<ApiKeyDetailResponse>("/settings/get-api-key", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateApiKey(payload: { provider: string; apiKeyId: string; name?: string; apiKey?: string }) {
  return apiRequest<{ ok: true }>("/settings/api-key", {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function getGeneralSettings() {
  return apiRequest<GeneralSettingsResponse>("/general-settings");
}

export function getUsageAnalytics() {
  return apiRequest<UsageAnalyticsResponse>("/settings/usage-analytics");
}

export function selectAgentWorkspace(root: string) {
  return apiRequest<AgentWorkspaceResponse>("/agent/workspace/select", {
    method: "POST",
    body: JSON.stringify({ root })
  });
}

export function getAgentWorkspace() {
  return apiRequest<AgentWorkspaceResponse>("/agent/workspace");
}

export function getConversations(cursor?: string, query?: string) {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (query && query.trim()) params.set("q", query.trim());
  const qs = params.toString();
  return apiRequest<{ items: ConversationListItem[], nextCursor?: string }>(qs ? `/conversations?${qs}` : "/conversations");
}

/** Total conversation count — used by the destructive Delete All confirm. */
export function getConversationsCount() {
  return apiRequest<{ count: number }>("/conversations/count");
}

export function getConversationMessages(id: string) {
  return apiRequest<{
    messages: ConversationMessage[];
    workspaceId: string | null;
    workspace: { name: string; path: string } | null;
  }>(`/conversations/${encodeURIComponent(id)}/messages`);
}

export function renameConversation(id: string, title: string) {
  return apiRequest<{ ok: true; title: string }>(`/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ title })
  });
}

export function deleteConversation(id: string) {
  return apiRequest<{ ok: true }>(`/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export function deleteAllConversations() {
  return apiRequest<{ ok: true; count: number }>("/conversations", {
    method: "DELETE"
  });
}

export function forkConversation(conversationId: string, messageId: string) {
  return apiRequest<ConversationListItem>(`/conversations/${encodeURIComponent(conversationId)}/fork`, {
    method: "POST",
    body: JSON.stringify({ messageId })
  });
}

/** Delete one message, or every message after `afterMessageId` (edit-resend). */
export function deleteConversationMessages(
  conversationId: string,
  target: { messageId: string } | { afterMessageId: string }
) {
  return apiRequest<{ ok: true; count: number }>(
    `/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: "DELETE", body: JSON.stringify(target) }
  );
}

/** Persist the answered state of an assistant message's interactive card. */
export function markInteractiveAnswered(conversationId: string, messageId: string) {
  return apiRequest<{ ok: true; id: string }>(
    `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "PATCH", body: JSON.stringify({ interactiveAnswered: true }) }
  );
}

export function getProviders() {
  return apiRequest<ProvidersResponse>("/providers");
}

export function createCustomProvider(payload: {
  provider: string;
  displayName: string;
  baseUrl: string;
  models: string[];
}) {
  return apiRequest<Provider>("/providers/custom", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function deleteCustomProvider(provider: string) {
  return apiRequest<{ ok: true }>(`/providers/custom/${encodeURIComponent(provider)}`, {
    method: "DELETE"
  });
}

export type ReasoningEffort = "off" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "on";

/** Per-model reasoning profile — what effort levels a model actually supports. */
export type ReasoningProfile = {
  provider: string;
  model: string;
  style: "none" | "binary" | "standard" | "extended";
  levels: ReasoningEffort[];
  source: "model-pattern" | "provider-default" | "upstream-metadata" | "denylist";
};

export function getReasoningProfile(provider: string, model: string) {
  return apiRequest<ReasoningProfile>(
    `/settings/reasoning-profile?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`
  );
}

export function sendChat(payload: {
  prompt: string;
  provider?: string;
  model?: string;
  conversationId?: string;
  workspaceId?: string;
  attachments?: ChatAttachment[];
  mode?: "chat" | "agent";
  reasoningEffort?: ReasoningEffort;
}) {
  return apiRequest<ChatResponse>("/chat", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function streamChat(
  payload: {
    prompt: string;
    provider?: string;
    model?: string;
    conversationId?: string;
    workspaceId?: string;
    attachments?: ChatAttachment[];
    mode?: "chat" | "agent" | "plan";
    reasoningEffort?: ReasoningEffort;
  },
  handlers: {
    onStart?: (event: StreamEvent) => void;
    onChunk?: (chunk: string, event: StreamEvent) => void;
    onDone?: (event: StreamEvent) => void;
    onError?: (message: string) => void;
    onReconnect?: (attempt: number, maxAttempts: number) => void;
  },
  options?: {
    signal?: AbortSignal;
  }
) {
  let attempt = 0;
  const maxAttempts = 10;
  const baseDelay = 1000;
  const maxDelay = 5000;
  let refreshed401 = false;

  // Mutable payload copy — updated with conversationId from start events
  // so that retries don't create duplicate conversations.
  const livePayload = { ...payload };

  while (attempt < maxAttempts) {
    try {
      if (options?.signal?.aborted) return;

      const headers = new Headers({
        "Content-Type": "application/json"
      });
      const token = localStorage.getItem("auth_token");
      if (token) headers.set("Authorization", `Bearer ${token}`);

      let response: Response;
      try {
        response = await fetch(`${API_BASE}/chat/stream`, {
          method: "POST",
          headers,
          body: JSON.stringify(livePayload),
          signal: options?.signal
        });
      } catch (err) {
        // Same friendly network-error message as apiRequest — the
        // most common cause is the backend not running or binding to
        // a different address than the client expects.
        const message = err instanceof Error ? err.message : "Unknown network error";
        throw new Error(
          `Couldn't reach the API at ${API_BASE}/chat/stream: ${message}. ` +
            "Is the backend running? Try `cd server && npm run dev` in a terminal.",
          { cause: err }
        );
      }

      if (response.status === 401) {
        // Try one silent refresh before giving up — a token that expired
        // mid-session shouldn't hard-logout the user (audit M0.2). Only
        // a provably invalid token redirects to /login.
        if (!refreshed401) {
          const outcome = await refreshAuthToken();
          if (outcome === "refreshed") {
            refreshed401 = true;
            continue;
          }
          if (outcome === "invalid") forceAuthLogout();
          return;
        }
        forceAuthLogout();
        return;
      }

      // Permanent client errors (400/403/404/413/422…) must not be
      // retried — the same payload will fail identically and the old
      // loop showed a "Reconnecting…" banner up to 10 times (audit M3).
      if (response.status >= 400 && response.status < 500 && response.status !== 429 && response.status !== 408) {
        const errorBody = await response.json().catch(() => null) as { message?: string } | null;
        handlers.onError?.(errorBody?.message || `Request failed: ${response.status}`);
        return;
      }

      let receivedDone = false;
      let receivedError = false;
      await consumeSseStream<StreamEvent>(response, {
        onEvent: (event) => {
          if (event.type === "start") {
            // Capture the server-assigned conversationId for retries
            if (typeof event.conversationId === "string" && event.conversationId) {
              livePayload.conversationId = event.conversationId;
            }
            handlers.onStart?.(event);
          } else if (event.type === "chunk") {
            handlers.onChunk?.(event.content ?? "", event);
          } else if (event.type === "done") {
            receivedDone = true;
            handlers.onDone?.(event);
          } else if (event.type === "error") {
            receivedError = true;
            handlers.onError?.(event.message ?? "Streaming error");
          }
        },
        onInvalidEvent: () => {
          handlers.onError?.("Invalid stream event received");
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
        handlers.onError?.(err instanceof Error ? err.message : "Stream connection failed");
        return;
      }

      handlers.onReconnect?.(attempt, maxAttempts);
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay) + Math.random() * 500;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ---- Service API Keys (Serper, etc.) ----

export type ServiceApiKeyRef = {
  id: string;
  name: string;
  maskedKey: string;
  isActive: boolean;
  autoSwitch: boolean;
  createdAt: string;
};

export type ServiceKeysResponse = {
  keys: ServiceApiKeyRef[];
  autoSwitch: boolean;
};

export function getServiceKeys(service: string) {
  return apiRequest<ServiceKeysResponse>(`/service-keys?service=${encodeURIComponent(service)}`);
}

export function addServiceKey(payload: { service: string; name: string; apiKey: string }) {
  return apiRequest<ServiceApiKeyRef>("/service-keys", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateServiceKey(id: string, payload: { name?: string; apiKey?: string }) {
  return apiRequest<ServiceApiKeyRef>(`/service-keys/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteServiceKey(id: string) {
  return apiRequest<{ ok: boolean }>(`/service-keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function setActiveServiceKey(service: string, keyId: string) {
  return apiRequest<{ ok: boolean }>("/service-keys/active", {
    method: "POST",
    body: JSON.stringify({ service, keyId }),
  });
}

export function toggleServiceAutoSwitch(service: string, enabled: boolean) {
  return apiRequest<{ ok: boolean }>("/service-keys/auto-switch", {
    method: "PATCH",
    body: JSON.stringify({ service, enabled }),
  });
}

export function getServiceStatus(service: string) {
  return apiRequest<{ service: string; enabled: boolean }>(
    `/service-keys/status?service=${encodeURIComponent(service)}`
  );
}

export function setServiceStatus(service: string, enabled: boolean) {
  return apiRequest<{ ok: boolean; service: string; enabled: boolean }>("/service-keys/status", {
    method: "PATCH",
    body: JSON.stringify({ service, enabled }),
  });
}

export function decryptServiceKey(id: string) {
  return apiRequest<{ id: string; name: string; apiKey: string }>(`/service-keys/${encodeURIComponent(id)}/decrypt`);
}
