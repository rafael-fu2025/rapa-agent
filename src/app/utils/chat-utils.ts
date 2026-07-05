import type { ChatMessage, ChatMode } from "../types/chat";
import type { ConversationMessage, TokenUsage } from "../../lib/api";
import type { AgentStep } from "../../lib/agent-api";

export const estimateTokens = (text: string) => {
  const normalized = text.trim();
  if (!normalized) return 0;
  return Math.max(1, Math.round(normalized.length / 4));
};

function pickTokenNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function extractTokenUsage(metadata: ConversationMessage["metadata"]): TokenUsage | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const tokenUsage = (metadata as { tokenUsage?: unknown }).tokenUsage;
  if (!tokenUsage || typeof tokenUsage !== "object" || Array.isArray(tokenUsage)) return undefined;

  const promptTokens = pickTokenNumber((tokenUsage as TokenUsage).promptTokens);
  const completionTokens = pickTokenNumber((tokenUsage as TokenUsage).completionTokens);
  const totalTokens = pickTokenNumber((tokenUsage as TokenUsage).totalTokens) ?? (
    promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined
  );

  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined;
  return { promptTokens, completionTokens, totalTokens };
}

export function getRealOrEstimatedTokenCount(content: string, tokenUsage?: TokenUsage) {
  return tokenUsage?.totalTokens ?? tokenUsage?.completionTokens ?? estimateTokens(content);
}

export function normalizeChatMode(mode: ConversationMessage["mode"]): ChatMode | undefined {
  return mode === "chat" || mode === "agent" || mode === "plan" ? mode : undefined;
}

export function extractAgentSteps(metadata: ConversationMessage["metadata"]): AgentStep[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const steps = (metadata as { steps?: unknown }).steps;
  return Array.isArray(steps) ? steps as AgentStep[] : [];
}

export function extractAgentRunId(metadata: ConversationMessage["metadata"]): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const agentRunId = (metadata as { agentRunId?: unknown }).agentRunId;
  return typeof agentRunId === "string" && agentRunId.trim() ? agentRunId : undefined;
}

export function extractElapsedMs(metadata: ConversationMessage["metadata"]): number | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const elapsedMs = (metadata as { elapsedMs?: unknown }).elapsedMs;
  return typeof elapsedMs === "number" && elapsedMs > 0 ? elapsedMs : undefined;
}

export function extractInteractivePayload(metadata: ConversationMessage["metadata"]): ChatMessage["interactive"] | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const interactive = (metadata as { interactive?: unknown }).interactive;
  if (!interactive || typeof interactive !== "object" || Array.isArray(interactive)) return undefined;

  const payload = interactive as Record<string, unknown>;
  if (payload.type === "ask_user") {
    const rawQuestions = Array.isArray(payload.questions) ? payload.questions : [];
    const questions = rawQuestions
      .map((raw, index) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const record = raw as Record<string, unknown>;
        const question = typeof record.question === "string" ? record.question.trim() : "";
        if (!question) return null;
        const headerRaw = typeof record.header === "string" ? record.header.trim() : "";
        const header = (headerRaw || `Q${index + 1}`).slice(0, 12);
        const rawOptions = Array.isArray(record.options)
          ? record.options
          : record.options && typeof record.options === "object"
            ? (["items", "item", "choices", "choice", "values", "value", "options", "option", "list", "entries", "rows"]
                .map((key) => (record.options as Record<string, unknown>)[key])
                .find((candidate): candidate is unknown[] => Array.isArray(candidate)) ?? [])
            : [];
        const options = rawOptions
          .map((option) => {
            if (typeof option === "string") {
              return option.trim() ? { label: option.trim() } : null;
            }
            if (Array.isArray(option)) {
              const first = option[0];
              if (typeof first === "string") return first.trim() ? { label: first.trim() } : null;
              if (first && typeof first === "object" && !Array.isArray(first)) {
                option = first as Record<string, unknown>;
              } else {
                return null;
              }
            }
            if (!option || typeof option !== "object" || Array.isArray(option)) return null;
            const optRecord = option as Record<string, unknown>;
            const labelRaw = optRecord.label ?? optRecord.title ?? optRecord.text ?? optRecord.value ?? optRecord.name ?? optRecord.heading ?? optRecord.option ?? optRecord.choice;
            const label = typeof labelRaw === "string" ? labelRaw.trim() : "";
            if (!label) return null;
            const descriptionRaw = optRecord.description ?? optRecord.details ?? optRecord.helperText ?? optRecord.subtitle ?? optRecord.summary;
            const description = typeof descriptionRaw === "string" && descriptionRaw.trim()
              ? descriptionRaw.trim()
              : undefined;
            const previewRaw = optRecord.preview ?? optRecord.snippet;
            const preview = typeof previewRaw === "string" && previewRaw.trim()
              ? previewRaw.trim()
              : undefined;
            const defaultOption = optRecord.defaultOption === true
              || optRecord.isDefault === true
              || optRecord.recommended === true
              || optRecord.default === true;
            return {
              label,
              ...(description ? { description } : {}),
              ...(preview ? { preview } : {}),
              ...(defaultOption ? { defaultOption: true } : {})
            };
          })
          .filter((opt): opt is { label: string; description?: string; preview?: string; defaultOption?: boolean } => Boolean(opt));
        if (options.length < 2 || options.length > 4) return null;
        const multiSelect = typeof record.multiSelect === "boolean"
          ? record.multiSelect
          : typeof record.isMultiSelect === "boolean"
            ? record.isMultiSelect
            : false;
        return { question, header, options, multiSelect };
      })
      .filter((q): q is {
        question: string;
        header: string;
        options: { label: string; description?: string; preview?: string; defaultOption?: boolean }[];
        multiSelect: boolean;
      } => Boolean(q));
    if (questions.length === 0) return undefined;
    return { type: "ask_user", questions };
  }

  if (payload.type === "mode_switch") {
    const suggestedMode = payload.suggestedMode === "agent" || payload.suggestedMode === "plan"
      ? payload.suggestedMode
      : undefined;
    const prompt = typeof payload.prompt === "string" ? payload.prompt : undefined;
    if (!suggestedMode || !prompt?.trim()) return undefined;

    return {
      type: "mode_switch",
      suggestedMode,
      prompt,
      sourceConversationId: typeof payload.sourceConversationId === "string" ? payload.sourceConversationId : undefined,
      approveLabel: typeof payload.approveLabel === "string" ? payload.approveLabel : undefined,
      cancelLabel: typeof payload.cancelLabel === "string" ? payload.cancelLabel : undefined
    };
  }

  return undefined;
}

export function stringifyErrorDetails(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") return parsed;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return trimmed.replace(/\\n/g, "\n").replace(/\\"/g, "\"");
    }
  }

  if (value === undefined || value === null) return "";

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatErrorState(error: string): { summary: string; details?: string } {
  const trimmed = error.trim();
  if (!trimmed) {
    return { summary: "Something went wrong." };
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const summary = typeof parsed.message === "string" && parsed.message.trim()
      ? parsed.message.trim()
      : typeof parsed.error === "string" && parsed.error.trim()
        ? parsed.error.trim()
        : "Request failed";

    const detailSource = parsed.details ?? parsed.error ?? parsed;
    const details = stringifyErrorDetails(detailSource);
    return details && details !== summary ? { summary, details } : { summary };
  } catch {
    return { summary: trimmed };
  }
}

export function looksLikeChatModeRestriction(content: string) {
  const normalized = content.toLowerCase();
  const patterns = [
    /only available in agent mode/,
    /switch to agent mode/,
    /i am still operating in chat mode/,
    /i'm still operating in chat mode/,
    /you are in chat mode/,
    /important:\s+you are in chat mode/,
    /cannot access,\s*read,\s*write,\s*or modify any files/,
    /limited to text-based conversation only/
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

export function looksLikeWorkspaceRequest(prompt: string) {
  const normalized = prompt.toLowerCase();
  const patterns = [
    /\b(analyze|review|understand|inspect|scan|check|explore|examine|trace)\b[\s\S]{0,80}\b(codebase|repo|repository|workspace|project|files?|folders?|structure|architecture)\b/,
    /\b(read|open|search|find|locate|look at|check)\b[\s\S]{0,80}\b(file|folder|directory|package\.json|readme|src|component|module)\b/,
    /\b(edit|modify|change|update|fix|refactor|rewrite|patch|implement)\b[\s\S]{0,80}\b(code|file|project|component|module|workspace)\b/,
    /\b(run|execute|test|build|lint|debug)\b[\s\S]{0,80}\b(command|commands|terminal|npm|pnpm|yarn|project|workspace)\b/,
    /\b(codebase|repository|repo|workspace)\b/
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

/**
 * Maps raw DB conversation rows into frontend ChatMessage objects.
 */
export function mapConversationToMessages(rows: ConversationMessage[]): ChatMessage[] {
  return rows.map((row) => {
    const tokenUsage = row.role === "assistant" ? extractTokenUsage(row.metadata) : undefined;
    const elapsedMs = row.role === "assistant" ? extractElapsedMs(row.metadata) : undefined;

    return {
      id: row.id,
      conversationId: row.conversationId,
      role: row.role,
      content: row.content,
      model: row.model,
      provider: row.provider,
      mode: normalizeChatMode(row.mode),
      agentRunId: row.role === "assistant" && row.mode === "agent" ? extractAgentRunId(row.metadata) : undefined,
      agentSteps: row.role === "assistant" && row.mode === "agent" ? extractAgentSteps(row.metadata) : undefined,

      stats: row.role === "assistant"
        ? {
            tokensPerSec: 0,
            totalTokens: getRealOrEstimatedTokenCount(row.content, tokenUsage),
            elapsedMs
          }
        : undefined,
      interactive: extractInteractivePayload(row.metadata)
    };
  });
}
