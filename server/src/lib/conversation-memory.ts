import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import type { AgentStep } from "./agent.js";

const RECENT_MESSAGE_LIMIT = 12;
const RECENT_CHAR_BUDGET = 18000;
const SUMMARY_INPUT_CHAR_BUDGET = 16000;
const SUMMARY_OUTPUT_CHAR_BUDGET = 4000;
const MESSAGE_MEMORY_CHAR_LIMIT = 12000;
const ATTACHMENT_TEXT_CHAR_LIMIT = 6000;
const TOOL_OUTPUT_CHAR_LIMIT = 1200;

export type PersistedMessageMode = "chat" | "agent" | "plan";

export type PersistedAttachmentMemory = {
  id: string;
  kind: "image" | "file";
  name: string;
  mimeType: string;
  textContent?: string;
};

export type ConversationReplayMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type SerializedAgentStep = {
  iteration: number;
  reasoning?: string;
  toolCalls: Array<{ id: string; name: string; parameters: Record<string, unknown> }>;
  toolResults: Array<{ success: boolean; error?: string; output?: string; data?: Prisma.InputJsonValue | null }>;
  response?: string;
  timestamp: string;
};

export type PersistedTokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type PersistedMessageMetadata = {
  attachments?: PersistedAttachmentMemory[];
  steps?: SerializedAgentStep[];
  iterations?: number;
  tokenUsage?: PersistedTokenUsage;
  elapsedMs?: number;
  agentRunId?: string;
  agentStoreVersion?: number;
  interactive?: (
    {
      type: "ask_user";
      questions: Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description?: string; preview?: string }>;
        multiSelect: boolean;
      }>;
    }
    | {
        type: "mode_switch";
        suggestedMode: "agent" | "plan";
        prompt: string;
        approveLabel?: string;
        cancelLabel?: string;
      }
  );
};


type ReplayRecord = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type LoadedConversationMemory = {
  summary: string | null;
  recentMessages: ConversationReplayMessage[];
};

function truncateText(value: string, limit: number) {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(0, limit - 1))}…`;
}

function sanitizeJsonValue(value: unknown, depth = 0): Prisma.InputJsonValue | null {
  if (value == null) return null;
  if (typeof value === "string") return truncateText(value, TOOL_OUTPUT_CHAR_LIMIT);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 8) return typeof value === "object" ? "[truncated]" : String(value);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeJsonValue(item, depth + 1)) as Prisma.InputJsonArray;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 25);
    return Object.fromEntries(entries.map(([key, item]) => [key, sanitizeJsonValue(item, depth + 1)])) as Prisma.InputJsonObject;
  }
  return String(value);
}

function formatAttachmentMemory(attachments: PersistedAttachmentMemory[] = []) {
  if (attachments.length === 0) return "";
  return attachments.map((attachment) => {
    const body = attachment.textContent
      ? `\n${truncateText(attachment.textContent, ATTACHMENT_TEXT_CHAR_LIMIT)}`
      : `\nNo extracted text was available.`;
    return `Attachment: ${attachment.name} (${attachment.mimeType})${body}`;
  }).join("\n\n");
}

function summarizeResultData(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const details: string[] = [];

  if (typeof record.path === "string") details.push(`path ${record.path}`);
  if (typeof record.command === "string") details.push(`command ${truncateText(record.command, 80)}`);
  if (typeof record.sessionId === "string") details.push(`session ${record.sessionId}`);
  if (typeof record.matchStrategy === "string") details.push(`match ${record.matchStrategy}`);

  if (record.lineRange && typeof record.lineRange === "object") {
    const lineRange = record.lineRange as { start?: unknown; end?: unknown };
    if (typeof lineRange.start === "number") {
      details.push(typeof lineRange.end === "number" && lineRange.end !== lineRange.start
        ? `lines ${lineRange.start}-${lineRange.end}`
        : `line ${lineRange.start}`);
    }
  }

  if (Array.isArray(record.tasks)) {
    details.push(`${record.tasks.length} tasks updated`);
  }

  return details.length > 0 ? details.join(", ") : undefined;
}

export function buildUserMemoryText(prompt: string, attachments: PersistedAttachmentMemory[] = []) {
  const sections = [truncateText(prompt, MESSAGE_MEMORY_CHAR_LIMIT)];
  const attachmentSection = formatAttachmentMemory(attachments);
  if (attachmentSection) sections.push(attachmentSection);
  return sections.join("\n\n");
}

export function serializeAgentSteps(steps: AgentStep[]): SerializedAgentStep[] {
  return steps.map((step) => ({
    iteration: step.iteration,
    reasoning: step.reasoning,
    toolCalls: step.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      parameters: (sanitizeJsonValue(call.parameters) as Record<string, unknown> | null) ?? {}
    })),
    toolResults: step.toolResults.map((result) => ({
      success: result.success,
      error: result.error ? truncateText(result.error, TOOL_OUTPUT_CHAR_LIMIT) : undefined,
      output: result.output ? truncateText(result.output, TOOL_OUTPUT_CHAR_LIMIT) : undefined,
      data: sanitizeJsonValue(result.data)
    })),
    response: step.response ? truncateText(step.response, TOOL_OUTPUT_CHAR_LIMIT) : undefined,
    timestamp: step.timestamp instanceof Date ? step.timestamp.toISOString() : new Date(step.timestamp).toISOString()
  }));
}

export function buildAssistantMemoryText(
  content: string,
  options?: { mode?: PersistedMessageMode; steps?: AgentStep[] | SerializedAgentStep[] }
) {
  const base = truncateText(content, MESSAGE_MEMORY_CHAR_LIMIT);
  if (options?.mode !== "agent" || !options.steps || options.steps.length === 0) {
    return base;
  }

  const lines = options.steps.flatMap((step) => {
    const toolCalls = step.toolCalls.map((call, index) => {
      const result = step.toolResults[index];
      const summary = summarizeResultData(result?.data);
      const status = result?.success ? "success" : result?.error ? `failed: ${truncateText(result.error, 120)}` : "completed";
      return `- ${call.name}: ${status}${summary ? ` (${summary})` : ""}`;
    });

    const chunks = [`Step ${step.iteration}${step.reasoning ? ` — ${truncateText(step.reasoning, 160)}` : ""}`];
    if (toolCalls.length > 0) chunks.push(...toolCalls);
    if (step.response) chunks.push(`- response: ${truncateText(step.response, 240)}`);
    return chunks;
  });

  const executionSection = lines.length > 0 ? `Agent execution context:\n${lines.join("\n")}` : "";
  return truncateText([base, executionSection].filter(Boolean).join("\n\n"), MESSAGE_MEMORY_CHAR_LIMIT);
}

export function serializeMessageMetadata(metadata: PersistedMessageMetadata): Prisma.InputJsonObject | undefined {
  const value = sanitizeJsonValue(metadata);
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }

  return value as Prisma.InputJsonObject;
}

function splitReplayWindow(records: ReplayRecord[]) {

  const recentMessages: ReplayRecord[] = [];
  let charCount = 0;
  let cursor = records.length - 1;

  while (cursor >= 0 && recentMessages.length < RECENT_MESSAGE_LIMIT) {
    const record = records[cursor];
    const cost = record.content.length + 16;
    if (recentMessages.length > 0 && charCount + cost > RECENT_CHAR_BUDGET) {
      break;
    }
    recentMessages.unshift(record);
    charCount += cost;
    cursor -= 1;
  }

  return {
    recentMessages,
    overflowMessages: records.slice(0, cursor + 1),
    overflowBoundaryId: cursor >= 0 ? records[cursor].id : null
  };
}

function formatReplayMessages(records: ReplayRecord[], limit: number) {
  let remaining = limit;
  const output: string[] = [];

  for (const record of records) {
    const label = record.role === "assistant" ? "Assistant" : "User";
    const block = `${label}:\n${record.content}`;
    if (output.length > 0 && remaining - block.length < 0) break;
    output.push(truncateText(block, remaining));
    remaining -= block.length;
  }

  return output.join("\n\n");
}


export async function loadConversationMemory(conversationId: string): Promise<LoadedConversationMemory> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      memorySummary: true,
      messages: {
        orderBy: { createdAt: "desc" },
        take: 32,
        select: { id: true, role: true, content: true, memoryText: true }
      }
    }
  });

  if (!conversation) {
    return { summary: null, recentMessages: [] };
  }

  const replayable = [...conversation.messages]
    .reverse()
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      id: message.id,
      role: message.role as "user" | "assistant",
      content: truncateText(message.memoryText?.trim() || message.content, MESSAGE_MEMORY_CHAR_LIMIT)
    }))
    .filter((message) => message.content.length > 0);

  return {
    summary: conversation.memorySummary?.trim() || null,
    recentMessages: splitReplayWindow(replayable).recentMessages.map((message) => ({
      role: message.role,
      content: message.content
    }))
  };
}

export function buildConversationMemoryMessage(memory: LoadedConversationMemory): ConversationReplayMessage | null {
  if (!memory.summary) return null;

  return {
    role: "system",
    content: [
      "Use the following persisted conversation summary when it is relevant to the current request.",
      `Conversation summary:\n${truncateText(memory.summary, SUMMARY_OUTPUT_CHAR_BUDGET)}`,
      "If the newest user message conflicts with older memory, prioritize the newest message."
    ].join("\n\n")
  };
}

export function buildAgentRulesMessage(rules: Array<{ name: string; content: string; scope: string }>): string {
  if (rules.length === 0) return "";

  const globalRules = rules.filter((r) => r.scope === "global");
  const workspaceRules = rules.filter((r) => r.scope === "workspace");
  const conversationRules = rules.filter((r) => r.scope === "conversation");

  const sections: string[] = [
    "The following agent rules have been configured. You MUST follow these rules when they are relevant to the current task. These rules override any conflicting default behavior."
  ];

  if (globalRules.length > 0) {
    sections.push("Global rules (apply everywhere):\n" + globalRules.map((r) => `- ${r.name}: ${r.content}`).join("\n"));
  }

  if (workspaceRules.length > 0) {
    sections.push("Workspace rules (apply in this workspace):\n" + workspaceRules.map((r) => `- ${r.name}: ${r.content}`).join("\n"));
  }

  if (conversationRules.length > 0) {
    sections.push("Conversation rules (apply in this conversation):\n" + conversationRules.map((r) => `- ${r.name}: ${r.content}`).join("\n"));
  }

  return sections.join("\n\n");
}


async function requestSummary(baseUrl: string, apiKey: string, model: string, prompt: string) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "Condense older conversation context into a compact factual memory. Keep important user goals, constraints, decisions, attachment findings, and agent/tool outcomes. Return plain text only."
        },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!response.ok) {
    const details = await response.text().catch(() => response.statusText);
    throw new Error(`Conversation memory refresh failed: ${details || response.statusText}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return truncateText(data.choices?.[0]?.message?.content ?? "", SUMMARY_OUTPUT_CHAR_BUDGET);
}

export async function refreshConversationSummary(params: { conversationId: string; baseUrl: string; apiKey: string; model: string }) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: params.conversationId },
    select: {
      memorySummary: true,
      memorySummaryMessageId: true,
      messages: {
        orderBy: { createdAt: "asc" },
        select: { id: true, role: true, content: true, memoryText: true }
      }
    }
  });

  if (!conversation) return;

  const replayable = conversation.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      id: message.id,
      role: message.role as "user" | "assistant",
      content: truncateText(message.memoryText?.trim() || message.content, MESSAGE_MEMORY_CHAR_LIMIT)
    }))
    .filter((message) => message.content.length > 0);

  const window = splitReplayWindow(replayable);
  if (!window.overflowBoundaryId) {
    if (conversation.memorySummary || conversation.memorySummaryMessageId) {
      await prisma.conversation.update({
        where: { id: params.conversationId },
        data: { memorySummary: null, memorySummaryUpdatedAt: new Date(), memorySummaryMessageId: null }
      });
    }
    return;
  }

  if (conversation.memorySummary && conversation.memorySummaryMessageId === window.overflowBoundaryId) {
    return;
  }

  const priorIndex = conversation.memorySummaryMessageId
    ? window.overflowMessages.findIndex((message) => message.id === conversation.memorySummaryMessageId)
    : -1;
  const deltaMessages = priorIndex >= 0 ? window.overflowMessages.slice(priorIndex + 1) : window.overflowMessages;
  const overflowTranscript = formatReplayMessages(deltaMessages.length > 0 ? deltaMessages : window.overflowMessages, SUMMARY_INPUT_CHAR_BUDGET);
  if (!overflowTranscript) return;

  const prompt = conversation.memorySummary && priorIndex >= 0
    ? `Previous rolling summary:\n${conversation.memorySummary}\n\nNew overflow turns to merge:\n${overflowTranscript}`
    : `Summarize these older conversation turns into durable memory:\n${overflowTranscript}`;

  const nextSummary = await requestSummary(params.baseUrl, params.apiKey, params.model, prompt);
  if (!nextSummary) return;

  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: {
      memorySummary: nextSummary,
      memorySummaryUpdatedAt: new Date(),
      memorySummaryMessageId: window.overflowBoundaryId
    }
  });
}
