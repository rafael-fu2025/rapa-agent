// LLM HTTP streaming client with API-key failover and tool-call recovery.
// The Agent class composes an LLMClient to perform model calls; this module
// owns the HTTP layer and key rotation logic.

import { decryptText } from "../crypto.js";
import { toolRegistry } from "../../tools/index.js";
import type { AgentExecutionMode, ToolDefinition } from "../tools.js";
import {
  extractReasoningDelta
} from "./response-parser.js";
import {
  translateReasoning,
  type ReasoningSetting
} from "./reasoning-translator.js";
import {
  mergeTokenUsage,
  normalizeTokenUsage,
  RETRY_LLM_TIMEOUT_MS,
  type AgentConfig,
  type AgentMessage,
  type AgentTokenUsage,
  type ApiKeySwitchInfo,
  type ProviderChatMessage,
  type ProviderTokenUsage,
  type ToolCall
} from "./types.js";

export function getAvailableTools(mode: AgentExecutionMode, allowedToolNames?: string[]): ToolDefinition[] {
  const tools = toolRegistry.listForMode(mode);
  if (!allowedToolNames || allowedToolNames.length === 0) {
    return tools;
  }

  const allowed = new Set(allowedToolNames);
  return tools.filter((tool) => allowed.has(tool.name));
}

export function buildOpenAITools(
  tools: ToolDefinition[]
): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map((tool) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [paramName, paramDef] of Object.entries(tool.parameters)) {
      const prop: Record<string, unknown> = {
        type: paramDef.type,
        description: paramDef.description
      };
      if (paramDef.enum) {
        prop.enum = paramDef.enum;
      }
      if (paramDef.properties) {
        const nested: Record<string, unknown> = {};
        for (const [nk, nv] of Object.entries(paramDef.properties)) {
          nested[nk] = { type: nv.type, description: nv.description };
        }
        prop.properties = nested;
      }
      if (paramDef.items) {
        prop.items = { type: paramDef.items.type, description: paramDef.items.description };
      }
      properties[paramName] = prop;
      if (paramDef.required) {
        required.push(paramName);
      }
    }

    return {
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties,
          ...(required.length > 0 ? { required } : {})
        }
      }
    };
  });
}

type ResolvedKey = {
  apiKey: string;
  id: string;
  name: string;
};

// ---------------------------------------------------------------------------
// Provider-specific request-body extras.
//
// Some OpenAI-compatible providers need extra fields on top of the standard
// `model` / `messages` / `tools` shape to behave correctly for agentic
// tasks. The most impactful case is MiniMax:
//
//   - `thinking: { type: "adaptive" }` — explicitly enables adaptive
//     reasoning on MiniMax-M3. Default is also adaptive, but being
//     explicit removes ambiguity for the model and keeps the request
//     shape self-describing.
//
//   - `reasoning_split: true` — this is the critical fix. When enabled,
//     MiniMax-M3 emits reasoning content in dedicated `reasoning_content`
//     and `reasoning_details` fields instead of embedding `<think>…</think>`
//     blocks inside the regular `content` field. Without this flag the
//     agent's stream parser has to fall back to regex-stripping the
//     embedded tags, which is brittle and caused the "duplicate thinking"
//     issue observed in the .dbg logs (the same reasoning was being
//     extracted twice — once as embedded content, once via the fallback
//     stripper).
//
//   - `top_p: 0.95` (M3) / `0.9` (M2.x) — matches the documented defaults
//     for each model family so behavior is stable regardless of provider
//     side changes.
//
//   - `max_completion_tokens` — per the docs the recommended values are
//     131072 for M3 (max 524288) and 65536 for M2.x (max 204800). Without
//     an explicit value, the provider-side default can be too low and
//     tool-call arguments get truncated mid-stream, which then fails the
//     JSON parser in `response-parser.ts`.
//
//   - `temperature: 1` — matches the documented default.
//
// The `name: "MiniMax AI"` field MiniMax returns on assistant messages is
// also a known quirk; the `buildProviderMessages` step in
// `prompt-builder.ts` already strips it from outgoing assistant turns by
// not propagating the name.
//
// IMPORTANT: these extras are DISABLED by default. Some MiniMax deployments
// reject the request with HTTP 400 "invalid params" when any of these
// fields are present, even though the platform docs list them as valid.
// The safe path is to send the bare OpenAI-compatible request first and
// only opt-in to the extras once the basic request is confirmed working.
// Enable with the env var `MINIMAX_ENABLE_EXTRAS=true` (or pass
// `extras: "all"` from the model selector UI in a future iteration).
// ---------------------------------------------------------------------------
// Read the env var at call time (not module load time) so tests can toggle
// it via `beforeEach` / `afterEach`. The helper itself is a pure function
// — reading an env var on each call is fine because it's just a property
// access on a process-global object, not a syscall.
function isMiniMaxExtrasEnabled(): boolean {
  return process.env.MINIMAX_ENABLE_EXTRAS === "true" || process.env.MINIMAX_ENABLE_EXTRAS === "1";
}

// Build the OpenAI-compatible chat-completions request body from the
// agent config, the message history, the OpenAI-formatted tools, and any
// provider-specific extras. Extracted from `streamChat` so the reactive
// provider-compat retry can rebuild the body with a different `extras`
// payload (specifically: an empty `extras` object to fall back to a
// minimal request on 400).
function buildChatCompletionsBody(
  config: AgentConfig,
  messages: ProviderChatMessage[],
  openAITools: ReturnType<typeof buildOpenAITools>,
  providerExtras: Record<string, unknown>
): Record<string, unknown> {
  return {
    model: config.model,
    messages,
    ...(openAITools.length > 0 ? { tools: openAITools } : {}),
    stream: true,
    ...(config.provider !== "huggingface" ? { stream_options: { include_usage: true } } : {}),
    // Reasoning / thinking-mode control. The user-facing setting
    // (`reasoningEffort` on AgentConfig) is normalized to
    // "off" | "low" | "medium" | "high" | "max" and translated by
    // `translateReasoning` into the right parameter shape for the
    // target provider:
    //   - OpenAI / DeepSeek / NVIDIA / Puter / custom: reasoning_effort
    //   - OpenRouter:                              reasoning: { effort }
    //   - Anthropic Claude 4.7+ / 5.x:            thinking: { adaptive } + effort
    //   - Anthropic Claude 3.7-4.5:               thinking: { enabled, budget_tokens }
    //   - Google Gemini:                           thinking_budget (integer)
    //   - Ollama:                                  think: true
    //   - MiniMax:                                 no-op (handled via
    //                                              buildProviderRequestExtras)
    // The provider is the actual control surface for "thinking too
    // much" — prompt text alone does not reduce CoT length.
    ...translateReasoning(config.provider, config.model, config.reasoningEffort as ReasoningSetting | undefined),
    ...providerExtras
  };
}

export function buildProviderRequestExtras(
  provider: string,
  model: string,
  maxCompletionTokensOverride?: number
): Record<string, unknown> {
  if (provider !== "minimax") return {};

  // The MiniMax-specific extras are opt-in (see `isMiniMaxExtrasEnabled`
  // above). Returning `{}` here means the agent sends a bare
  // OpenAI-compatible request — the same shape that works for every other
  // provider — which is the safest path when the deployment rejects
  // documented-but-flaky fields like `reasoning_split` or `thinking`.
  if (!isMiniMaxExtrasEnabled()) return {};

  // Match the model ID exactly (case-insensitive) and any future suffixes
  // (e.g. "-0305", "-highspeed"). The platform docs enumerate the model
  // IDs explicitly so this is a closed set, but we still allow loose
  // matching so that preview/snapshot model names like "MiniMax-M3-preview"
  // also get the M3 treatment.
  const isM3 = /^MiniMax-M3(-|$)/i.test(model) || /^MiniMax-M3[A-Za-z0-9._-]*$/i.test(model);
  const isM2Family = /^MiniMax-M2(\.\d+)?(-highspeed)?$/i.test(model);

  const extras: Record<string, unknown> = {
    // `temperature: 1` matches the documented default for all MiniMax
    // models. We set it explicitly so the model behaves deterministically
    // even if the provider changes its default in the future.
    temperature: 1
  };

  if (isM3) {
    // Adaptive thinking is the default but being explicit is safer.
    extras.thinking = { type: "adaptive" };
    // Split reasoning into its own field so the stream parser can read
    // it directly instead of regex-stripping embedded <think> blocks.
    extras.reasoning_split = true;
  }

  if (isM3) {
    extras.top_p = 0.95;
  } else if (isM2Family) {
    extras.top_p = 0.9;
  }

  // `max_completion_tokens` is the modern (non-deprecated) parameter. The
  // legacy `max_tokens` field is ignored by MiniMax when both are sent.
  const maxTokens = maxCompletionTokensOverride
    ?? (isM3 ? 131072 : isM2Family ? 65536 : undefined);
  if (maxTokens !== undefined) {
    extras.max_completion_tokens = maxTokens;
  }

  return extras;
}

// ---------------------------------------------------------------------------
// Format an upstream provider error into a human-readable sentence.
//
// Mirrors `_format_upstream_error` in the odysseus project
// (src/llm_core.py). The default code path just embeds the raw response
// text, which gets truncated in the UI and hides the real cause. Pulling
// the message out of the OpenAI-standard error envelope
// (`{"error":{"message":"..."}}`) gives the user the full diagnostic.
// ---------------------------------------------------------------------------
function formatUpstreamError(
  status: number,
  body: string,
  provider: string,
  model: string
): string {
  let detail = body;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const err = (parsed as { error?: { message?: string; detail?: string } }).error;
      if (err && typeof err === "object") {
        detail = (err.message || err.detail || body).trim();
      } else if (typeof (parsed as { message?: string }).message === "string") {
        detail = (parsed as { message: string }).message.trim();
      }
    }
  } catch {
    // Body wasn't JSON — keep the raw text.
  }

  // Trim very long messages so they don't blow up the UI, but keep enough
  // to be useful (most MiniMax error messages are < 200 chars).
  if (detail.length > 500) {
    detail = detail.slice(0, 500) + "…";
  }

  const label = provider || "provider";
  if (status === 401 || status === 403) {
    return `${label} rejected the API key (HTTP ${status}): ${detail}`;
  }
  if (status === 404) {
    return `${label} returned 404 (model "${model}" or endpoint not found): ${detail}`;
  }
  if (status === 429) {
    return `${label} rate-limited the request (HTTP 429): ${detail}`;
  }
  if (status >= 500) {
    return `${label} is having an outage (HTTP ${status}): ${detail}`;
  }
  return `${label} returned HTTP ${status}: ${detail}`;
}

function resolveKeysToTry(config: AgentConfig): ResolvedKey[] {
  const keys: ResolvedKey[] = [];

  if (config.apiKey && config.primaryApiKeyId) {
    keys.push({
      apiKey: config.apiKey,
      id: config.primaryApiKeyId,
      name: config.primaryApiKeyName ?? "Primary"
    });
  }

  if (config.fallbackApiKeys) {
    for (const k of config.fallbackApiKeys) {
      if (k.id === config.primaryApiKeyId) continue;
      try {
        if (!config.encryptionSecret) continue;
        const apiKey = decryptText(k.apiKeyEncrypted, config.encryptionSecret);
        keys.push({ apiKey, id: k.id, name: k.name });
      } catch {
        // Skip undecryptable keys
      }
    }
  }

  return keys;
}

function isFallbackEligible(response: Response, details: string): boolean {
  if (response.status === 401 || response.status === 402 || response.status === 403 || response.status === 429) {
    return true;
  }
  if (response.status === 400) {
    const lower = details.toLowerCase();
    return lower.includes("credits")
      || lower.includes("depleted")
      || lower.includes("insufficient balance")
      || lower.includes("quota")
      || lower.includes("limit reached")
      || lower.includes("payment required")
      || lower.includes("billing");
  }
  return false;
}

/**
 * Split a concatenated tool name like "list_directoryexecute_command" into
 * individual valid tool calls by greedily matching registered tool names.
 */
function splitConcatenatedToolName(
  concatenated: string,
  rawArguments: string,
  knownToolNames: string[]
): ToolCall[] {
  const sorted = [...knownToolNames].sort((a, b) => b.length - a.length);
  const foundNames: string[] = [];
  let remaining = concatenated;

  while (remaining.length > 0) {
    const match = sorted.find((name) => remaining.startsWith(name));
    if (!match) break;
    foundNames.push(match);
    remaining = remaining.slice(match.length);
  }

  if (remaining.length > 0 || foundNames.length < 2) {
    return [];
  }

  const splitArgs = splitConcatenatedJsonArgs(rawArguments, foundNames.length);

  return foundNames.map((name, i) => ({
    id: crypto.randomUUID(),
    name,
    parameters: splitArgs[i] ?? {}
  }));
}

/**
 * Split concatenated JSON objects like `{"path":"."} {"command":"ls"}` into
 * individual parsed objects.
 */
function splitConcatenatedJsonArgs(raw: string, expectedCount: number): Array<Record<string, unknown>> {
  if (!raw || !raw.trim()) return [];

  try {
    const single = JSON.parse(raw);
    if (typeof single === "object" && single !== null && !Array.isArray(single)) {
      return [single];
    }
  } catch {
    // not a single valid JSON
  }

  const results: Array<Record<string, unknown>> = [];
  const parts = raw.split(/\}\s*\{/);

  if (parts.length >= 2) {
    for (let i = 0; i < parts.length; i += 1) {
      let part = parts[i];
      if (i > 0) part = "{" + part;
      if (i < parts.length - 1) part = part + "}";
      try {
        const parsed = JSON.parse(part);
        if (typeof parsed === "object" && parsed !== null) {
          results.push(parsed);
        }
      } catch {
        results.push({});
      }
    }
  }

  return results;
}

export type LLMClientOptions = {
  config: AgentConfig;
  /**
   * Receives incremental token-usage deltas as the LLM streams them back.
   * The LLMClient never owns token usage; it just notifies the owner.
   */
  onTokenUsage?: (usage: AgentTokenUsage) => void;
  /**
   * Receives a notification whenever a fallback API key is promoted to active.
   * The owner should also update its primary key tracking and persist the
   * active key for future runs.
   */
  onApiKeySwitch?: (info: { providerSettingId?: string; newKeyId: string; newKeyName: string; newApiKey: string }) => Promise<void> | void;
};

export type LLMStreamEvent =
  | { type: "chunk"; reasoningDelta?: string; contentDelta?: string };

/**
 * Streams a chat completion from the configured provider, with automatic
 * failover across the primary + fallback API keys. Yields content/reasoning
 * deltas; returns the final assembled assistant message.
 */
export class LLMClient {
  private config: AgentConfig;
  private onTokenUsage?: (usage: AgentTokenUsage) => void;
  private onApiKeySwitch?: (info: { providerSettingId?: string; newKeyId: string; newKeyName: string; newApiKey: string }) => Promise<void> | void;
  private currentApiKey?: string;
  private currentApiKeyId?: string;
  private currentApiKeyName?: string;
  private switchInfo?: ApiKeySwitchInfo;

  constructor(options: LLMClientOptions) {
    this.config = options.config;
    this.onTokenUsage = options.onTokenUsage;
    this.onApiKeySwitch = options.onApiKeySwitch;
  }

  getApiKeySwitch(): ApiKeySwitchInfo | undefined {
    return this.switchInfo;
  }

  getCurrentKeyInfo(): { id?: string; name?: string; apiKey?: string } {
    return { id: this.currentApiKeyId, name: this.currentApiKeyName, apiKey: this.currentApiKey };
  }

  private markActiveKey(id: string, apiKey: string, name: string) {
    this.currentApiKey = apiKey;
    this.currentApiKeyId = id;
    this.currentApiKeyName = name;
  }

  async *streamChat(
    messages: ProviderChatMessage[],
    timeoutMs: number,
    openAITools: ReturnType<typeof buildOpenAITools>
  ): AsyncGenerator<LLMStreamEvent, AgentMessage, unknown> {
    const keysToTry = resolveKeysToTry(this.config);
    console.log(`[Auto-Switch] Total API keys available: ${keysToTry.length} (1 primary + ${keysToTry.length - 1} fallback)`);

    let lastError: Error | undefined;

    for (let ki = 0; ki < keysToTry.length; ki += 1) {
      const { apiKey, id, name } = keysToTry[ki];

      // Rate-limit retry loop: retry the same key up to 3 times on 429
      // with backoff from the retry-after header or exponential delay.
      const MAX_RATE_LIMIT_RETRIES = 3;
      let rateLimitAttempt = 0;
      let response: Response | undefined;

      while (rateLimitAttempt <= MAX_RATE_LIMIT_RETRIES) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const providerExtras = buildProviderRequestExtras(
            this.config.provider,
            this.config.model,
            this.config.maxCompletionTokens
          );
          const initialBody = buildChatCompletionsBody(this.config, messages, openAITools, providerExtras);
        // Debug logging: log the full request body (truncated) so the
        // user can see exactly what the agent is sending to any
        // provider. Activated by either:
        //   - `LLM_DEBUG=true` (works for any provider)
        //   - `MINIMAX_DEBUG=true` (kept for backward compat, minimax only)
        // The fastest way to diagnose "invalid params" / "no response"
        // errors without having to attach a network proxy.
        const debugEnabled =
          process.env.LLM_DEBUG === "true" ||
          (this.config.provider === "minimax" && process.env.MINIMAX_DEBUG === "true");
        if (debugEnabled) {
          const bodyStr = JSON.stringify(initialBody);
          const tag = this.config.provider === "minimax" ? "MINIMAX_DEBUG" : "LLM_DEBUG";
          console.log(`[${tag}] Request to ${this.config.baseUrl}/chat/completions`);
          console.log(`[${tag}] Body (${bodyStr.length} chars): ${bodyStr.slice(0, 2000)}${bodyStr.length > 2000 ? "…" : ""}`);
        }
        response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(initialBody),
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof Error && error.name === "AbortError") {
          lastError = new Error(`LLM call timed out after ${timeoutMs}ms`);
          const hasMoreKeys = ki < keysToTry.length - 1;
          console.log(`[Auto-Switch] API key ${id} timed out after ${timeoutMs}ms`);
          console.log(`[Auto-Switch] Timeout fallback eligible: ${hasMoreKeys} (${ki + 1}/${keysToTry.length})`);
          if (hasMoreKeys) {
            console.log("[Auto-Switch] Trying next API key after timeout...");
            continue;
          }
          throw lastError;
        }
        throw error;
      }
      clearTimeout(timeout);

      // -----------------------------------------------------------------
      // Rate-limit retry (429). Instead of immediately failing or switching
      // keys, wait and retry the same key. Respects the retry-after header
      // when present, otherwise uses exponential backoff (2s, 4s, 8s).
      // -----------------------------------------------------------------
      if (response.status === 429 && rateLimitAttempt < MAX_RATE_LIMIT_RETRIES) {
        rateLimitAttempt += 1;
        const retryAfter = response.headers.get("retry-after");
        const delayMs = retryAfter
          ? Math.min(parseInt(retryAfter, 10) * 1000, 60_000)
          : Math.min(2000 * Math.pow(2, rateLimitAttempt - 1), 30_000);
        console.log(`[Auto-Switch] API key ${id} rate-limited (429). Retry ${rateLimitAttempt}/${MAX_RATE_LIMIT_RETRIES} in ${delayMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue; // retry the same key
      }
      // If we got here, either the response is OK, or it's a non-429 error,
      // or we exhausted rate-limit retries. Break out of the retry loop.
      break;
      } // end while (rate-limit retry loop)

      if (!response) {
        throw lastError ?? new Error("LLM call failed: no response");
      }

      // -----------------------------------------------------------------
      // Reactive provider-compat retry.
      //
      // Some OpenAI-compatible providers (notably MiniMax on certain
      // deployments) reject requests that include `stream_options` or the
      // MiniMax-specific extras (`reasoning_split`, `thinking`,
      // `max_completion_tokens`, `temperature`, `top_p`) with a 400
      // "invalid params" error — even though the platform docs list these
      // as valid request-body fields.
      //
      // Rather than guess which parameter is the culprit, we try the full
      // request first (best behavior: proper reasoning, higher token
      // limits) and fall back to a minimal request on 400 by stripping
      // the optional fields. This mirrors the retry pattern already used
      // in routes/chat.ts.
      // -----------------------------------------------------------------
      if (!response.ok && response.status === 400) {
        const statusText = response.statusText;
        const errorBody = await response.text().catch(() => statusText);
        console.warn(
          `[Provider-Compat] ${this.config.provider}/${this.config.model} returned 400; retrying without stream_options and MiniMax extras. Error: ${errorBody.slice(0, 500)}`
        );

        // Second attempt: same body but without `stream_options` and
        // without the MiniMax-specific extras. If THIS works, we know one
        // of those fields is the culprit and the agent can still operate
        // (just without the extra polish — reasoning stays in the content
        // field and we fall back to the embedded-thinking stripper).
        const retryBody = buildChatCompletionsBody(this.config, messages, openAITools, {});
        delete (retryBody as Record<string, unknown>).stream_options;

        const retryController = new AbortController();
        const retryTimeout = setTimeout(() => retryController.abort(), timeoutMs);
        try {
          response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify(retryBody),
            signal: retryController.signal
          });
        } catch (retryError) {
          clearTimeout(retryTimeout);
          // If the retry also fails, fall through to the original
          // error-handling path below which records `details` and decides
          // whether to fall back to the next API key.
          response = new Response(JSON.stringify({ error: { message: retryError instanceof Error ? retryError.message : "Retry failed" } }), { status: 502 });
        }
        clearTimeout(retryTimeout);
      }

      if (response.ok) {
        if (id !== (this.config.primaryApiKeyId ?? "primary")) {
          this.switchInfo = {
            fromKeyName: this.switchInfo?.fromKeyName ?? this.config.primaryApiKeyName ?? "Active key",
            toKeyName: name
          };
          this.markActiveKey(id, apiKey, name);
          await this.onApiKeySwitch?.({
            providerSettingId: this.config.providerSettingId,
            newKeyId: id,
            newKeyName: name,
            newApiKey: apiKey
          });
          console.log(`[Auto-Switch] Successfully switched to API key: ${name} (${id})`);
        } else {
          this.markActiveKey(id, apiKey, name);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No stream body from provider");
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let finalContent = "";
        let finalReasoning = "";
        const nativeToolCallsMap = new Map<number, { id?: string; name: string; arguments: string; thoughtSignature?: string }>();
        let streamDone = false;

        while (!streamDone) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          let lineEnd = buffer.indexOf("\n");
          while (lineEnd !== -1) {
            const rawLine = buffer.slice(0, lineEnd).trim();
            buffer = buffer.slice(lineEnd + 1);

            if (rawLine.startsWith("data:")) {
              const dataStr = rawLine.slice(5).trim();
              if (dataStr === "[DONE]") {
                streamDone = true;
                break;
              }

              try {
                const parsedChunk = JSON.parse(dataStr) as {
                  choices?: Array<{
                    delta?: {
                      content?: string;
                      reasoning_content?: string;
                      reasoningContent?: string;
                      reasoning?: string;
                      tool_calls?: Array<{
                        index: number;
                        id?: string;
                        type?: "function";
                        function?: {
                          name?: string;
                          arguments?: string;
                        };
                        /** Gemini thinking models include thought_signature on function calls. */
                        thought_signature?: string;
                      }>;
                    };
                  }>;
                  usage?: ProviderTokenUsage | null;
                };

                const usage = normalizeTokenUsage(parsedChunk.usage);
                if (usage) {
                  this.onTokenUsage?.(usage);
                }

                const deltaObj = parsedChunk.choices?.[0]?.delta;

                if (deltaObj?.tool_calls && Array.isArray(deltaObj.tool_calls)) {
                  for (let i = 0; i < deltaObj.tool_calls.length; i += 1) {
                    const tc = deltaObj.tool_calls[i];

                    let tcIndex = tc.index;
                    if (tcIndex === undefined) {
                      if (tc.id) {
                        let found = -1;
                        for (const [idx, existing] of nativeToolCallsMap.entries()) {
                          if (existing.id === tc.id) {
                            found = idx;
                            break;
                          }
                        }
                        tcIndex = found !== -1 ? found : nativeToolCallsMap.size;
                      } else {
                        let baseIndex = Math.max(0, nativeToolCallsMap.size - 1);
                        const current = nativeToolCallsMap.get(baseIndex + i);
                        if (current && tc.function?.name) {
                          const hasArgs = current.arguments.length > 0;
                          const hasCompleteName = toolRegistry.has(current.name);
                          if (hasArgs || hasCompleteName) {
                            baseIndex = nativeToolCallsMap.size;
                          }
                        }
                        tcIndex = baseIndex + i;
                      }
                    }

                    if (!nativeToolCallsMap.has(tcIndex)) {
                      nativeToolCallsMap.set(tcIndex, { name: "", arguments: "" });
                    }
                    const existing = nativeToolCallsMap.get(tcIndex)!;
                    if (tc.id) existing.id = tc.id;
                    if (tc.function?.name) existing.name += tc.function.name;
                    if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                    if (tc.thought_signature) existing.thoughtSignature = tc.thought_signature;
                  }
                }

                const contentDelta = deltaObj?.content ?? "";
                const reasoningDelta = extractReasoningDelta(
                  deltaObj?.reasoning_content,
                  deltaObj?.reasoningContent,
                  deltaObj?.reasoning
                ) ?? "";

                if (contentDelta || reasoningDelta) {
                  finalContent += contentDelta;
                  finalReasoning += reasoningDelta;
                  yield { type: "chunk", contentDelta, reasoningDelta };
                }
              } catch {
                // Ignore parse errors on partial chunks
              }
            }
            lineEnd = buffer.indexOf("\n");
          }
        }

        const finalToolCalls: ToolCall[] = [];
        const allToolNames = toolRegistry.list().map((t) => t.name);

        for (const tc of nativeToolCallsMap.values()) {
          if (!tc.name) continue;

          if (toolRegistry.has(tc.name)) {
            let parameters = {};
            try {
              if (tc.arguments) {
                parameters = JSON.parse(tc.arguments);
              }
            } catch (e) {
              console.warn(`[Native Tool] Failed to parse arguments for ${tc.name}:`, tc.arguments);
            }
            finalToolCalls.push({
              id: tc.id || crypto.randomUUID(),
              name: tc.name,
              parameters,
              ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {})
            });
          } else {
            const splitCalls = splitConcatenatedToolName(tc.name, tc.arguments, allToolNames);
            if (splitCalls.length > 0) {
              console.warn(
                `[Native Tool] Split concatenated tool name "${tc.name}" into ${splitCalls.length} calls: ${splitCalls.map((c) => c.name).join(", ")}`
              );
              finalToolCalls.push(...splitCalls);
            } else {
              let parameters = {};
              try {
                if (tc.arguments) parameters = JSON.parse(tc.arguments);
              } catch {
                /* ignore */
              }
              finalToolCalls.push({
                id: tc.id || crypto.randomUUID(),
                name: tc.name,
                parameters
              });
            }
          }
        }

        return {
          role: "assistant",
          content: finalContent,
          reasoning: finalReasoning || undefined,
          toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined
        };
      }

      const details = await response.text().catch(() => response.statusText);
      // Format the upstream error into a human-readable sentence so the UI
      // doesn't show the raw (truncated) JSON envelope. This mirrors the
      // `_format_upstream_error` pattern from the odysseus project.
      const formattedError = formatUpstreamError(
        response.status,
        details || response.statusText,
        this.config.provider,
        this.config.model
      );
      lastError = new Error(formattedError);

      const fallbackEligible = isFallbackEligible(response, details);
      const hasMoreKeys = ki < keysToTry.length - 1;

      console.log(`[Auto-Switch] API key ${id} failed with status ${response.status}`);
      console.log(`[Auto-Switch] Formatted error: ${formattedError}`);
      console.log(`[Auto-Switch] Raw body (first 200 chars): ${details.slice(0, 200)}`);
      console.log(`[Auto-Switch] Fallback eligible: ${fallbackEligible}, Has more keys: ${hasMoreKeys} (${ki + 1}/${keysToTry.length})`);

      if (!fallbackEligible || !hasMoreKeys) {
        throw lastError;
      }
      console.log(`[Auto-Switch] Trying next API key...`);
    }

    console.log(`[Auto-Switch] ❌ All ${keysToTry.length} API keys exhausted!`);
    throw lastError ?? new Error("LLM call failed: no keys available");
  }

  /**
   * Try to call the LLM; on timeout, retry once with a compacted history and
   * a shorter per-call timeout. Returns a generator that yields deltas and
   * the final assistant message.
   */
  async *streamWithRetry(
    messages: ProviderChatMessage[],
    compactMessages: () => ProviderChatMessage[],
    timeoutMs: number,
    openAITools: ReturnType<typeof buildOpenAITools>
  ): AsyncGenerator<LLMStreamEvent, AgentMessage, unknown> {
    try {
      return yield* this.streamChat(messages, timeoutMs, openAITools);
    } catch (error) {
      const isTimeout = error instanceof Error && error.message.startsWith("LLM call timed out after");
      if (!isTimeout) throw error;
      return yield* this.streamChat(compactMessages(), RETRY_LLM_TIMEOUT_MS, openAITools);
    }
  }

  /**
   * Non-streaming LLM call for internal operations like context compaction.
   * Uses the first available API key with a short timeout.
   */
  async callNonStreaming(
    messages: Array<{ role: string; content: string }>,
    purpose: string,
    timeoutMs = 30_000
  ): Promise<string> {
    const keysToTry = resolveKeysToTry(this.config);
    if (keysToTry.length === 0) throw new Error("No API keys available for compaction");

    const { apiKey } = keysToTry[0];
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: false,
          max_tokens: 2000
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Compaction call failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timeout);
    }
  }
}
