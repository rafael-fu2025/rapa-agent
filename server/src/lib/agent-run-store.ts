import type { Prisma } from "@prisma/client";

import type { AgentStep, AgentTokenUsage, ToolCall } from "./agent.js";
import type { ToolDefinition, ToolResult } from "./tools.js";
import {
  buildAssistantMemoryText,
  serializeAgentSteps,
  serializeMessageMetadata,
  type PersistedMessageMetadata
} from "./conversation-memory.js";
import { prisma } from "./db.js";
import { toolRegistry } from "../tools/index.js";

const PREVIEW_CHAR_LIMIT = 4000;
const CHECKPOINT_CONTENT_CHAR_LIMIT = 500000;
const JSON_STRING_CHAR_LIMIT = 12000;
const JSON_DEPTH_LIMIT = 5;

const JSON_ARRAY_LIMIT = 50;
const JSON_OBJECT_KEY_LIMIT = 60;

export type PersistAgentRunStatus = "completed" | "max_iterations" | "failed" | "interrupted";

export type PersistAgentRunParams = {
  conversationId: string;
  workspaceId: string;
  workspacePath: string;
  triggerMessageId?: string;
  provider: string;
  model: string;
  mode?: "agent" | "plan";
  prompt: string;
  content?: string;
  steps: AgentStep[];
  tokenUsage?: AgentTokenUsage;
  elapsedMs?: number;
  status?: PersistAgentRunStatus;
  errorMessage?: string;
  createAssistantMessage?: boolean;
  /// Per-run reasoning / thinking-mode depth. Persisted on the run
  /// record so the agent history view can show what effort was used
  /// and resume replays the same setting.
  reasoningEffort?: "off" | "low" | "medium" | "high" | "max";
};

function truncateText(value: string, limit = PREVIEW_CHAR_LIMIT) {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(0, limit - 1))}…`;
}

function truncateContent(value: string, limit = CHECKPOINT_CONTENT_CHAR_LIMIT) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}


function sanitizeJsonValue(value: unknown, depth = 0): Prisma.InputJsonValue | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return truncateText(value, JSON_STRING_CHAR_LIMIT);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (depth >= JSON_DEPTH_LIMIT) return typeof value === "object" ? "[truncated]" : String(value);

  if (Array.isArray(value)) {
    return value.slice(0, JSON_ARRAY_LIMIT).map((item) => sanitizeJsonValue(item, depth + 1) ?? null) as Prisma.InputJsonArray;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, JSON_OBJECT_KEY_LIMIT)
      .flatMap(([key, item]) => {
        const sanitized = sanitizeJsonValue(item, depth + 1);
        return sanitized === undefined ? [] : [[key, sanitized]];
      });
    return Object.fromEntries(entries) as Prisma.InputJsonObject;
  }

  return String(value);
}

function toInputJson(value: unknown): Prisma.InputJsonValue | undefined {
  const sanitized = sanitizeJsonValue(value);
  return sanitized === null || sanitized === undefined ? undefined : sanitized;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function getString(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getTextContent(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}


function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function summarizeResult(result?: ToolResult) {
  if (!result) return undefined;
  if (result.output) return truncateText(result.output);
  if (result.error) return truncateText(result.error);

  const serialized = safeStringify(result.data);
  return serialized ? truncateText(serialized) : undefined;
}

function buildResultData(result?: ToolResult) {
  if (!result) return undefined;
  return toInputJson({
    success: result.success,
    error: result.error,
    output: result.output,
    data: result.data
  });
}

function getToolDefinition(call: ToolCall): ToolDefinition | undefined {
  return toolRegistry.get(call.name)?.definition;
}

function getToolCallStatus(result?: ToolResult) {
  if (!result) return "pending";
  return result.success ? "completed" : "failed";
}

function isRejectedResult(result?: ToolResult) {
  const data = getRecord(result?.data);
  return data?.rejected === true;
}

function buildCheckpointPreview(data: Record<string, unknown> | undefined, call: ToolCall) {
  const diff = getRecord(data?.diff);
  const preview = getRecord(data?.preview);
  const before = getTextContent(diff, "before") ?? getTextContent(preview, "before");
  const after = getTextContent(diff, "after") ?? getTextContent(preview, "after") ?? getTextContent(getRecord(call.parameters), "content");

  return {
    beforeContent: before !== undefined ? truncateContent(before) : undefined,
    afterContent: after !== undefined ? truncateContent(after) : undefined,
    diffPreview: before !== undefined || after !== undefined
      ? truncateText([
          before !== undefined ? `Before:\n${before}` : undefined,
          after !== undefined ? `After:\n${after}` : undefined
        ].filter(Boolean).join("\n\n"))
      : undefined
  };
}


function getCheckpointPath(call: ToolCall, result?: ToolResult) {
  if (!result?.success) return undefined;

  const data = getRecord(result.data);
  const params = getRecord(call.parameters);
  return getString(data, "path")
    ?? getString(data, "newPath")
    ?? getString(data, "oldPath")
    ?? getString(params, "path")
    ?? getString(params, "newPath")
    ?? getString(params, "oldPath");
}

function shouldCreateCheckpoint(call: ToolCall, definition?: ToolDefinition) {
  return definition?.category === "code" || [
    "write_file",
    "delete_file",
    "rename_file",
    "mkdir"
  ].includes(call.name);
}

function shouldCreateProcessSession(call: ToolCall, definition?: ToolDefinition) {
  return definition?.category === "shell" && typeof call.parameters.command === "string";
}

function buildProcessStatus(call: ToolCall, result?: ToolResult) {
  if (!result) return "running";
  if (!result.success) return "failed";
  return call.name === "start_process" ? "running" : "completed";
}

function buildRunSummary(params: {
  steps: AgentStep[];
  content?: string;
  status: PersistAgentRunStatus;
  errorMessage?: string;
}) {
  const { steps, content, status, errorMessage } = params;
  const toolCount = steps.reduce((sum, step) => sum + step.toolCalls.length, 0);
  const failedToolCount = steps.reduce((sum, step) => sum + step.toolResults.filter((result) => !result.success).length, 0);
  return truncateText([
    status === "max_iterations"
      ? "Stopped after reaching the iteration limit"
      : status === "failed"
        ? "Run failed before completion"
        : status === "interrupted"
          ? "Run was interrupted before completion"
          : "Run completed",
    `${steps.length} iteration${steps.length === 1 ? "" : "s"}`,
    `${toolCount} tool call${toolCount === 1 ? "" : "s"}`,
    failedToolCount > 0 ? `${failedToolCount} failed tool result${failedToolCount === 1 ? "" : "s"}` : undefined,
    content ? `Final response: ${content}` : undefined,
    errorMessage ? `Error: ${errorMessage}` : undefined
  ].filter(Boolean).join("; "));
}

function buildCapabilitySnapshot() {
  return toInputJson({
    tools: toolRegistry.list().map((tool) => ({
      name: tool.name,
      category: tool.category,
      requiresApproval: tool.requiresApproval ?? false
    }))
  });
}

export async function persistAgentRun(params: PersistAgentRunParams) {
  const status = params.status ?? "completed";
  const createAssistantMessage = params.createAssistantMessage ?? Boolean(params.content);
  const serializedSteps = serializeAgentSteps(params.steps);
  let interactivePayload:
    | {
        type: "ask_user";
        questions: Array<{
          question: string;
          header: string;
          options: Array<{ label: string; description?: string; preview?: string }>;
          multiSelect: boolean;
        }>;
      }
    | undefined;
  if (createAssistantMessage && params.steps.length > 0) {
    const lastStep = params.steps[params.steps.length - 1];
    const userQuestionCall = lastStep.toolCalls.find((c) => c.name === "ask_user");
    if (userQuestionCall) {
      const askResult = lastStep.toolResults[lastStep.toolCalls.indexOf(userQuestionCall)];
      if (askResult?.success && askResult.data && typeof askResult.data === "object") {
        const data = askResult.data as Record<string, unknown>;
        const rawQuestions = Array.isArray(data.questions) ? data.questions : [];
        const questions = rawQuestions
          .map((raw, index) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
            const record = raw as Record<string, unknown>;
            const question = typeof record.question === "string" ? record.question.trim() : "";
            if (!question) return null;
            const header = (typeof record.header === "string" && record.header.trim()
              ? record.header.trim()
              : `Q${index + 1}`
            ).slice(0, 12);
            const rawOptions = Array.isArray(record.options)
              ? record.options
              : record.options && typeof record.options === "object"
                ? (["items", "item", "choices", "choice", "values", "value", "options", "option", "list", "entries", "rows"]
                    .map((key) => (record.options as Record<string, unknown>)[key])
                    .find((candidate): candidate is unknown[] => Array.isArray(candidate)) ?? [])
                : [];
            const options = rawOptions
              .map((rawOption) => {
                if (typeof rawOption === "string") {
                  return rawOption.trim() ? { label: rawOption.trim() } : null;
                }
                if (Array.isArray(rawOption)) {
                  const first = rawOption[0];
                  if (typeof first === "string") return first.trim() ? { label: first.trim() } : null;
                  if (first && typeof first === "object" && !Array.isArray(first)) {
                    rawOption = first as Record<string, unknown>;
                  } else {
                    return null;
                  }
                }
                if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) return null;
                const optRecord = rawOption as Record<string, unknown>;
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
                return {
                  label,
                  ...(description ? { description } : {}),
                  ...(preview ? { preview } : {})
                };
              })
              .filter((opt): opt is { label: string; description?: string; preview?: string } => Boolean(opt));
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
            options: { label: string; description?: string; preview?: string }[];
            multiSelect: boolean;
          } => Boolean(q));
        if (questions.length > 0) {
          interactivePayload = { type: "ask_user", questions };
        }
      }
    }
  }

  const metadata: PersistedMessageMetadata = {
    ...(createAssistantMessage && serializedSteps.length > 0
      ? {
          steps: serializedSteps,
          iterations: serializedSteps.length
        }
      : {}),
    ...(createAssistantMessage && params.tokenUsage ? { tokenUsage: params.tokenUsage } : {}),
    ...(createAssistantMessage && params.elapsedMs != null ? { elapsedMs: params.elapsedMs } : {}),
    ...(createAssistantMessage && interactivePayload ? { interactive: interactivePayload } : {})
  };

  return prisma.$transaction(async (tx) => {
    const assistantMessage = createAssistantMessage && params.content
      ? await tx.message.create({
          data: {
            conversationId: params.conversationId,
            role: "assistant",
            mode: "agent",
            content: params.content,
            memoryText: buildAssistantMemoryText(params.content, { mode: "agent", steps: params.steps }),
            metadata: serializeMessageMetadata(metadata),
            model: params.model,
            provider: params.provider,
            reasoningEffort: params.reasoningEffort ?? null
          }
        })
      : null;

    const run = await tx.agentRun.create({
      data: {
        conversationId: params.conversationId,
        workspaceId: params.workspaceId,
        triggerMessageId: params.triggerMessageId,
        assistantMessageId: assistantMessage?.id,
        mode: params.mode ?? "agent",
        status,
        provider: params.provider,
        model: params.model,
        reasoningEffort: params.reasoningEffort ?? null,
        promptPreview: truncateText(params.prompt),
        responsePreview: params.content ? truncateText(params.content) : undefined,
        runSummary: buildRunSummary({
          steps: params.steps,
          content: params.content,
          status,
          errorMessage: params.errorMessage
        }),
        errorMessage: params.errorMessage ? truncateText(params.errorMessage) : undefined,
        capabilitySnapshot: buildCapabilitySnapshot(),
        tokenUsage: toInputJson(params.tokenUsage),
        iterationCount: params.steps.length,
        startedAt: params.steps[0]?.timestamp ?? new Date(),
        completedAt: new Date()
      }
    });

    if (assistantMessage) {
      const metadataWithRun = {
        ...metadata,
        agentRunId: run.id,
        agentStoreVersion: 1
      };

      await tx.message.update({
        where: { id: assistantMessage.id },
        data: {
          metadata: serializeMessageMetadata(metadataWithRun)
        }
      });
    }

    for (const step of params.steps) {
      const stepRecord = await tx.agentRunStep.create({
        data: {
          runId: run.id,
          iteration: step.iteration,
          reasoning: step.reasoning,
          response: step.response,
          responsePreview: step.response ? truncateText(step.response) : undefined,
          toolCallCount: step.toolCalls.length,
          toolFailureCount: step.toolResults.filter((result) => !result.success).length,
          timestamp: step.timestamp
        }
      });

      for (const [index, call] of step.toolCalls.entries()) {
        const result = step.toolResults[index];
        const definition = getToolDefinition(call);
        const requiresApproval = definition?.requiresApproval ?? false;
        const toolCall = await tx.agentToolCall.create({
          data: {
            runId: run.id,
            stepId: stepRecord.id,
            externalCallId: call.id,
            name: call.name,
            category: definition?.category,
            status: getToolCallStatus(result),
            parameters: toInputJson(call.parameters),
            resultData: buildResultData(result),
            outputPreview: summarizeResult(result),
            errorMessage: result?.error ? truncateText(result.error) : undefined,
            requiresApproval,
            approvedByUser: requiresApproval ? !isRejectedResult(result) : undefined,
            approvalId: requiresApproval ? `${params.conversationId}:${call.id}` : undefined,
            riskLevel: requiresApproval ? "requires_approval" : undefined,
            startedAt: step.timestamp,
            completedAt: result ? step.timestamp : undefined
          }
        });

        if (shouldCreateCheckpoint(call, definition)) {
          const checkpointPath = getCheckpointPath(call, result);
          if (checkpointPath) {
            const checkpointPreview = buildCheckpointPreview(getRecord(result?.data), call);
            await tx.agentCheckpoint.create({
              data: {
                runId: run.id,
                stepId: stepRecord.id,
                toolCallId: toolCall.id,
                workspaceId: params.workspaceId,
                path: checkpointPath,
                status: "created",
                ...checkpointPreview
              }
            });
          }
        }

        if (shouldCreateProcessSession(call, definition)) {
          const processStatus = buildProcessStatus(call, result);
          const data = getRecord(result?.data);
          await tx.agentProcessSession.create({
            data: {
              runId: run.id,
              workspaceId: params.workspaceId,
              toolCallId: toolCall.id,
              kind: call.name === "start_process" ? "process" : "command",
              status: processStatus,
              command: call.parameters.command as string,
              cwd: typeof data?.cwd === "string" ? data.cwd : params.workspacePath,
              pid: typeof data?.pid === "number" ? data.pid : undefined,

              exitCode: typeof data?.exitCode === "number" ? data.exitCode : undefined,
              stdoutPreview: result?.success && result.output ? truncateText(result.output) : undefined,
              stderrPreview: result && !result.success && result.error ? truncateText(result.error) : undefined,
              outputSummary: summarizeResult(result),
              startedAt: step.timestamp,
              completedAt: processStatus === "running" ? undefined : step.timestamp
            }
          });
        }
      }
    }

    return { assistantMessage, run };
  });
}
