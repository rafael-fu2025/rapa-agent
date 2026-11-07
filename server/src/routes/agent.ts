// Agent execution routes

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";


import { Agent, type AgentExecutionEvent, type AgentMessage, type AgentStep, type AgentTokenUsage, type ToolApprovalDecision, type ToolApprovalRequest } from "../lib/agent.js";

import {
  buildAgentRulesMessage,
  buildConversationMemoryMessage,
  buildUserMemoryText,
  loadConversationMemory,
  refreshConversationSummary
} from "../lib/conversation-memory.js";
import {
  buildSpecialistCatalogMessage,
  resolveSpecialistDefinitions,
  buildActivatedSpecialistMessage,
  classifySpecialistMode,
  getBuiltinSpecialists
} from "../lib/sub-agents.js";
import { retrieveRelevantContext, formatRetrievedContext } from "../lib/agent/context-retrieval.js";
import { fetchLlmUpstream } from "../lib/llm-upstream.js";
import { getDefaultBaseUrl, getDefaultModels } from "../lib/constants.js";

import { decryptText } from "../lib/crypto.js";
import { prisma, getLocalUser } from "../lib/db.js";
import { loadHooksForUser, type HookConfig } from "../lib/hooks.js";
import { buildAgentIdentityMessage } from "../lib/agent/prompt-builder.js";
import { loadWorkspaceInstructions, buildWorkspaceInstructionsMessage } from "../lib/workspace-instructions.js";
import { persistAgentRun, persistRunStepIncremental, startAgentRun } from "../lib/agent-run-store.js";
import {
  closeRunEvents,
  getRunBufferInfo,
  publishRunEvent,
  resolveReattachMode,
  subscribeRunEvents
} from "../lib/live-run-broker.js";
import {
  createRunWorktree,
  isGitRepo,
  mergeRunWorktree,
  parseWorktreeMetadata,
  discardRunWorktree
} from "../lib/worktree.js";
import { randomUUID } from "node:crypto";
import { resolveSseAllowOrigin } from "../lib/cors-origins.js";
import { providerAllowsKeylessAccess } from "../lib/providers.js";
import { recordUsage } from "../lib/usage.js";
import { analyseCommandRisk, getDangerousPatternIds, getDangerousPatterns } from "../lib/safety/dangerous-patterns.js";
import { detectPromptInjection, wrapUntrustedContent } from "../lib/safety/prompt-injection.js";

import { toolRegistry } from "../tools/index.js";

// Sub-module imports (extracted to keep this file focused on route handlers)
import {
  agentRequestSchema,
  validateToolSchema,
  diagnosticsSchema,
  upsertAgentRuleSchema,
  upsertAgentSkillSchema,
  upsertMcpServerSchema,
  upsertAgentIntegrationSchema,
  upsertAgentHookSchema,
  hookParamsSchema,
  approvalDecisionSchema,
  agentRunsQuerySchema,
  agentRunParamsSchema,
  worktreeActionParamsSchema,
  checkpointParamsSchema,
  checkpointListSchema,
  ACTIVE_RUN_STATUSES,
  type AgentRequestPayload,
  type ChatCompletionResponse
} from "./agent/schemas.js";

import {
  shouldAutoResumePrompt,
  buildResumeContextMessage,
  loadLatestResumableRun
} from "./agent/resume.js";

import { handleToolApproval, pendingToolApprovals, listPendingApprovals } from "./agent/approval.js";
import { resolveAgentWorkspace, resolveWorkspaceForUser } from "./agent/workspace.js";
import {
  resolveCheckpointRestorePath,
  restoreTextCheckpoint,
  restoreRenameCheckpoint,
  restoreMkdirCheckpoint
} from "./agent/checkpoints.js";




type PreparedAgentRequest = {
  payload: AgentRequestPayload;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  providerSettingId: string;
  primaryApiKeyId: string;
  primaryApiKeyName: string;
  fallbackApiKeys: Array<{ apiKeyEncrypted: string; id: string; name: string }>;
  encryptionSecret: string;
  userId: string;
  workspaceId: string;
  workspacePath: string;
  conversationId: string;
  isNewConversation: boolean;
  seedHistory: AgentMessage[];
  agentRules: Array<{ name: string; content: string; scope: string }>;
  agentSkills: Array<{ name: string; description: string; source: string }>;
  /** Enabled lifecycle hooks (Item 5) — loaded once per request. */
  hooks: HookConfig[];
  resumedFromRunId?: string;
  /// Reasoning / thinking-mode depth for this run. Translated to the
  /// provider's native field shape by
  /// `server/src/lib/agent/reasoning-translator.ts`. "off" suppresses
  /// the setting entirely so the provider uses its own default.
  reasoningEffort?: "off" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "on";
  /// Worktree-per-run isolation (Item 3). Present when the request opted
  /// in and the workspace is a git repo; `workspacePath` above then points
  /// INSIDE the worktree while `worktreeInfo.originalRoot` keeps the
  /// original checkout for later merge/discard.
  worktreeInfo?: { branch: string; path: string; originalRoot: string };
};

async function runShellToolCommand(params: {
  userId: string;
  workspacePath: string;
  command: string;
  timeout?: number;
  workdir?: string;
  conversationId: string;
}) {
  const executeTool = toolRegistry.get("execute_command");
  if (!executeTool) {
    throw new Error("execute_command tool is not registered");
  }

  const toolParams: Record<string, unknown> = {
    command: params.command,
    ...(params.timeout ? { timeout: params.timeout } : {}),
    ...(params.workdir ? { cwd: params.workdir } : {})
  };

  const validation = executeTool.validate(toolParams);
  if (!validation.valid) {
    throw new Error(`Invalid command parameters: ${validation.errors?.join(", ")}`);
  }

  return executeTool.execute(toolParams, {
    workspaceRoot: params.workspacePath,
    userId: params.userId,
    conversationId: params.conversationId,
    mode: "agent"
  });
}

async function prepareAgentRequest(payload: AgentRequestPayload): Promise<PreparedAgentRequest> {



  const user = await getLocalUser();
  const secret = process.env.APP_SECRET;

  if (!secret) {
    throw new Error("APP_SECRET is not configured");
  }

  // Prompt injection detection (OWASP Agentic Top 10 — ASI01).
  // Scan the raw user prompt before any processing. "blocked" verdicts are
  // hard-refused; "suspicious" verdicts are wrapped in an untrusted-content
  // envelope so the LLM treats them as data, not instructions.
  const injectionVerdict = detectPromptInjection(payload.prompt);
  if (injectionVerdict.status === "blocked") {
    throw new Error(`Prompt blocked by injection detector: ${injectionVerdict.summary}`);
  }
  if (injectionVerdict.status === "suspicious") {
    payload = { ...payload, prompt: wrapUntrustedContent(payload.prompt, injectionVerdict) };
  }

  let settings = await prisma.providerSetting.findUnique({
    where: {
      userId_provider: {
        userId: user.id,
        provider: payload.provider
      }
    },
    include: {
      apiKeys: {
        orderBy: { createdAt: "asc" }
      }
    }
  });

  if (!settings && providerAllowsKeylessAccess(payload.provider)) {
    settings = await prisma.providerSetting.create({
      data: {
        userId: user.id,
        provider: payload.provider,
        enabled: true,
        baseUrl: getDefaultBaseUrl(payload.provider),
        models: getDefaultModels(payload.provider),
        autoSwitchApiKey: false
      },
      include: {
        apiKeys: {
          orderBy: { createdAt: "asc" }
        }
      }
    });
  }

  if (!settings || (settings.apiKeys.length === 0 && !providerAllowsKeylessAccess(payload.provider))) {
    throw new Error("Missing API key. Configure provider in Settings first.");
  }

  const primaryKey = settings.apiKeys.find(k => k.isActive) || settings.apiKeys[0];
  const fallbackApiKeys = settings.apiKeys
    .filter(k => primaryKey ? k.id !== primaryKey.id : true)
    .map((k) => ({
      apiKeyEncrypted: k.apiKeyEncrypted,
      id: k.id,
      name: k.name
    }));

  if (!settings.enabled) {
    throw new Error(`${payload.provider} is disabled in settings`);
  }

  const model = payload.model ?? ((settings.models as string[] | null) ?? [])[0];
  if (!model) {
    throw new Error("No model configured");
  }

  const existingConversation = payload.conversationId
    ? await prisma.conversation.findFirst({
        where: {
          id: payload.conversationId,
          userId: user.id
        }
      })
    : null;

  if (payload.conversationId && !existingConversation) {
    throw new Error("Conversation not found");
  }

  const workspace = await resolveAgentWorkspace(user.id, {
    workspaceId: payload.workspaceId,
    conversationId: existingConversation?.id
  });

  const conversation = existingConversation ?? await prisma.conversation.create({
    data: {
      userId: user.id,
      workspaceId: workspace.id,
      title: payload.prompt.slice(0, 60)
    }
  });

  // Decrypt once — reused for the LLM config and for idle summary refresh
  // inside loadConversationMemory (Item 13).
  const resolvedApiKey = primaryKey ? decryptText(primaryKey.apiKeyEncrypted, secret) : "ollama";

  const loadedMemory = await loadConversationMemory(conversation.id, {
    baseUrl: settings.baseUrl,
    apiKey: resolvedApiKey,
    model
  });

  // Item 5 — lifecycle hooks are loaded once per request and ride the
  // AgentConfig; the loop skips dispatch entirely when the list is empty.
  const hooks = await loadHooksForUser(user.id);
  const seedHistoryItems = [
    buildConversationMemoryMessage(loadedMemory),
    ...loadedMemory.recentMessages
  ].filter((message): message is Exclude<typeof message, null> => message !== null);
  const seedHistory: AgentMessage[] = seedHistoryItems;
  let resumedFromRunId: string | undefined;

  if (existingConversation && shouldAutoResumePrompt(payload.prompt)) {
    const resumableRun = await loadLatestResumableRun(conversation.id);
    if (resumableRun) {
      seedHistory.unshift({
        role: "system",
        content: buildResumeContextMessage(resumableRun)
      });
      resumedFromRunId = resumableRun.id;
      await prisma.agentRun.update({
        where: { id: resumableRun.id },
        data: { status: "resumed" }
      });
    }
  }

  const rules = await prisma.agentRule.findMany({
    where: {
      userId: user.id,
      enabled: true,
      OR: [
        { scope: "global" },
        { scope: "workspace", workspaceId: workspace.id },
        { scope: "conversation", conversationId: conversation.id }
      ]
    },
    orderBy: [{ priority: "desc" }, { updatedAt: "desc" }]
  });

  const agentRules = rules.map((rule) => ({
    name: rule.name,
    content: rule.content,
    scope: rule.scope
  }));

  // Workspace instruction file (AGENTS.md / CLAUDE.md / .cursorrules) —
  // injected BEFORE the rules unshift so it lands directly after the DB
  // rules in the final seed order. Skipped silently when absent.
  const workspaceInstructions = await loadWorkspaceInstructions(workspace.path);
  if (workspaceInstructions) {
    seedHistory.unshift({
      role: "system",
      content: buildWorkspaceInstructionsMessage(workspaceInstructions)
    });
  }

  if (agentRules.length > 0) {
    const rulesMessage = buildAgentRulesMessage(agentRules);
    seedHistory.unshift({
      role: "system",
      content: rulesMessage
    });
  }

  const storedSkills = await prisma.agentSkill.findMany({
    where: {
      userId: user.id,
      enabled: true
    },
    orderBy: [{ updatedAt: "desc" }]
  });
  const resolvedSkills = resolveSpecialistDefinitions(storedSkills);
  const agentSkills = resolvedSkills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    source: skill.source
  }));

  if (resolvedSkills.length > 0) {
    seedHistory.unshift({
      role: "system",
      content: buildSpecialistCatalogMessage(resolvedSkills)
    });

    // Retrieve relevant context from past conversations (semantic RAG) — new conversations only
    if (!existingConversation) {
      try {
        const retrievedContexts = await retrieveRelevantContext({
          userId: user.id,
          query: payload.prompt,
          workspaceId: workspace?.id,
          limit: 3
        });
        if (retrievedContexts.length > 0) {
          const formatted = formatRetrievedContext(retrievedContexts);
          seedHistory.unshift({ role: "system", content: formatted });
        }
      } catch {
        // Context retrieval failure is non-fatal — continue without past context
      }
    }

    // Zero-Turn Auto-Router: Activate matching specialist for ALL conversations.
    // Specialist routing is based on the prompt content, not conversation state.
    // This ensures specialists fire even on existing conversations when the
    // user's new request matches a specialist pattern (e.g., "build", "debug").
    const matchedSpecialist = classifySpecialistMode(payload.prompt, resolvedSkills);
    if (matchedSpecialist) {
      const activationMessage = buildActivatedSpecialistMessage(matchedSpecialist, {
        task: payload.prompt,
        taskContext: "Automatically routed based on user request analysis."
      });
      seedHistory.push({
        role: "system",
        content: activationMessage
      });
    }
  }

  // Agent identity — unshifted LAST so it lands FIRST in the final seed
  // order and becomes the hoisted system message in the provider payload.
  // Without this the model's only guidance is each tool's description.
  seedHistory.unshift({
    role: "system",
    content: buildAgentIdentityMessage(payload.mode ?? "agent")
  });

  // Item 3 — worktree-per-run isolation. When the request opted in AND the
  // workspace is a git repository, create a dedicated worktree and point the
  // run at it. Placed LAST in the prepare chain: if any later step threw
  // before this, no worktree would leak. Creation failure (or a non-git
  // workspace) logs and falls back to the original checkout — isolation
  // setup must never fail the run.
  let workspacePath = workspace.path;
  let worktreeInfo: PreparedAgentRequest["worktreeInfo"];
  if (payload.worktree === true) {
    try {
      if (await isGitRepo(workspace.path)) {
        // The AgentRun row does not exist yet at request-prepare time, so
        // the branch name is seeded from a random token; the run row then
        // records {branch, path, originalRoot} and merge/discard resolve
        // via that metadata.
        const created = await createRunWorktree(workspace.path, randomUUID());
        worktreeInfo = { ...created, originalRoot: workspace.path };
        workspacePath = created.path;
      } else {
        console.log("[agent] worktree requested but the workspace is not a git repository — running in the original checkout");
      }
    } catch (error) {
      console.warn(`[agent] worktree creation failed — falling back to the original workspace: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {

    payload,

    provider: payload.provider,
    model,
    providerSettingId: settings.id,
    primaryApiKeyId: primaryKey?.id ?? `${payload.provider}-direct`,
    primaryApiKeyName: primaryKey?.name ?? "Direct connection",
    apiKey: resolvedApiKey,
    baseUrl: settings.baseUrl,
    fallbackApiKeys,
    encryptionSecret: secret,
    userId: user.id,
    workspaceId: workspace.id,
    workspacePath,
    conversationId: conversation.id,
    isNewConversation: !existingConversation,
    seedHistory,
    agentRules,
    agentSkills,
    hooks,
    resumedFromRunId,
    reasoningEffort: payload.reasoningEffort,
    worktreeInfo
  };

}


async function storeUserPrompt(requestInfo: PreparedAgentRequest) {
  // Deduplication: if a user message with the same content already exists
  // in this conversation (created within last 3 minutes), return it instead
  // of creating a duplicate. This prevents duplicate messages when the SSE
  // stream retries after a network error. The frontend can retry up to 30
  // times with exponential backoff, spanning ~2-3 minutes total.
  const recentDuplicate = await prisma.message.findFirst({
    where: {
      conversationId: requestInfo.conversationId,
      role: "user",
      content: requestInfo.payload.prompt,
      createdAt: {
        gte: new Date(Date.now() - 180_000) // Last 3 minutes
      }
    },
    orderBy: { createdAt: "desc" }
  });

  if (recentDuplicate) {
    return recentDuplicate;
  }

  // Secondary dedup: if there's already an AgentRun in this conversation
  // whose trigger message has the same content, reuse that trigger message.
  // This catches retries that span longer than 3 minutes.
  const existingRunWithSamePrompt = await prisma.agentRun.findFirst({
    where: {
      conversationId: requestInfo.conversationId,
      triggerMessage: {
        content: requestInfo.payload.prompt
      }
    },
    include: {
      triggerMessage: true
    },
    orderBy: { createdAt: "desc" }
  });

  if (existingRunWithSamePrompt?.triggerMessage) {
    return existingRunWithSamePrompt.triggerMessage;
  }

  return prisma.message.create({
    data: {
      conversationId: requestInfo.conversationId,
      role: "user",
      mode: requestInfo.payload.mode,
      content: requestInfo.payload.prompt,
      memoryText: buildUserMemoryText(requestInfo.payload.prompt),
      model: requestInfo.model,
      provider: requestInfo.provider
    }
  });
}

async function storeAssistantResponse(
  requestInfo: PreparedAgentRequest,
  triggerMessageId: string,
  content: string,
  steps: AgentStep[] = [],
  tokenUsage?: AgentTokenUsage,
  status: "completed" | "max_iterations" | "failed" | "interrupted" | "aborted" = "completed",
  elapsedMs?: number,
  existingRunId?: string
) {
  const persisted = await persistAgentRun({
    conversationId: requestInfo.conversationId,
    workspaceId: requestInfo.workspaceId,
    workspacePath: requestInfo.workspacePath,
    triggerMessageId,
    provider: requestInfo.provider,
    model: requestInfo.model,
    mode: requestInfo.payload.mode,
    prompt: requestInfo.payload.prompt,
    content,
    steps,
    tokenUsage,
    elapsedMs,
    status,
    reasoningEffort: requestInfo.reasoningEffort,
    // Worktree metadata rides to the CREATE path (the non-stream route has
    // no startAgentRun row); the UPDATE path (streamed runs) ignores it so
    // the start-time metadata is never clobbered.
    worktreeInfo: requestInfo.worktreeInfo,
    existingRunId
  });

  await prisma.conversation.update({
    where: { id: requestInfo.conversationId },
    data: { updatedAt: new Date() }
  });

  return persisted;
}

async function storeInterruptedRun(
  requestInfo: PreparedAgentRequest,
  triggerMessageId: string,
  steps: AgentStep[] = [],
  errorMessage?: string,
  existingRunId?: string
) {
  const persisted = await persistAgentRun({
    conversationId: requestInfo.conversationId,
    workspaceId: requestInfo.workspaceId,
    workspacePath: requestInfo.workspacePath,
    triggerMessageId,
    provider: requestInfo.provider,
    model: requestInfo.model,
    mode: requestInfo.payload.mode,
    prompt: requestInfo.payload.prompt,
    steps,
    status: "failed",
    errorMessage,
    createAssistantMessage: false,
    reasoningEffort: requestInfo.reasoningEffort,
    worktreeInfo: requestInfo.worktreeInfo,
    existingRunId
  });

  await prisma.conversation.update({
    where: { id: requestInfo.conversationId },
    data: { updatedAt: new Date() }
  });

  return persisted;
}

async function persistProviderApiKeySwitch(providerSettingId: string, newKeyId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.providerApiKey.updateMany({
      where: { providerSettingId },
      data: { isActive: false }
    });

    await tx.providerApiKey.update({
      where: { id: newKeyId },
      data: { isActive: true }
    });
  });
}



function createAgent(
  requestInfo: PreparedAgentRequest,
  requestToolApproval?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>
) {
  return new Agent(
    {
      workspaceRoot: requestInfo.workspacePath,
      userId: requestInfo.userId,
      conversationId: requestInfo.conversationId,
      mode: requestInfo.payload.mode,
      agentDepth: 0,
      // Wave 1 — shell sandbox strategy, threaded to shell tools via
      // ToolExecutionContext.sandboxMode. Undefined = native default.
      ...(requestInfo.payload.sandboxMode ? { sandboxMode: requestInfo.payload.sandboxMode } : {}),
      llm: {
        provider: requestInfo.provider,
        model: requestInfo.model,
        baseUrl: requestInfo.baseUrl,
        apiKey: requestInfo.apiKey,
        fallbackApiKeys: requestInfo.fallbackApiKeys,
        encryptionSecret: requestInfo.encryptionSecret
      }
    },
    {
      maxIterations: requestInfo.payload.maxIterations,
      autoApproveTools: requestInfo.payload.autoApproveTools,
      provider: requestInfo.provider,
      model: requestInfo.model,
      baseUrl: requestInfo.baseUrl,
      apiKey: requestInfo.apiKey,
      primaryApiKeyId: requestInfo.primaryApiKeyId,
      primaryApiKeyName: requestInfo.primaryApiKeyName,
      providerSettingId: requestInfo.providerSettingId,
      fallbackApiKeys: requestInfo.fallbackApiKeys,
      encryptionSecret: requestInfo.encryptionSecret,
      seedHistory: requestInfo.seedHistory,
      isNewConversation: requestInfo.isNewConversation,
      requestToolApproval,
      onApiKeySwitch: ({ providerSettingId, newKeyId }) => (
        providerSettingId ? persistProviderApiKeySwitch(providerSettingId, newKeyId) : undefined
      ),
      // Wave 1 — LLM auto-approve classifier config rides on the config so
      // the approval layer can classify shell commands before patterns.
      // The payload field is optional; normalize to the strict config shape
      // (omitted `enabled` resolves to false, matching resolveClassifierConfig).
      ...(requestInfo.payload.autoApproveClassifier
        ? {
            autoApproveClassifier: {
              enabled: requestInfo.payload.autoApproveClassifier.enabled ?? false,
              ...(requestInfo.payload.autoApproveClassifier.provider !== undefined
                ? { provider: requestInfo.payload.autoApproveClassifier.provider }
                : {}),
              ...(requestInfo.payload.autoApproveClassifier.model !== undefined
                ? { model: requestInfo.payload.autoApproveClassifier.model }
                : {})
            }
          }
        : {}),
      // Item 5 — lifecycle hooks; empty list = zero dispatch overhead.
      hooks: requestInfo.hooks,
      // Forwarded as `reasoning_effort` to providers that honor it (OpenAI o-series,
      // DeepSeek reasoner). Undefined = let the provider default.
      reasoningEffort: requestInfo.reasoningEffort
    }
  );
}



function sendSseEvent(reply: FastifyReply, request: FastifyRequest, event: AgentExecutionEvent | Record<string, unknown>) {
  // Echo the request origin ONLY when it is on the configured CORS allowlist —
  // reflecting arbitrary origins would defeat the allowlist for streaming.
  const allowOrigin = resolveSseAllowOrigin(request.headers.origin);
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Disable proxy buffering (nginx etc.) so events flush immediately.
    "X-Accel-Buffering": "no",
    ...(allowOrigin ? { "Access-Control-Allow-Origin": allowOrigin } : {}),
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  });

  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeSseEvent(reply: FastifyReply, event: AgentExecutionEvent | Record<string, unknown>) {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

function toHttpError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";

  if (message === "APP_SECRET is not configured") {
    return { statusCode: 500, message };
  }

  if (
    message === "Conversation not found" ||
    message === "No workspace selected. Please open a workspace first." ||
    message === "Missing API key. Configure provider in Settings first." ||
    message === "No model configured" ||
    message.startsWith("Prompt blocked by injection detector") ||
    message.endsWith("is disabled in settings")
  ) {
    return { statusCode: 400, message };
  }

  return { statusCode: 500, message };
}

/**
 * UPDATE-by-id endpoints must not touch another user's row. The DELETE
 * endpoints already enforce ownership; this keeps UPDATE consistent
 * (previously `update({ where: { id } })` with no userId check).
 */
async function isOwnedByUser(
  table: "agentRule" | "agentSkill" | "agentMcpServer" | "agentIntegration" | "autoApprovePattern" | "agentHook",
  id: string,
  userId: string
): Promise<boolean> {
  const delegate = prisma[table] as unknown as {
    findUnique: (args: { where: { id: string } }) => Promise<{ userId: string } | null>;
  };
  const row = await delegate.findUnique({ where: { id } });
  return row !== null && row.userId === userId;
}

function queueConversationSummaryRefresh(app: FastifyInstance, requestInfo: PreparedAgentRequest) {
  void refreshConversationSummary({
    conversationId: requestInfo.conversationId,
    baseUrl: requestInfo.baseUrl,
    apiKey: requestInfo.apiKey,
    model: requestInfo.model
  }).catch((error) => {
    app.log.warn({ err: error, conversationId: requestInfo.conversationId }, "Failed to refresh conversation memory summary");
  });
}

async function generateConversationTitle(params: {
  firstMessage: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<string> {
  try {
    const response = await fetchLlmUpstream(undefined, `${params.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`
      },
      body: JSON.stringify({
        model: params.model,
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant that generates short, descriptive conversation titles. Generate a title that is 3-6 words long, capturing the main topic or intent of the user's message. Respond with ONLY the title, no quotes, no punctuation at the end, no extra text."
          },
          {
            role: "user",
            content: `Generate a short title (3-6 words) for a conversation that starts with this message:\n\n${params.firstMessage.slice(0, 500)}`
          }
        ]
      })
    });

    if (!response.ok) {
      return "New Conversation";
    }

    const data = await response.json() as ChatCompletionResponse;
    const rawContent = data.choices?.[0]?.message?.content || "";
    let title = rawContent.replace(/<(thinking|think)>[\s\S]*?<\/\1>/gi, "").trim();
    if (!title) title = "New Conversation";
    return title.replace(/^["']|["']$/g, "").slice(0, 60);
  } catch {
    return "New Conversation";
  }
}

function queueConversationTitleGeneration(app: FastifyInstance, requestInfo: PreparedAgentRequest) {
  void generateConversationTitle({
    firstMessage: requestInfo.payload.prompt,
    baseUrl: requestInfo.baseUrl,
    apiKey: requestInfo.apiKey,
    model: requestInfo.model
  }).then(async (title) => {
    await prisma.conversation.update({
      where: { id: requestInfo.conversationId },
      data: { title }
    });
  }).catch((error) => {
    app.log.warn({ err: error, conversationId: requestInfo.conversationId }, "Failed to generate conversation title");
  });
}

async function assertAgentRunOwner(userId: string, runId: string) {
  return prisma.agentRun.findFirst({
    where: {
      id: runId,
      conversation: { userId }
    }
  });
}

/**
 * Shared body of POST /agent/runs/:id/worktree/{merge,discard} (Item 3).
 * Loads the run row (ownership via the conversation relation), reads the
 * worktree metadata, executes the git operation against the ORIGINAL
 * checkout, and flips the stored status on success. Failures keep the
 * status "active" so the user can retry.
 */
async function handleWorktreeAction(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  action: "merge" | "discard",
  activeStatuses: Set<string>
) {
  const parsed = worktreeActionParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    return reply.code(400).send({ message: "Invalid params", issues: parsed.error.issues });
  }

  const user = await getLocalUser();
  const run = await assertAgentRunOwner(user.id, parsed.data.id);
  if (!run) {
    return reply.code(404).send({ message: "Agent run not found" });
  }

  const info = parseWorktreeMetadata(run.worktree);
  if (!info) {
    return reply.code(404).send({ message: "This run has no worktree — it executed in the original checkout" });
  }
  if (info.status && info.status !== "active") {
    return reply.code(409).send({ ok: false, message: `Worktree was already ${info.status}` });
  }
  if (activeStatuses.has(run.status)) {
    return reply.code(409).send({
      ok: false,
      message: `Run is still ${run.status} — wait for it to finish before ${action === "merge" ? "merging" : "discarding"} its worktree`
    });
  }

  const result = action === "merge"
    ? await mergeRunWorktree(info.originalRoot, info)
    : await discardRunWorktree(info.originalRoot, info);

  if (result.ok) {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { worktree: { ...info, status: action === "merge" ? "merged" : "discarded" } }
    }).catch((error: unknown) => {
      app.log.warn({ err: error, runId: run.id }, `Worktree ${action} succeeded but metadata update failed`);
    });
  } else {
    app.log.info({ runId: run.id, action }, `Worktree ${action} refused: ${result.message}`);
  }

  return { ok: result.ok, message: result.message };
}


export async function registerAgentRoutes(app: FastifyInstance) {

  app.get("/agent/tools", async (request, reply) => {
    const modeQuerySchema = z.object({ mode: z.enum(["chat", "agent", "plan"]).optional() });
    const parsed = modeQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid query", issues: parsed.error.issues });
    }

    const mode = parsed.data.mode;
    const tools = mode ? toolRegistry.listForMode(mode) : toolRegistry.list();
    return {
      mode: mode ?? "all",
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        category: tool.category,
        requiresApproval: tool.requiresApproval ?? false,
        parameters: tool.parameters
      }))
    };
  });

  app.post("/agent/tools/validate", async (request, reply) => {
    const parsed = validateToolSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const { name, parameters, mode } = parsed.data;
    const tool = toolRegistry.get(name);
    if (!tool) {
      return reply.code(404).send({ message: `Tool ${name} is not registered` });
    }

    if (mode) {
      const visible = toolRegistry.listForMode(mode).some((definition) => definition.name === name);
      if (!visible) {
        return reply.code(403).send({ message: `Tool ${name} is not available in ${mode} mode` });
      }
    }

    const validation = tool.validate(parameters);
    return {
      valid: validation.valid,
      errors: validation.errors ?? [],
      tool: {
        name: tool.definition.name,
        category: tool.definition.category,
        requiresApproval: tool.definition.requiresApproval ?? false
      }
    };
  });

  app.post("/agent/diagnostics/lint", async (request, reply) => {
    const parsed = diagnosticsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const workspace = await resolveWorkspaceForUser(user.id, parsed.data.workspaceId);

    try {
      const result = await runShellToolCommand({
        userId: user.id,
        workspacePath: workspace.path,
        conversationId: `lint-${Date.now()}`,
        command: "npm run lint --if-present",
        timeout: parsed.data.timeout ?? 120000,
        workdir: parsed.data.workdir
      });

      return {
        ok: result.success,
        command: "npm run lint --if-present",
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        ...result
      };
    } catch (error) {
      return reply.code(500).send({
        message: error instanceof Error ? error.message : "Failed to run lint diagnostics"
      });
    }
  });

  app.post("/agent/diagnostics/test", async (request, reply) => {
    const parsed = diagnosticsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const workspace = await resolveWorkspaceForUser(user.id, parsed.data.workspaceId);

    try {
      const result = await runShellToolCommand({
        userId: user.id,
        workspacePath: workspace.path,
        conversationId: `test-${Date.now()}`,
        command: "npm test --if-present",
        timeout: parsed.data.timeout ?? 180000,
        workdir: parsed.data.workdir
      });

      return {
        ok: result.success,
        command: "npm test --if-present",
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        ...result
      };
    } catch (error) {
      return reply.code(500).send({
        message: error instanceof Error ? error.message : "Failed to run test diagnostics"
      });
    }
  });

  app.get("/agent/rules", async () => {
    const user = await getLocalUser();
    const rules = await prisma.agentRule.findMany({
      where: { userId: user.id },
      orderBy: [{ priority: "desc" }, { updatedAt: "desc" }]
    });

    return { rules };
  });

  app.post("/agent/rules", async (request, reply) => {
    const parsed = upsertAgentRuleSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const data = parsed.data;

    if (data.id && !(await isOwnedByUser("agentRule", data.id, user.id))) {
      return reply.code(404).send({ message: "Rule not found" });
    }

    const rule = data.id
      ? await prisma.agentRule.update({
          where: { id: data.id },
          data: {
            name: data.name,
            content: data.content,
            scope: data.scope,
            priority: data.priority,
            enabled: data.enabled,
            workspaceId: data.workspaceId ?? null,
            conversationId: data.conversationId ?? null
          }
        })
      : await prisma.agentRule.create({
          data: {
            userId: user.id,
            name: data.name,
            content: data.content,
            scope: data.scope,
            priority: data.priority,
            enabled: data.enabled,
            workspaceId: data.workspaceId ?? null,
            conversationId: data.conversationId ?? null
          }
        });

    return { rule };
  });

  app.get("/agent/skills", async () => {
    const user = await getLocalUser();
    const skills = await prisma.agentSkill.findMany({
      where: { userId: user.id },
      orderBy: [{ enabled: "desc" }, { updatedAt: "desc" }]
    });
    return { skills };
  });

  app.get("/agent/specialists", async () => {
    const user = await getLocalUser();
    const skills = await prisma.agentSkill.findMany({
      where: {
        userId: user.id,
        enabled: true
      },
      orderBy: [{ updatedAt: "desc" }]
    });

    const resolved = resolveSpecialistDefinitions(skills);
    const builtins = getBuiltinSpecialists();

    const specialists = resolved.map((skill) => {
      const builtin = builtins[skill.name as keyof typeof builtins];
      return {
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        whenToUse: skill.whenToUse,
        suggestedTools: skill.suggestedTools,
        source: skill.source,
        builtinDescription: builtin?.description ?? null,
        builtinInstructions: builtin?.instructions ?? null
      };
    });

    return { specialists };
  });

  app.post("/agent/skills", async (request, reply) => {
    const parsed = upsertAgentSkillSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const data = parsed.data;

    if (data.id && !(await isOwnedByUser("agentSkill", data.id, user.id))) {
      return reply.code(404).send({ message: "Skill not found" });
    }

    const skill = data.id
      ? await prisma.agentSkill.update({
          where: { id: data.id },
          data: {
            name: data.name,
            description: data.description,
            source: data.source,
            version: data.version,
            enabled: data.enabled,
            config: data.config as never
          }
        })
      : await prisma.agentSkill.create({
          data: {
            userId: user.id,
            name: data.name,
            description: data.description,
            source: data.source,
            version: data.version,
            enabled: data.enabled,
            config: data.config as never
          }
        });

    return { skill };
  });

  // DELETE /agent/skills/:id — removes a stored skill/override entirely.
  // "Use Built-In" on the specialists page deletes the override row instead
  // of saving enabled:false, which previously left a zombie row and a
  // permanently wrong stale-override badge (audit M3).
  app.delete("/agent/skills/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ message: "Invalid params", issues: params.error.issues });
    }

    const user = await getLocalUser();
    if (!(await isOwnedByUser("agentSkill", params.data.id, user.id))) {
      return reply.code(404).send({ message: "Skill not found" });
    }

    await prisma.agentSkill.delete({ where: { id: params.data.id } });
    return { ok: true };
  });

  app.get("/agent/mcp/servers", async () => {
    const user = await getLocalUser();
    const servers = await prisma.agentMcpServer.findMany({
      where: { userId: user.id },
      orderBy: [{ enabled: "desc" }, { updatedAt: "desc" }]
    });
    return { servers };
  });

  app.post("/agent/mcp/servers", async (request, reply) => {
    const parsed = upsertMcpServerSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const data = parsed.data;

    if (data.id && !(await isOwnedByUser("agentMcpServer", data.id, user.id))) {
      return reply.code(404).send({ message: "MCP server not found" });
    }

    const server = data.id
      ? await prisma.agentMcpServer.update({
          where: { id: data.id },
          data: {
            name: data.name,
            endpoint: data.endpoint,
            transport: data.transport,
            enabled: data.enabled,
            authType: data.authType,
            config: data.config as never
          }
        })
      : await prisma.agentMcpServer.create({
          data: {
            userId: user.id,
            name: data.name,
            endpoint: data.endpoint,
            transport: data.transport,
            enabled: data.enabled,
            authType: data.authType,
            config: data.config as never
          }
        });

    return { server };
  });

  app.get("/agent/integrations", async () => {
    const user = await getLocalUser();
    const integrations = await prisma.agentIntegration.findMany({
      where: { userId: user.id },
      orderBy: [{ enabled: "desc" }, { updatedAt: "desc" }]
    });
    return { integrations };
  });

  app.post("/agent/integrations", async (request, reply) => {
    const parsed = upsertAgentIntegrationSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const data = parsed.data;

    if (data.id && !(await isOwnedByUser("agentIntegration", data.id, user.id))) {
      return reply.code(404).send({ message: "Integration not found" });
    }

    const integration = data.id
      ? await prisma.agentIntegration.update({
          where: { id: data.id },
          data: {
            name: data.name,
            provider: data.provider,
            type: data.type,
            enabled: data.enabled,
            status: data.status,
            metadata: (data.metadata ?? undefined) as never
          }
        })
      : await prisma.agentIntegration.create({
          data: {
            userId: user.id,
            name: data.name,
            provider: data.provider,
            type: data.type,
            enabled: data.enabled,
            status: data.status,
            metadata: (data.metadata ?? undefined) as never
          }
        });

    return { integration };
  });

  app.get("/agent/runs", async (request, reply) => {
    const parsed = agentRunsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid query", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    // `includeCompleted=false` (default) restricts to in-flight runs.
    // ACTIVE_RUN_STATUSES is the single source of truth for "alive."
    const statusFilter = parsed.data.includeCompleted
      ? {}
      : { status: { in: [...ACTIVE_RUN_STATUSES] } };

    const runs = await prisma.agentRun.findMany({
      where: {
        conversation: { userId: user.id },
        ...(parsed.data.conversationId ? { conversationId: parsed.data.conversationId } : {}),
        ...(parsed.data.workspaceId ? { workspaceId: parsed.data.workspaceId } : {}),
        ...statusFilter
      },
      orderBy: { createdAt: "desc" },
      take: parsed.data.limit,
      select: {
        id: true,
        conversationId: true,
        workspaceId: true,
        triggerMessageId: true,
        assistantMessageId: true,
        status: true,
        provider: true,
        model: true,
        promptPreview: true,
        responsePreview: true,
        runSummary: true,
        errorMessage: true,
        tokenUsage: true,
        iterationCount: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        conversation: { select: { title: true } },
        workspace: { select: { name: true, path: true } },
        _count: {
          select: {
            steps: true,
            toolCalls: true,
            checkpoints: true,
            processSessions: true
          }
        }
      }
    });

    // "Needs input" join (registry parity): a run whose conversation has a
    // pending (unanswered) tool approval is blocked on the user. Approvals
    // live in memory keyed by conversation, so this is a set intersection.
    const needsInputConversations = new Set(
      listPendingApprovals(user.id).map((approval) => approval.conversationId)
    );

    return {
      runs: runs.map((run) => ({
        ...run,
        needsInput: needsInputConversations.has(run.conversationId)
      }))
    };
  });

  // ------------------------------------------------------------------------
  // Multi-workspace registry.
  //
  // Returns a snapshot of every workspace the user has, plus per-workspace
  // counts of in-flight agent runs and pending tool approvals. Used by the
  // workspace modal in the sidebar so the user can see "what is running
  // where" without having to click into each workspace.
  //
  // "In flight" = an AgentRun whose status is one of ACTIVE_RUN_STATUSES
  // and whose `updatedAt` is within the last `STALE_RUN_THRESHOLD_MS`.
  // We treat very old runs with no completion as completed (stale recovery)
  // so the badge never reports agents that are no longer really running.
  // ------------------------------------------------------------------------
  app.get("/agent/runs/registry", async (_request, _reply) => {
    const user = await getLocalUser();
    const STALE_RUN_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

    const staleCutoff = new Date(Date.now() - STALE_RUN_THRESHOLD_MS);

    // Fetch every workspace, then the counts per workspace, in parallel.
    const [workspaces, activeRuns, pendingApprovalCount] = await Promise.all([
      prisma.workspace.findMany({
        where: { userId: user.id },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          name: true,
          path: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { conversations: true } }
        }
      }),
      prisma.agentRun.findMany({
        where: {
          conversation: { userId: user.id },
          status: { in: [...ACTIVE_RUN_STATUSES] },
          updatedAt: { gte: staleCutoff }
        },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          conversationId: true,
          workspaceId: true,
          status: true,
          provider: true,
          model: true,
          promptPreview: true,
          startedAt: true,
          updatedAt: true,
          conversation: { select: { title: true } }
        }
      }),
      Promise.resolve(pendingToolApprovals.size)
    ]);

    // Group active runs by workspaceId for the badge counts. Runs without
    // a workspaceId (legacy data) are bucketed under `null` for visibility.
    const runsByWorkspace = new Map<string | null, typeof activeRuns>();
    for (const run of activeRuns) {
      const key = run.workspaceId ?? null;
      const existing = runsByWorkspace.get(key);
      if (existing) {
        existing.push(run);
      } else {
        runsByWorkspace.set(key, [run]);
      }
    }

    // Count pending approvals by workspaceId. Each pending approval
    // remembers its conversationId; we look up the workspaceId once.
    const pendingConversationIds = Array.from(pendingToolApprovals.values()).map((p) => p.conversationId);
    const conversations = pendingConversationIds.length > 0
      ? await prisma.conversation.findMany({
          where: { id: { in: pendingConversationIds } },
          select: { id: true, workspaceId: true }
        })
      : [];
    const conversationToWorkspace = new Map(conversations.map((c) => [c.id, c.workspaceId]));
    const pendingApprovalsByWorkspace = new Map<string, number>();
    for (const pending of pendingToolApprovals.values()) {
      const wsId = conversationToWorkspace.get(pending.conversationId) ?? null;
      if (wsId === null) continue; // skip orphan approvals for the badge
      pendingApprovalsByWorkspace.set(wsId, (pendingApprovalsByWorkspace.get(wsId) ?? 0) + 1);
    }

    // Needs-input flags: an active run whose conversation holds an
    // unanswered approval is blocked on the user. Surfaced per running
    // agent so the registry UI can badge the exact run (not just the
    // workspace-wide pendingApprovalCount).
    const needsInputConversations = new Set(pendingConversationIds);

    const items = workspaces.map((ws) => {
      const runs = runsByWorkspace.get(ws.id) ?? [];
      return {
        id: ws.id,
        name: ws.name,
        path: ws.path,
        isActive: ws.isActive,
        conversationCount: ws._count.conversations,
        runningAgentCount: runs.length,
        pendingApprovalCount: pendingApprovalsByWorkspace.get(ws.id) ?? 0,
        // Cap at 5 to keep the modal light. The frontend fetches the full
        // list per workspace on demand.
        runningAgents: runs.slice(0, 5).map((r) => ({
          id: r.id,
          conversationId: r.conversationId,
          conversationTitle: r.conversation.title,
          status: r.status,
          provider: r.provider,
          model: r.model,
          promptPreview: r.promptPreview,
          startedAt: r.startedAt,
          updatedAt: r.updatedAt,
          needsInput: needsInputConversations.has(r.conversationId)
        }))
      };
    });

    const totals = {
      workspaces: items.length,
      runningAgents: activeRuns.length,
      pendingApprovals: pendingApprovalCount
    };

    return {
      items,
      totals,
      // Surface the stale-run threshold so the UI can show "stale" badges
      // for runs that haven't been touched in a while.
      staleRunThresholdMs: STALE_RUN_THRESHOLD_MS
    };
  });

  app.get("/agent/runs/:id", async (request, reply) => {
    const parsed = agentRunParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid params", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const run = await assertAgentRunOwner(user.id, parsed.data.id);
    if (!run) {
      return reply.code(404).send({ message: "Agent run not found" });
    }

    const detail = await prisma.agentRun.findUnique({
      where: { id: run.id },
      include: {
        conversation: { select: { id: true, title: true } },
        workspace: { select: { id: true, name: true, path: true } },
        triggerMessage: { select: { id: true, role: true, content: true, createdAt: true } },
        assistantMessage: { select: { id: true, role: true, content: true, createdAt: true } },
        // take bounds: a runaway run can have hundreds of rows per relation —
        // the detail view only renders the recent tail.
        steps: { orderBy: { iteration: "desc" }, take: 100 },
        toolCalls: { orderBy: { createdAt: "desc" }, take: 400 },
        checkpoints: {
          orderBy: { createdAt: "desc" },
          take: 200,
          include: {
            toolCall: { select: { id: true, name: true, status: true } }
          }
        },
        processSessions: { orderBy: { createdAt: "desc" }, take: 50 }
      }
    });

    if (!detail) {
      return reply.code(404).send({ message: "Agent run not found" });
    }

    return {
      run: {
        ...detail,
        // Relations were fetched newest-first with a take cap; restore the
        // chronological (ascending) order the UI renders.
        steps: [...detail.steps].reverse(),
        toolCalls: [...detail.toolCalls].reverse(),
        checkpoints: [...detail.checkpoints].reverse().map((checkpoint) => ({
          id: checkpoint.id,
          runId: checkpoint.runId,
          stepId: checkpoint.stepId,
          toolCallId: checkpoint.toolCallId,
          workspaceId: checkpoint.workspaceId,
          path: checkpoint.path,
          status: checkpoint.status,
          diffPreview: checkpoint.diffPreview,
          restoreNote: checkpoint.restoreNote,
          restoredAt: checkpoint.restoredAt,
          createdAt: checkpoint.createdAt,
          updatedAt: checkpoint.updatedAt,
          toolCall: checkpoint.toolCall,
          canRestore: checkpoint.status !== "restored" && (
            checkpoint.beforeContent !== null ||
            checkpoint.afterContent !== null ||
            checkpoint.toolCall?.name === "rename_file" ||
            checkpoint.toolCall?.name === "mkdir"
          )
        }))
      }
    };
  });

  // ------------------------------------------------------------------------
  // Detachable runs — live re-attach.
  //
  // GET /agent/runs/:id/stream?since=<seq> replays everything the caller
  // missed from the live-run broker (events with seq > since) and then
  // tails the run live. Disconnect here is CLEANUP ONLY — it never aborts
  // the run. A run that already finished (terminal status, and its 5-minute
  // broker buffer is empty or gone) answers 409 { code: "RUN_NOT_LIVE" } —
  // clients should fall back to GET /agent/runs/:id for the final record.
  // ------------------------------------------------------------------------
  const reattachQuerySchema = z.object({
    since: z.coerce.number().int().min(0).default(0)
  });

  app.get("/agent/runs/:id/stream", async (request, reply) => {
    const parsedParams = agentRunParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ message: "Invalid params", issues: parsedParams.error.issues });
    }
    const parsedQuery = reattachQuerySchema.safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      return reply.code(400).send({ message: "Invalid query", issues: parsedQuery.error.issues });
    }

    const user = await getLocalUser();
    const run = await assertAgentRunOwner(user.id, parsedParams.data.id);
    if (!run) {
      return reply.code(404).send({ message: "Agent run not found" });
    }

    const bufferInfo = getRunBufferInfo(run.id);
    const mode = resolveReattachMode(run.status, bufferInfo, ACTIVE_RUN_STATUSES);
    if (mode === "reject") {
      return reply.code(409).send({ code: "RUN_NOT_LIVE" });
    }

    // The handler stays blocked on this promise while it replays + tails;
    // it resolves when the stream is over (done/error delivered, client
    // gone, or a failed write) so Fastify's lifecycle stays correct.
    await new Promise<void>((resolve) => {
      let finished = false;
      // finish() can fire while the synchronous replay inside
      // subscribeRunEvents is still running (terminal run replaying through
      // its done event) — BEFORE the const holding the unsubscribe function
      // is initialized. Plain object properties (undefined until assigned)
      // avoid that TDZ hazard.
      const handles: { keepalive?: NodeJS.Timeout; unsubscribe?: () => void } = {};

      const canWrite = () => !reply.raw.writableEnded && !reply.raw.destroyed;

      const finish = () => {
        if (finished) return;
        finished = true;
        if (handles.keepalive) clearInterval(handles.keepalive);
        handles.unsubscribe?.();
        request.raw.removeListener("close", onRequestClose);
        reply.raw.removeListener("close", onResponseClose);
        resolve();
      };

      // Disconnect handlers are CLEANUP ONLY — they never abort the run.
      const onRequestClose = () => finish();
      const onResponseClose = () => finish();
      request.raw.once("close", onRequestClose);
      reply.raw.once("close", onResponseClose);

      // First write opens the SSE response with a re-attach marker so the
      // client can distinguish it from the original stream's start event.
      sendSseEvent(reply, request, {
        type: "start",
        runId: run.id,
        conversationId: run.conversationId,
        reattached: true
      });

      handles.keepalive = setInterval(() => {
        if (canWrite()) reply.raw.write(": ping\n\n");
      }, 25_000);

      handles.unsubscribe = subscribeRunEvents(run.id, parsedQuery.data.since, (brokered) => {
        if (finished) return;
        if (!canWrite()) {
          console.warn(`[agent] re-attach stream for run ${run.id}: client gone — detaching listener`);
          finish();
          return;
        }
        reply.raw.write(`data: ${JSON.stringify(brokered.event)}\n\n`);
        // done/error are the run's terminal broker events (published by the
        // stream route right before it closes the buffer) — end the stream
        // after delivering one instead of hanging on keepalive pings.
        const eventType = typeof brokered.event.type === "string" ? brokered.event.type : undefined;
        if (eventType === "done" || eventType === "error") {
          finish();
        }
      });
      // finish() may have run during the synchronous replay above (replay
      // hit done/error before subscribeRunEvents returned) — it could not
      // unsubscribe then (handle not yet assigned), so do it here.
      if (finished) handles.unsubscribe?.();

      // Terminal run: end after the synchronous replay even when the buffer
      // window did not include a done/error event (e.g. `since` beyond
      // lastSeq, or a run that terminated before any terminal event was
      // brokered). The client falls back to GET /agent/runs/:id.
      if (mode === "stream-and-end" && !finished) {
        finish();
      }
    });

    reply.raw.end();
    return reply;
  });

  // ------------------------------------------------------------------------
  // Item 3 — worktree lifecycle endpoints.
  //
  // A run that executed inside a dedicated git worktree keeps its
  // {branch, path, originalRoot, status} metadata on the run row. These
  // endpoints let the user merge the branch back into the original
  // checkout or discard the worktree entirely. Ownership follows the
  // assertRunAccess pattern (agent-control.ts): the run row must belong
  // to a conversation owned by the current user.
  // ------------------------------------------------------------------------
  const ACTIVE_RUN_STATUS_SET = new Set<string>(ACTIVE_RUN_STATUSES);

  app.post("/agent/runs/:id/worktree/merge", async (request, reply) => {
    return handleWorktreeAction(app, request, reply, "merge", ACTIVE_RUN_STATUS_SET);
  });

  app.post("/agent/runs/:id/worktree/discard", async (request, reply) => {
    return handleWorktreeAction(app, request, reply, "discard", ACTIVE_RUN_STATUS_SET);
  });

  // ------------------------------------------------------------------------
  // P2-E: rollback / checkpoint UI surface.
  //
  // The existing `/agent/runs/:id` endpoint already returns the checkpoints
  // for a run, and `/agent/checkpoints/:id/restore` (below) executes the
  // rollback. This block adds:
  //   - `GET /agent/checkpoints`     — list checkpoints across runs
  //   - `GET /agent/checkpoints/:id/preview` — show the diff before restoring
  // ------------------------------------------------------------------------
  app.get("/agent/checkpoints", async (request, reply) => {
    const parsed = checkpointListSchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid query", issues: parsed.error.issues });
    }
    const user = await getLocalUser();
    const where: Record<string, unknown> = {
      run: { conversation: { userId: user.id } }
    };
    if (parsed.data.workspaceId) where.workspaceId = parsed.data.workspaceId;
    if (parsed.data.runId) where.runId = parsed.data.runId;
    if (parsed.data.status) where.status = parsed.data.status;

    const [items, total] = await Promise.all([
      prisma.agentCheckpoint.findMany({
        where,
        include: {
          toolCall: { select: { name: true, status: true } },
          run: { select: { id: true, status: true, conversationId: true, startedAt: true } }
        },
        orderBy: { createdAt: "desc" },
        take: parsed.data.limit,
        skip: parsed.data.offset
      }),
      prisma.agentCheckpoint.count({ where })
    ]);

    return {
      items: items.map((c) => ({
        id: c.id,
        runId: c.runId,
        stepId: c.stepId,
        toolCallId: c.toolCallId,
        path: c.path,
        status: c.status,
        diffPreview: c.diffPreview,
        restoreNote: c.restoreNote,
        restoredAt: c.restoredAt,
        createdAt: c.createdAt,
        toolCall: c.toolCall ? { name: c.toolCall.name, status: c.toolCall.status } : null,
        run: c.run
      })),
      total,
      limit: parsed.data.limit,
      offset: parsed.data.offset
    };
  });

  app.get("/agent/checkpoints/:id/preview", async (request, reply) => {
    const parsed = checkpointParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid params", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const checkpoint = await prisma.agentCheckpoint.findFirst({
      where: {
        id: parsed.data.id,
        run: { conversation: { userId: user.id } }
      },
      include: { toolCall: true, run: true }
    });

    if (!checkpoint) {
      return reply.code(404).send({ message: "Checkpoint not found" });
    }

    return {
      id: checkpoint.id,
      path: checkpoint.path,
      status: checkpoint.status,
      canRestore: checkpoint.status !== "restored",
      diffPreview: checkpoint.diffPreview,
      beforeContent: checkpoint.beforeContent,
      afterContent: checkpoint.afterContent,
      toolCall: checkpoint.toolCall
        ? { name: checkpoint.toolCall.name, parameters: checkpoint.toolCall.parameters }
        : null,
      run: checkpoint.run
        ? { id: checkpoint.run.id, conversationId: checkpoint.run.conversationId }
        : null,
      // The preview is a read-only operation; we don't make any filesystem
      // changes. The actual restore is a separate POST.
      previewOnly: true
    };
  });

  app.post("/agent/checkpoints/:id/restore", async (request, reply) => {
    const parsed = checkpointParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid params", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const checkpoint = await prisma.agentCheckpoint.findFirst({
      where: {
        id: parsed.data.id,
        run: { conversation: { userId: user.id } }
      },
      include: {
        workspace: true,
        run: {
          include: {
            workspace: true
          }
        },
        toolCall: {
          select: {
            id: true,
            name: true,
            parameters: true,
            resultData: true
          }
        }
      }
    });

    if (!checkpoint) {
      return reply.code(404).send({ message: "Checkpoint not found" });
    }

    if (checkpoint.status === "restored") {
      return reply.code(409).send({ message: "Checkpoint has already been restored" });
    }

    // P2-E: destructive checkpoints (deletions, renames, mkdir removals)
    // require the caller to send a typed confirmation. This mirrors the
    // pattern in `dangerous-patterns.ts` — the user has to type a short
    // string acknowledging the action before the server proceeds.
    const isDestructiveCheckpoint = checkpoint.toolCall?.name === "delete_file"
      || checkpoint.toolCall?.name === "delete_directory"
      || (checkpoint.toolCall?.name === "rename_file" && !checkpoint.beforeContent)
      || (checkpoint.toolCall?.name === "write_file" && !checkpoint.beforeContent && checkpoint.afterContent === null);
    if (isDestructiveCheckpoint) {
      const body = (request.body ?? {}) as { confirmation?: string };
      const expected = "RESTORE";
      if (body.confirmation !== expected) {
        return reply.code(400).send({
          message: `Restoring this checkpoint will discard current file content. ` +
            `Send { confirmation: "${expected}" } in the request body to confirm.`,
          requiresConfirmation: true,
          expectedConfirmation: expected
        });
      }
    }

    try {
      const { workspacePath, fullPath } = await resolveCheckpointRestorePath(checkpoint);
      const restoreNote = checkpoint.toolCall?.name === "rename_file"
        ? await restoreRenameCheckpoint({ workspacePath, checkpointPath: checkpoint.path, toolCall: checkpoint.toolCall })
        : checkpoint.toolCall?.name === "mkdir"
          ? await restoreMkdirCheckpoint(fullPath)
          : await restoreTextCheckpoint({
              fullPath,
              beforeContent: checkpoint.beforeContent,
              afterContent: checkpoint.afterContent
            });

      const restored = await prisma.agentCheckpoint.update({
        where: { id: checkpoint.id },
        data: {
          status: "restored",
          restoredAt: new Date(),
          restoreNote
        }
      });

      return {
        ok: true,
        checkpoint: {
          id: restored.id,
          status: restored.status,
          restoredAt: restored.restoredAt,
          restoreNote: restored.restoreNote
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to restore checkpoint";
      return reply.code(409).send({ message });
    }
  });

  app.post("/agent/approvals", async (request, reply) => {

    const parsed = approvalDecisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const pending = pendingToolApprovals.get(parsed.data.approvalId);
    if (!pending) {
      return reply.code(404).send({ message: "Approval request was not found or has expired" });
    }

    if (pending.userId !== user.id) {
      return reply.code(403).send({ message: "Approval request does not belong to this user" });
    }

    pending.resolve({
      approved: parsed.data.approved,
      message: parsed.data.message
    });

    return {
      ok: true,
      approvalId: parsed.data.approvalId,
      approved: parsed.data.approved
    };
  });

  // Pending approvals for the current user (optionally scoped to a
  // conversation). The frontend polls this when a conversation loads so a
  // page reload mid-approval re-presents the prompt instead of orphaning
  // the blocked run (audit M2.2).
  app.get("/agent/approvals/pending", async (request, reply) => {
    const schema = z.object({ conversationId: z.string().min(1).optional() });
    const parsed = schema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid query", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const approvals = listPendingApprovals(user.id, parsed.data.conversationId);
    return { approvals };
  });

  // Auto-approve pattern management routes
  app.get("/agent/auto-approve-patterns", async () => {
    const user = await getLocalUser();
    const patterns = await prisma.autoApprovePattern.findMany({
      where: { userId: user.id },
      orderBy: [{ scope: "desc" }, { updatedAt: "desc" }]
    });
    return { patterns };
  });

  // ------------------------------------------------------------------------
  // P2-A / P2-B: dangerous-command pattern analysis.
  //
  // The frontend calls this before showing the user an approval dialog, so
  // the dialog can display the plain-language explanation alongside the
  // raw command. The server-side tool orchestrator performs the same check
  // before any shell tool executes — this endpoint is the read-only mirror.
  // ------------------------------------------------------------------------
  app.post("/agent/command-risk", async (request, reply) => {
    const schema = z.object({
      command: z.string().min(1).max(20_000)
    });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }
    return analyseCommandRisk(parsed.data.command);
  });

  app.get("/agent/dangerous-patterns", async () => {
    return {
      patterns: getDangerousPatterns().map((p) => ({
        id: p.id,
        severity: p.severity,
        label: p.label,
        explanation: p.explanation,
        consequence: p.consequence
      })),
      ids: getDangerousPatternIds()
    };
  });

  // ------------------------------------------------------------------------
  // P2-C: read the current memory budget configuration.
  // The threshold is a per-call override on the AgentConfig; this endpoint
  // surfaces the env-derived defaults so the UI can show them and let the
  // user tune the per-call override.
  // ------------------------------------------------------------------------
  app.get("/agent/memory-budget", async () => {
    return {
      defaults: {
        toolResultCharLimit: Number(process.env.TOOL_OUTPUT_MAX_CHARS ?? 50_000),
        messageCharLimit: Number(process.env.PROVIDER_MESSAGE_CHAR_LIMIT ?? 24_000),
        historyCharBudget: Number(process.env.PROVIDER_HISTORY_CHAR_BUDGET ?? 90_000),
        compactionThreshold: Number(process.env.MEMORY_COMPACTION_THRESHOLD ?? 75)
      },
      // When set on the request, the agent config can override the defaults.
      // Surfacing both lets the UI display a "what the agent will actually
      // use" preview before sending the request.
      overridable: true
    };
  });

  app.post("/agent/auto-approve-patterns", async (request, reply) => {
    const schema = z.object({
      id: z.string().optional(),
      name: z.string().min(1),
      pattern: z.string().min(1),
      matchType: z.enum(["exact", "prefix", "wildcard", "regex"]).default("exact"),
      toolName: z.string().optional(),
      scope: z.enum(["global", "workspace", "conversation"]).default("workspace"),
      enabled: z.boolean().default(true),
      workspaceId: z.string().nullable().optional(),
      conversationId: z.string().nullable().optional()
    });

    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const data = parsed.data;

    if (data.id && !(await isOwnedByUser("autoApprovePattern", data.id, user.id))) {
      return reply.code(404).send({ message: "Pattern not found" });
    }

    const pattern = data.id
      ? await prisma.autoApprovePattern.update({
          where: { id: data.id },
          data: {
            name: data.name,
            pattern: data.pattern,
            matchType: data.matchType,
            toolName: data.toolName ?? null,
            scope: data.scope,
            enabled: data.enabled,
            workspaceId: data.workspaceId ?? null,
            conversationId: data.conversationId ?? null
          }
        })
      : await prisma.autoApprovePattern.create({
          data: {
            userId: user.id,
            name: data.name,
            pattern: data.pattern,
            matchType: data.matchType,
            toolName: data.toolName ?? null,
            scope: data.scope,
            enabled: data.enabled,
            workspaceId: data.workspaceId ?? null,
            conversationId: data.conversationId ?? null
          }
        });

    return { pattern };
  });

  app.delete("/agent/auto-approve-patterns/:id", async (request, reply) => {
    const schema = z.object({ id: z.string().min(1) });
    const parsed = schema.safeParse(request.params ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid parameters" });
    }

    const user = await getLocalUser();
    const pattern = await prisma.autoApprovePattern.findFirst({
      where: {
        id: parsed.data.id,
        userId: user.id
      }
    });

    if (!pattern) {
      return reply.code(404).send({ message: "Pattern not found" });
    }

    await prisma.autoApprovePattern.delete({
      where: { id: parsed.data.id }
    });

    return { ok: true };
  });

  // ------------------------------------------------------------------------
  // Item 5 — lifecycle hook management. Hooks fire shell commands / HTTP
  // POSTs on agent events (tools/tool/call, tools/tool/result,
  // agent/turn/end). Dispatch itself is fire-soft (lib/hooks.ts).
  // ------------------------------------------------------------------------
  app.get("/agent/hooks", async () => {
    const user = await getLocalUser();
    const hooks = await prisma.agentHook.findMany({
      where: { userId: user.id },
      orderBy: [{ createdAt: "asc" }]
    });
    return { hooks };
  });

  app.post("/agent/hooks", async (request, reply) => {
    const parsed = upsertAgentHookSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const data = parsed.data;

    if (data.id && !(await isOwnedByUser("agentHook", data.id, user.id))) {
      return reply.code(404).send({ message: "Hook not found" });
    }

    const hookData = {
      name: data.name,
      event: data.event,
      matchTool: data.matchTool ?? null,
      action: data.action,
      target: data.target,
      timeoutMs: data.timeoutMs,
      enabled: data.enabled
    };

    const hook = data.id
      ? await prisma.agentHook.update({
          where: { id: data.id },
          data: hookData
        })
      : await prisma.agentHook.create({
          data: {
            userId: user.id,
            ...hookData
          }
        });

    return { hook };
  });

  app.delete("/agent/hooks/:id", async (request, reply) => {
    const parsed = hookParamsSchema.safeParse(request.params ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid parameters" });
    }

    const user = await getLocalUser();
    const hook = await prisma.agentHook.findFirst({
      where: {
        id: parsed.data.id,
        userId: user.id
      }
    });

    if (!hook) {
      return reply.code(404).send({ message: "Hook not found" });
    }

    await prisma.agentHook.delete({
      where: { id: parsed.data.id }
    });

    return { ok: true };
  });

  app.post("/agent/execute", async (request, reply) => {
    const parsed = agentRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    let requestInfo: PreparedAgentRequest | undefined;
    let userPromptMessage: Awaited<ReturnType<typeof storeUserPrompt>> | undefined;
    let agent: Agent | undefined;
    let finalResultPersisted = false;

    try {
      requestInfo = await prepareAgentRequest(parsed.data);
      userPromptMessage = await storeUserPrompt(requestInfo);
      agent = createAgent(requestInfo);
      const result = await agent.run(requestInfo.payload.prompt);
      const tokenUsage = agent.getTokenUsage();
      const persisted = await storeAssistantResponse(
        requestInfo,
        userPromptMessage.id,
        result.response,
        result.steps,
        tokenUsage,
        result.status
      );
      finalResultPersisted = true;
      if (!persisted.assistantMessage) {
        throw new Error("Completed agent run is missing the persisted assistant message.");
      }

      await recordUsage({
        userId: requestInfo.userId,
        provider: requestInfo.provider,
        model: requestInfo.model,
        mode: requestInfo.payload.mode,
        tokenUsage,
      });

      if (requestInfo.isNewConversation) {


        queueConversationTitleGeneration(app, requestInfo);
      }
      queueConversationSummaryRefresh(app, requestInfo);

      return {

        conversationId: requestInfo.conversationId,
        response: result.response,
        steps: result.steps,
        iterations: result.steps.length,
        tokenUsage,
        agentRunId: persisted.run.id,
        assistantMessageId: persisted.assistantMessage.id
      };


    } catch (error) {
      if (!finalResultPersisted && requestInfo && userPromptMessage) {
        await storeInterruptedRun(
          requestInfo,
          userPromptMessage.id,
          agent?.getSteps() ?? [],
          error instanceof Error ? error.message : "Unknown error"
        ).catch((persistError) => {
          app.log.warn({ err: persistError, conversationId: requestInfo?.conversationId }, "Failed to persist interrupted agent run");
        });
      }
      const httpError = toHttpError(error);
      return reply.code(httpError.statusCode).send({
        message: httpError.message,
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  app.post("/agent/execute/stream", async (request, reply) => {
    const parsed = agentRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    let requestInfo: PreparedAgentRequest | undefined;
    let userPromptMessage: Awaited<ReturnType<typeof storeUserPrompt>> | undefined;
    let agent: Agent | undefined;
    let finalResultPersisted = false;
    let agentRunId: string | undefined;
    // Detachable runs: a client disconnect does NOT abort the run — it
    // detaches. The run keeps executing server-side, persists each step
    // incrementally (persistRunStepIncremental), keeps streaming into the
    // live-run broker, and can be re-attached later via
    // GET /agent/runs/:id/stream?since=<seq>. Explicit aborts go through
    // the exit-hatch (agent-control routes) — those still terminate
    // detached runs. No disconnect signal is passed to agent.stream().
    let clientAttached = true;
    const onClientDisconnect = () => {
      clientAttached = false;
      console.warn(`[agent] client detached from run ${agentRunId ?? "(unassigned)"} — run continues in background`);
    };
    request.raw.once("close", onClientDisconnect);
    // SSE keepalive: agent runs can be silent for minutes during tool
    // execution; without pings, proxies and browsers kill the connection.
    let keepalive: NodeJS.Timeout | undefined;
    // Every SSE write is guarded: a detached client's socket must never be
    // written to (the run itself continues regardless).
    const canWriteToClient = () => clientAttached && !reply.raw.writableEnded && !reply.raw.destroyed;

    try {
      requestInfo = await prepareAgentRequest(parsed.data);
      userPromptMessage = await storeUserPrompt(requestInfo);
      const currentRequestInfo = requestInfo;
      agentRunId = await startAgentRun({
        conversationId: currentRequestInfo.conversationId,
        workspaceId: currentRequestInfo.workspaceId ?? undefined,
        triggerMessageId: userPromptMessage.id,
        provider: currentRequestInfo.provider,
        model: currentRequestInfo.model,
        mode: currentRequestInfo.payload.mode,
        prompt: currentRequestInfo.payload.prompt,
        reasoningEffort: currentRequestInfo.reasoningEffort,
        worktreeInfo: currentRequestInfo.worktreeInfo
      }).catch((error) => {
        app.log.warn({ err: error }, "Failed to create run row at start; controls will 409 for this run");
        return undefined;
      });
      agent = createAgent(currentRequestInfo, (approvalRequest) =>
        handleToolApproval(currentRequestInfo.userId, currentRequestInfo.workspaceId, currentRequestInfo.conversationId, approvalRequest)
      );

      let started = false;

      let finalEvent: Extract<AgentExecutionEvent, { type: "done" }> | null = null;

      const promptContent = (() => {
        const { prompt, attachments } = requestInfo.payload;
        if (!attachments || attachments.length === 0) return prompt;

        const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
        for (const attachment of attachments) {
          if (attachment.kind === "image" && attachment.dataUrl) {
            content.push({ type: "image_url", image_url: { url: attachment.dataUrl } });
          } else {
            content.push({ type: "text", text: `[Attachment included but unsupported in agent: ${attachment.name}]` });
          }
        }
        return content;
      })();

      for await (const event of agent.stream(promptContent, {
        runId: agentRunId
      })) {
        // Broker first: buffer the event (with its seq) BEFORE any SSE write
        // so a re-attach replay never misses what live clients saw. The done
        // event is published later — enriched with the persisted message/run
        // ids — right before its final write below.
        let seq: number | undefined;
        if (agentRunId && event.type !== "done") {
          seq = publishRunEvent(agentRunId, event);
        }

        if (event.type === "step" && agentRunId && requestInfo) {
          // Incremental persistence — fire-and-forget: a failed mid-run
          // write must never break the stream; the final persistAgentRun
          // pass remains the source of truth. The step event carries the
          // full step (tool calls + results in index order), so it is the
          // single source for the incremental pass.
          const runIdForPersist: string = agentRunId;
          const conversationIdForPersist: string = requestInfo.conversationId;
          const { step } = event;
          persistRunStepIncremental({
            runId: runIdForPersist,
            conversationId: conversationIdForPersist,
            step: {
              iteration: step.iteration,
              reasoning: step.reasoning,
              response: step.response,
              timestamp: step.timestamp
            },
            toolCalls: step.toolCalls.map((call, index) => ({
              call,
              result: step.toolResults[index]
            }))
          }).catch((persistError) => {
            console.warn(
              `[agent] incremental step persist failed for run ${runIdForPersist}: ${persistError instanceof Error ? persistError.message : String(persistError)}`
            );
          });
        }

        if (!started) {
          started = true;
          keepalive = setInterval(() => {
            if (canWriteToClient()) reply.raw.write(": ping\n\n");
          }, 25_000);
          if (canWriteToClient()) {
            sendSseEvent(reply, request, seq !== undefined ? { ...event, seq } : event);
          }
          continue;
        }

        if (event.type === "done") {
          finalEvent = event;
          continue;
        }

        if (canWriteToClient()) {
          writeSseEvent(reply, seq !== undefined ? { ...event, seq } : event);
        }
      }

      if (!started) {
        // Zero events yielded — still announce the conversation so the
        // client can correlate (guarded; the error path reports the rest).
        if (canWriteToClient()) {
          sendSseEvent(reply, request, {
            type: "start",
            conversationId: requestInfo.conversationId,
            model: requestInfo.model
          });
        }
      }

      if (!finalEvent) {
        throw new Error("Agent stream ended without a final result");
      }

      const persisted = await storeAssistantResponse(
        requestInfo,
        userPromptMessage.id,
        finalEvent.response,
        finalEvent.steps,
        agent.getTokenUsage(),
        finalEvent.status,
        finalEvent.elapsedMs,
        agentRunId
      );
      finalResultPersisted = true;
      if (!persisted.assistantMessage) {
        throw new Error("Completed streamed agent run is missing the persisted assistant message.");
      }

      await recordUsage({
        userId: requestInfo.userId,
        provider: requestInfo.provider,
        model: requestInfo.model,
        mode: requestInfo.payload.mode,
        tokenUsage: agent.getTokenUsage(),
      });

      const persistedFinalEvent: AgentExecutionEvent = {
        ...finalEvent,
        agentRunId: persisted.run.id,
        assistantMessageId: persisted.assistantMessage.id,
        // Item 3 — surface the run's worktree so the UI can offer
        // merge/discard/open. Kept on the run row too (never auto-removed).
        ...(requestInfo.worktreeInfo
          ? { worktree: { branch: requestInfo.worktreeInfo.branch, path: requestInfo.worktreeInfo.path } }
          : {})
      };

      if (requestInfo.isNewConversation) {
        queueConversationTitleGeneration(app, requestInfo);
      }
      queueConversationSummaryRefresh(app, requestInfo);
      // Publish the ENRICHED done event (with the persisted ids and its seq)
      // so a re-attach replay ends with the same final event live clients
      // received, then close the run's buffer after the write attempt.
      const doneSeq = agentRunId ? publishRunEvent(agentRunId, persistedFinalEvent) : undefined;
      if (canWriteToClient()) {
        writeSseEvent(reply, doneSeq !== undefined ? { ...persistedFinalEvent, seq: doneSeq } : persistedFinalEvent);
      }
      if (agentRunId) closeRunEvents(agentRunId);


    } catch (error) {
      // Re-attached clients learn about the failure through the broker even
      // when no SSE write is possible (client gone / headers not sent), and
      // the buffer close lets re-attach replays terminate.
      const errorMessage = error instanceof Error ? error.message : "Stream failed";
      if (agentRunId) {
        const errorSeq = publishRunEvent(agentRunId, { type: "error", message: errorMessage });
        if (reply.raw.headersSent && canWriteToClient()) {
          writeSseEvent(reply, { type: "error", message: errorMessage, seq: errorSeq });
        }
        closeRunEvents(agentRunId);
      }

      if (!finalResultPersisted && requestInfo && userPromptMessage) {
        await storeInterruptedRun(
          requestInfo,
          userPromptMessage.id,
          agent?.getSteps() ?? [],
          errorMessage,
          agentRunId
        ).catch((persistError) => {
          app.log.warn({ err: persistError, conversationId: requestInfo?.conversationId }, "Failed to persist interrupted streamed agent run");
        });
      }
      if (!reply.raw.headersSent) {
        const httpError = toHttpError(error);
        return reply.code(httpError.statusCode).send({
          message: httpError.message,
          error: errorMessage
        });
      }
    } finally {
      if (keepalive) clearInterval(keepalive);
      request.raw.removeListener("close", onClientDisconnect);
      // Idempotent: a no-op when the done/catch path already closed it.
      if (agentRunId) closeRunEvents(agentRunId);
    }

    reply.raw.end();
    return reply;
  });
}
// TypeScript server refresh
