// Shared types, constants, and pure utility helpers for the agent loop.

import { z } from "zod";
import type {
  AgentExecutionMode,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult
} from "../tools.js";

export type AgentTokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type ApiKeySwitchInfo = {
  fromKeyName: string;
  toKeyName: string;
};

export type ProviderTokenUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type ProviderAssistantMessage = {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  reasoningContent?: string | null;
};

export type ProviderChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  /**
   * Message content. `null` is valid and REQUIRED by some OpenAI-compatible
   * providers (MiniMax, GLM) on an assistant turn that carries `tool_calls`
   * but no prose — an empty string `""` is rejected with error 2013
   * "chat content is empty". The OpenAI convention is `content: null` next
   * to `tool_calls`.
   */
  content: string | Array<Record<string, unknown>> | null;
  /**
   * OpenAI native function-calling: present on an assistant message that
   * requested tool execution. Each entry carries the tool name and a JSON
   * string of arguments. Providers require this to be followed by one
   * `role: "tool"` message per call, linked by `tool_call_id`.
   */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    /** Gemini thinking models require thought_signature when replaying function calls. */
    thought_signature?: string;
  }>;
  /**
   * OpenAI native function-calling: present on a `role: "tool"` message,
   * linking it back to the assistant `tool_calls` entry it answers.
   */
  tool_call_id?: string;
  /** Optional tool/function name on a `role: "tool"` message. */
  name?: string;
};

export const DEFAULT_LLM_TIMEOUT_MS = 180000;
export const RETRY_LLM_TIMEOUT_MS = 90000;

// Budget constants. P2-C: read from env at module load so operators can
// tune them without rebuilding. Per-call overrides take precedence over
// these values (see AgentConfig.memoryBudget).
function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export const PROVIDER_MESSAGE_CHAR_LIMIT = readEnvInt("PROVIDER_MESSAGE_CHAR_LIMIT", 24_000);
export const COMPACT_PROVIDER_MESSAGE_CHAR_LIMIT = Math.floor(PROVIDER_MESSAGE_CHAR_LIMIT * 0.4);
export const TOOL_RESULT_STRING_CHAR_LIMIT = readEnvInt("TOOL_OUTPUT_MAX_CHARS", 10_000);
export const COMPACT_TOOL_RESULT_STRING_CHAR_LIMIT = Math.floor(TOOL_RESULT_STRING_CHAR_LIMIT * 0.25);

/**
 * Adaptive context budget — scales to 85% of the model's context window
 * instead of using a fixed budget. This matches the odysseus approach:
 * `context_length * 0.85`, capped at a hard max.
 *
 * Context windows are in tokens. We convert to chars at ~4 chars/token.
 */
const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  // MiniMax — M3 supports 1M tokens, M2.x family supports 204,800
  "minimax-m3": 1_000_000,
  "minimax-m2.7": 204_800,
  "minimax-m2.7-highspeed": 204_800,
  "minimax-m2.5": 204_800,
  "minimax-m2.5-highspeed": 204_800,
  "minimax-m2.1": 204_800,
  "minimax-m2.1-highspeed": 204_800,
  "minimax-m2": 204_800,
  // Gemini — 2.x/3.x family supports ~1M tokens
  "gemini-3.1-pro": 1_048_576,
  "gemini-3.1-flash": 1_048_576,
  "gemini-3-pro": 1_048_576,
  "gemini-3-flash": 1_048_576,
  "gemini-2.5-pro": 1_048_576,
  "gemini-2.5-flash": 1_048_576,
  "gemini-2.0-flash": 1_048_576,
  "gemini-2.0-flash-lite": 1_048_576,
  "gemini-1.5-pro": 2_097_152,
  "gemini-1.5-flash": 1_048_576,
  // Gemma
  "gemma-4": 131_072,
  "gemma-3": 131_072,
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4.1": 1_047_576,
  "gpt-4.1-mini": 1_047_576,
  "gpt-4.1-nano": 1_047_576,
  "gpt-5": 1_000_000,
  "o3": 200_000,
  "o4-mini": 200_000,
  // Anthropic
  "claude-opus-4": 1_000_000,
  "claude-sonnet-4": 1_000_000,
  "claude-3.5-sonnet": 200_000,
  "claude-3.5-haiku": 200_000,
  // DeepSeek — V3/V4 support 1M tokens
  "deepseek-v4": 1_000_000,
  "deepseek-v3": 131_072,
  "deepseek-r1": 131_072,
  "deepseek-chat": 131_072,
  "deepseek-reasoner": 131_072,
  // Moonshot / Kimi
  "kimi-k2.6": 262_144,
  "kimi-k2": 131_072,
  // Z.AI / GLM
  "glm-5": 131_072,
  "glm-4": 131_072,
  // Meta Llama
  "llama-4": 10_000_000,
  "llama-3.3": 131_072,
  "llama-3.1": 131_072,
  "llama-3.2": 131_072,
  // Qwen
  "qwen3": 131_072,
  "qwen2.5": 131_072,
  // Microsoft
  "phi4": 16_384,
  "phi-4": 16_384,
  // Mistral
  "mistral": 32_768,
  // NVIDIA Nemotron
  "nemotron": 131_072,
};

const DEFAULT_CONTEXT_TOKENS = 128_000;
const BUDGET_HEADROOM = 0.85;
const CHARS_PER_TOKEN = 4;
const HARD_MAX_CHARS = readEnvInt("PROVIDER_HISTORY_HARD_MAX_CHARS", 800_000);

/**
 * Compute an adaptive history character budget based on the model's context
 * window. Returns 85% of the context window in chars, capped at hard max.
 * Falls back to the env-configured value or 90K for unknown models.
 */
export function computeHistoryBudget(model: string): number {
  // Allow explicit override via env var
  const envBudget = readEnvInt("PROVIDER_HISTORY_CHAR_BUDGET", 0);
  if (envBudget > 0) return envBudget;

  // Look up model context window (case-insensitive, partial match)
  const modelLower = model.toLowerCase();
  let contextTokens = DEFAULT_CONTEXT_TOKENS;
  for (const [key, tokens] of Object.entries(MODEL_CONTEXT_TOKENS)) {
    if (modelLower.includes(key)) {
      contextTokens = tokens;
      break;
    }
  }

  const budgetChars = Math.floor(contextTokens * BUDGET_HEADROOM * CHARS_PER_TOKEN);
  return Math.min(budgetChars, HARD_MAX_CHARS);
}

export const PROVIDER_HISTORY_CHAR_BUDGET = readEnvInt("PROVIDER_HISTORY_CHAR_BUDGET", 90_000);
export const COMPACT_PROVIDER_HISTORY_CHAR_BUDGET = Math.floor(PROVIDER_HISTORY_CHAR_BUDGET * 0.5);

export type AgentMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<Record<string, unknown>>;
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
};

export type ToolCall = {
  id: string;
  name: string;
  parameters: Record<string, unknown>;
  /** Gemini thinking models return a thought_signature that must be replayed in history. */
  thoughtSignature?: string;
};

export type ToolApprovalRequest = {
  call: ToolCall;
  definition: ToolDefinition;
  conversationId: string;
  workspaceRoot: string;
};

export type ToolApprovalDecision = {
  approved: boolean;
  message?: string;
  autoApproved?: boolean;
  matchedPatternId?: string;
};

export type AgentConfig = {
  maxIterations: number;
  autoApproveTools: string[];
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  primaryApiKeyId?: string;
  primaryApiKeyName?: string;
  providerSettingId?: string;
  fallbackApiKeys?: Array<{ apiKeyEncrypted: string; id: string; name: string }>;
  encryptionSecret?: string;
  seedHistory?: AgentMessage[];
  requestToolApproval?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
  allowedToolNames?: string[];
  isNewConversation?: boolean;
  onApiKeySwitch?: (payload: { providerSettingId?: string; newKeyId: string }) => Promise<void> | void;
  /**
   * Per-call reasoning depth. Forwarded to providers that support it
   * via the per-provider translator in `reasoning-translator.ts`:
   *   - "off"    → don't add any reasoning parameter (provider default)
   *   - "low"    → light thinking, fastest + cheapest
   *   - "medium" → balanced (typical default for OpenAI o-series)
   *   - "high"   → deep thinking, slower, better for complex agentic work
   *   - "max"    → maximum effort (DeepSeek, Claude 4.7+ `max` maps to
   *                `high` because Anthropic only accepts low/medium/high)
   *
   * The translator turns this into the right field for the active
   * provider (`reasoning_effort` for OpenAI/DeepSeek/NVIDIA,
   * `thinking: { type: "adaptive" }` + `effort` for Claude 4.7+,
   * `thinking_budget` for Gemini, `think: true` for Ollama, etc.).
   * Undefined = let the provider default.
   */
  reasoningEffort?: "off" | "low" | "medium" | "high" | "max";
  /**
   * P2-C: Per-call memory budget overrides. When set, these values replace
   * the defaults in `prompt-builder.ts`. All four are scaled together — the
   * compact versions are typically ~25% of the regular versions to leave
   * room for an LLM-generated summary.
   */
  memoryBudget?: {
    /** Max characters per tool-result string before truncation. */
    toolResultCharLimit?: number;
    /** Max characters per provider message before truncation. */
    messageCharLimit?: number;
    /** Total budget for the history passed to the LLM. */
    historyCharBudget?: number;
  };
  /**
   * Per-call upper bound on tokens the LLM may generate. Forwarded as
   * `max_completion_tokens` (the modern non-deprecated parameter; the
   * legacy `max_tokens` field is ignored by MiniMax when both are sent).
   *
   * Provider-specific defaults are applied when this is unset:
   *   - MiniMax-M3:      131072 (recommended; max 524288)
   *   - MiniMax-M2.x:    65536  (recommended; max 204800)
   *   - Other providers: not forwarded
   *
   * Set this explicitly when running long agentic loops that emit many
   * tool calls and need extra headroom, or when using a model with a
   * known low provider-side default.
   */
  maxCompletionTokens?: number;
};

export type AgentStep = {
  iteration: number;
  reasoning?: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  response?: string;
  timestamp: Date;
};

export type ToolCallStatus = "pending" | "running" | "completed" | "failed" | "requires_approval";

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
  | {
      type: "tool_call";
      iteration: number;
      status: ToolCallStatus;
      call: ToolCall;
      result?: ToolResult;
    }
  | {
      type: "assistant";
      iteration: number;
      content: string;
      final: boolean;
      interactive?: AskUserPayload;
      completionStatus?: "success" | "partial" | "failed";
    }
  | {
      type: "step";
      step: AgentStep;
    }
  | {
      type: "done";
      status: "completed" | "max_iterations" | "failed" | "interrupted";
      response: string;
      steps: AgentStep[];
      iterations: number;
      tokenUsage?: AgentTokenUsage;
      agentRunId?: string;
      assistantMessageId?: string;
      apiKeySwitch?: ApiKeySwitchInfo;
      interactive?: AskUserPayload;
      /** Total wall-clock time for the entire agent run in milliseconds. */
      elapsedMs?: number;
      /** Rule-layer QA result (research Q1). Added to every done event. */
      qa?: {
        issues: Array<{
          rule: string;
          severity: "pass" | "warn" | "fail";
          message: string;
        }>;
        passed: boolean;
      };
    }
  | {
      type: "error";
      message: string;
      iteration?: number;
    };

export type ParsedAssistantResponse = {
  reasoning?: string;
  toolCalls: ToolCall[];
  responseText?: string;
  expectsToolUse?: boolean;
  needsContinuation?: boolean;
  parseError?: string;
  hasToolCallMarkup?: boolean;
  truncatedToolCalls?: { from: number; to: number; reason: string };
};

// ---------------------------------------------------------------------------
// Zod schemas for runtime validation of LLM-emitted data.
//
// P1-C from the audit: a misbehaving or compromised LLM can emit JSON in
// shapes the agent doesn't expect. The `parseAssistantResponse` function
// used to accept any JSON with a `toolCalls` field without validating the
// contents. These schemas tighten the contract.
//
// Schemas are deliberately permissive on `parameters` (we don't know the
// shape of every tool's input), but strict on the LLM-controlled envelope.
// ---------------------------------------------------------------------------

export const toolCallSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9_-]+$/, "tool name must be a snake_case identifier"),
  parameters: z
    .record(z.string().min(1).max(200), z.unknown())
    .default({})
});

/**
 * Maximum number of tool calls an LLM may emit in a single response.
 * 32 was too low for complex agent tasks (the LLM would emit a tool call
 * per file in a directory listing, easily exceeding 32). 128 is generous
 * while still preventing runaway responses. Override via
 * `AGENT_MAX_TOOL_CALLS_PER_ENVELOPE` env var.
 */
export const MAX_TOOL_CALLS_PER_ENVELOPE = (() => {
  const raw = process.env.AGENT_MAX_TOOL_CALLS_PER_ENVELOPE;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 128;
})();

export const parsedToolCallArraySchema = z
  .array(toolCallSchema)
  .max(MAX_TOOL_CALLS_PER_ENVELOPE);

export const toolCallEnvelopeSchema = z.object({
  reasoning: z.string().max(50_000).optional(),
  toolCalls: parsedToolCallArraySchema.default([])
});

export type ToolCallEnvelope = z.infer<typeof toolCallEnvelopeSchema>;

export type ToolCallParseResult =
  | { success: true; data: ToolCallEnvelope; truncated?: { from: number; to: number; reason: string } }
  | { success: false; issues: string };

export function safeParseToolCallEnvelope(raw: unknown): ToolCallParseResult {
  // 1. First, try the strict schema. If it passes, done.
  const strict = toolCallEnvelopeSchema.safeParse(raw);
  if (strict.success) return { success: true, data: strict.data };

  // 2. If the only failure is "too many tool calls", truncate to the cap
  //    and return success with a `truncated` flag. This way the run can
  //    continue instead of dying on a single over-eager model output.
  const issues = strict.error.issues;
  const lengthIssue = issues.find(
    (i) => i.code === "too_big" && i.path.join(".") === "toolCalls"
  );
  if (lengthIssue && typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const arr = obj.toolCalls;
    if (Array.isArray(arr) && arr.length > MAX_TOOL_CALLS_PER_ENVELOPE) {
      const truncatedArr = arr.slice(0, MAX_TOOL_CALLS_PER_ENVELOPE);
      const loose = toolCallEnvelopeSchema.safeParse({
        ...obj,
        toolCalls: truncatedArr
      });
      if (loose.success) {
        return {
          success: true,
          data: loose.data,
          truncated: {
            from: arr.length,
            to: truncatedArr.length,
            reason: `Model emitted ${arr.length} tool calls in a single response; truncated to ${MAX_TOOL_CALLS_PER_ENVELOPE}.`
          }
        };
      }
    }
  }

  // 3. Real validation failure — surface the issues.
  const issuesText = issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  return { success: false, issues: issuesText };
}

export type LLMStreamChunk =
  | { type: "chunk"; reasoningDelta?: string; contentDelta?: string }
  | { type: "done"; message: AgentMessage };

export function getConfiguredLlmTimeoutMs() {
  const configured = Number.parseInt(process.env.AGENT_LLM_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(configured) && configured >= 30000) {
    return configured;
  }
  return DEFAULT_LLM_TIMEOUT_MS;
}

export function normalizeTokenUsage(usage?: ProviderTokenUsage | null): AgentTokenUsage | undefined {
  if (!usage) return undefined;

  const promptTokens = usage.prompt_tokens ?? usage.promptTokens;
  const completionTokens = usage.completion_tokens ?? usage.completionTokens;
  const totalTokens = usage.total_tokens ?? usage.totalTokens ?? (
    typeof promptTokens === "number" && typeof completionTokens === "number" ? promptTokens + completionTokens : undefined
  );

  if (typeof promptTokens !== "number" && typeof completionTokens !== "number" && typeof totalTokens !== "number") {
    return undefined;
  }

  return {
    promptTokens: typeof promptTokens === "number" && Number.isFinite(promptTokens) ? promptTokens : undefined,
    completionTokens: typeof completionTokens === "number" && Number.isFinite(completionTokens) ? completionTokens : undefined,
    totalTokens: typeof totalTokens === "number" && Number.isFinite(totalTokens) ? totalTokens : undefined
  };
}

export function mergeTokenUsage(current: AgentTokenUsage, next?: AgentTokenUsage) {
  if (!next) return current;

  return {
    promptTokens: (current.promptTokens ?? 0) + (next.promptTokens ?? 0),
    completionTokens: (current.completionTokens ?? 0) + (next.completionTokens ?? 0),
    totalTokens: (current.totalTokens ?? 0) + (next.totalTokens ?? 0)
  };
}

export function truncateText(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}

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

export type AskUserPayload = {
  type: "ask_user";
  questions: AskUserQuestion[];
};

export type FinalizedAskUserTurn = {
  response: string;
  step: AgentStep;
  interactive?: AskUserPayload;
};

export { AgentExecutionMode, ToolDefinition, ToolExecutionContext, ToolResult };
