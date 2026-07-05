import type { FastifyInstance } from "fastify";
import JSZip from "jszip";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { z } from "zod";
import {
  buildAssistantMemoryText,
  buildConversationMemoryMessage,
  buildUserMemoryText,
  loadConversationMemory,
  refreshConversationSummary,
  serializeMessageMetadata,
  type PersistedAttachmentMemory,
  type PersistedMessageMetadata
} from "../lib/conversation-memory.js";

import { getDefaultBaseUrl, getDefaultModels } from "../lib/constants.js";

import { decryptText, encryptText } from "../lib/crypto.js";
import { prisma, getLocalUser } from "../lib/db.js";
import { recordUsage } from "../lib/usage.js";
import { translateReasoning } from "../lib/agent/reasoning-translator.js";


const attachmentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["image", "file"]),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  dataUrl: z.string().optional(),
  textContent: z.string().optional()
});

const chatSchema = z.object({
  prompt: z.string().min(1),
  provider: z.string().default("gemini"),
  model: z.string().optional(),
  conversationId: z.string().optional(),
  workspaceId: z.string().optional(),
  attachments: z.array(attachmentSchema).optional(),
  mode: z.enum(["chat", "agent"]).default("chat"),
  // Reasoning / thinking-mode depth. Translated to the right parameter
  // shape for the active provider (see server/src/lib/agent/reasoning-translator.ts).
  // "off" suppresses the setting entirely so the provider uses its own default.
  reasoningEffort: z.enum(["off", "low", "medium", "high", "max"]).optional()
});

type ChatRequestPayload = z.infer<typeof chatSchema>;

type ProviderTokenUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

type ChatCompletionResponse = {

  choices?: Array<{ message?: { content?: string } }>;
  usage?: ProviderTokenUsage;
};

type StreamDeltaResponse = {
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: ProviderTokenUsage | null;
};

type ChatInteractivePayload = (
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
      sourceConversationId?: string;
      approveLabel?: string;
      cancelLabel?: string;
    }
);

type LegacyBundle = {
  keys: Array<{ id: string; name: string; key: string }>;
  activeKeyId?: string;
  autoSwitchApiKey: boolean;
};

type KeyRecord = {
  id: string;
  name: string;
  apiKeyEncrypted: string;
  isActive: boolean;
};

type ApiKeySwitchInfo = {
  fromKeyName: string;
  toKeyName: string;
};

function providerAllowsKeylessAccess(provider: string) {
  return provider === "ollama";
}

const DEFAULT_LLM_TIMEOUT_MS = 180000;

function parseLegacyBundle(raw: string): LegacyBundle {
  try {
    const parsed = JSON.parse(raw) as {
      version?: number;
      keys?: Array<{ id?: string; name?: string; key?: string }>;
      activeKeyId?: string;
      autoSwitchApiKey?: boolean;
    };

    if (parsed.version === 1 && Array.isArray(parsed.keys)) {
      const keys = parsed.keys
        .map((item) => ({
          id: typeof item.id === "string" && item.id.trim() ? item.id : crypto.randomUUID(),
          name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "API Key",
          key: typeof item.key === "string" ? item.key : ""
        }))
        .filter((item) => item.key.length > 0);

      const activeKeyId = typeof parsed.activeKeyId === "string" ? parsed.activeKeyId : undefined;

      return {
        keys,
        activeKeyId: keys.some((item) => item.id === activeKeyId) ? activeKeyId : keys[0]?.id,
        autoSwitchApiKey: Boolean(parsed.autoSwitchApiKey)
      };
    }
  } catch {
    // Fallback to old single key format
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      keys: [],
      activeKeyId: undefined,
      autoSwitchApiKey: false
    };
  }

  return {
    keys: [{ id: crypto.randomUUID(), name: "Primary key", key: trimmed }],
    activeKeyId: undefined,
    autoSwitchApiKey: false
  };
}

async function getSettingWithKeys(userId: string, provider: string) {
  return prisma.providerSetting.findUnique({
    where: {
      userId_provider: {
        userId,
        provider
      }
    },
    include: {
      apiKeys: {
        orderBy: { createdAt: "asc" }
      }
    }
  });
}

async function getOrCreateProviderSetting(userId: string, provider: string) {
  const existing = await getSettingWithKeys(userId, provider);
  if (existing || !providerAllowsKeylessAccess(provider)) {
    return existing;
  }

  return prisma.providerSetting.create({
    data: {
      userId,
      provider,
      enabled: true,
      baseUrl: getDefaultBaseUrl(provider),
      models: getDefaultModels(provider),
      autoSwitchApiKey: false
    },
    include: {
      apiKeys: {
        orderBy: { createdAt: "asc" }
      }
    }
  });
}

async function materializeLegacyKeys(userId: string, provider: string, secret: string) {
  const setting = await getSettingWithKeys(userId, provider);
  if (!setting || setting.apiKeys.length > 0 || !setting.apiKeyEncrypted) {
    return setting;
  }

  let decrypted: string;
  try {
    decrypted = decryptText(setting.apiKeyEncrypted, secret);
  } catch {
    return setting;
  }

  const legacy = parseLegacyBundle(decrypted);
  if (legacy.keys.length === 0) {
    return setting;
  }

  const activeId = legacy.keys.some((item) => item.id === legacy.activeKeyId)
    ? legacy.activeKeyId
    : legacy.keys[0]?.id;

  await prisma.$transaction(async (tx) => {
    for (let index = 0; index < legacy.keys.length; index += 1) {
      const key = legacy.keys[index];
      await tx.providerApiKey.create({
        data: {
          id: key.id,
          providerSettingId: setting.id,
          name: key.name,
          apiKeyEncrypted: encryptText(key.key, secret),
          isActive: key.id === activeId
        }
      });
    }

    await tx.providerSetting.update({
      where: { id: setting.id },
      data: {
        autoSwitchApiKey: legacy.autoSwitchApiKey
      }
    });
  });

  return getSettingWithKeys(userId, provider);
}

function listKeysInPriority(keys: KeyRecord[]) {
  if (keys.length === 0) return [] as KeyRecord[];

  const active = keys.find((item) => item.isActive) ?? keys[0];
  const others = keys.filter((item) => item.id !== active.id);

  return [active, ...others];
}

function shouldAutoFallback(status: number, details?: string) {
  const normalizedDetails = (details ?? "").toLowerCase();
  const isCreditOrQuotaError =
    normalizedDetails.includes("credits") ||
    normalizedDetails.includes("depleted") ||
    normalizedDetails.includes("insufficient balance") ||
    normalizedDetails.includes("quota") ||
    normalizedDetails.includes("limit reached") ||
    normalizedDetails.includes("payment required") ||
    normalizedDetails.includes("billing");

  return status === 401 || status === 402 || status === 403 || status === 429 || (status === 400 && isCreditOrQuotaError);
}

function getConfiguredLlmTimeoutMs() {
  const configured = Number.parseInt(process.env.AGENT_LLM_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(configured) && configured >= 30000) {
    return configured;
  }
  return DEFAULT_LLM_TIMEOUT_MS;
}

function isTimeoutError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith("LLM call timed out after");
}

async function fetchWithLlmTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`LLM call timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function tryDecryptApiKey(apiKeyEncrypted: string, secret: string) {
  try {
    return decryptText(apiKeyEncrypted, secret);
  } catch {
    return null;
  }
}

type UploadedAttachment = {

  id: string;
  kind: "image" | "file";
  name: string;
  mimeType: string;
  dataUrl?: string;
  textContent?: string;
};

type PreparedUserPrompt = {
  modelContent: string | Array<Record<string, unknown>>;
  storedContent: string;
  memoryText: string;
  metadata: PersistedMessageMetadata;
};

function buildStoredUserContent(prompt: string, attachments?: UploadedAttachment[]) {

  if (!attachments || attachments.length === 0) return prompt;

  const names = attachments.map((item) => item.name).join(", ");
  return `${prompt}\n\n[Attachments] ${names}`;
}

function decodeDataUrlToBuffer(dataUrl?: string) {
  if (!dataUrl) return null;

  const match = dataUrl.match(/^data:.*?;base64,(.*)$/);
  if (!match) return null;

  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}

const SUPPORTED_EMBEDDED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const OCR_MAX_IMAGES_PER_DOC = 2;
const OCR_MAX_CHARS_PER_IMAGE = 2000;

async function extractTextFromImageDataUrl(dataUrl: string) {
  try {
    const tesseract = await import("tesseract.js");
    const result = await tesseract.recognize(dataUrl, "eng");
    const text = result.data?.text?.trim();
    return text ? text.slice(0, OCR_MAX_CHARS_PER_IMAGE) : null;
  } catch {
    return null;
  }
}

function extensionToImageMime(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return null;
}

async function extractEmbeddedImagesFromOfficeFile(attachment: UploadedAttachment) {
  const mime = attachment.mimeType.toLowerCase();
  const name = attachment.name.toLowerCase();

  const mediaPathPrefix =
    mime.includes("wordprocessingml") || name.endsWith(".docx")
      ? "word/media/"
      : mime.includes("presentationml") || name.endsWith(".pptx")
        ? "ppt/media/"
        : mime.includes("spreadsheetml") || name.endsWith(".xlsx")
          ? "xl/media/"
          : null;

  if (!mediaPathPrefix) return [] as string[];

  const buffer = decodeDataUrlToBuffer(attachment.dataUrl);
  if (!buffer) return [] as string[];

  try {
    const zip = await JSZip.loadAsync(buffer);
    const imageEntries = Object.values(zip.files)
      .filter((entry) => !entry.dir && entry.name.startsWith(mediaPathPrefix))
      .filter((entry) => {
        const lower = entry.name.toLowerCase();
        for (const ext of SUPPORTED_EMBEDDED_IMAGE_EXTENSIONS) {
          if (lower.endsWith(ext)) return true;
        }
        return false;
      })
      .slice(0, 6);

    const dataUrls: string[] = [];

    for (const entry of imageEntries) {
      const mimeType = extensionToImageMime(entry.name);
      if (!mimeType) continue;

      const base64 = await entry.async("base64");
      if (!base64) continue;

      dataUrls.push(`data:${mimeType};base64,${base64}`);
    }

    return dataUrls;
  } catch {
    return [] as string[];
  }
}



async function extractAttachmentText(attachment: UploadedAttachment) {
  if (attachment.textContent?.trim()) {
    return attachment.textContent.trim();
  }

  const buffer = decodeDataUrlToBuffer(attachment.dataUrl);
  if (!buffer) {
    return null;
  }

  const mime = attachment.mimeType.toLowerCase();
  const name = attachment.name.toLowerCase();

  if (mime.includes("pdf") || name.endsWith(".pdf")) {
    try {
      const parsed = await pdfParse(buffer);
      return parsed.text?.trim() || null;
    } catch {
      return null;
    }
  }

  if (
    mime.includes("wordprocessingml") ||
    mime.includes("msword") ||
    name.endsWith(".docx") ||
    name.endsWith(".doc")
  ) {
    try {
      const parsed = await mammoth.extractRawText({ buffer });
      return parsed.value?.trim() || null;
    } catch {
      return null;
    }
  }

  return null;
}

async function prepareUserPrompt(prompt: string, attachments?: UploadedAttachment[]): Promise<PreparedUserPrompt> {
  const storedContent = buildStoredUserContent(prompt, attachments);
  if (!attachments || attachments.length === 0) {
    return {
      modelContent: prompt,
      storedContent,
      memoryText: buildUserMemoryText(prompt),
      metadata: {}
    };
  }

  const modelContent: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  const memoryAttachments: PersistedAttachmentMemory[] = [];

  for (const attachment of attachments) {
    const memoryAttachment: PersistedAttachmentMemory = {
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType
    };

    if (attachment.kind === "image" && attachment.dataUrl) {
      modelContent.push({
        type: "image_url",
        image_url: { url: attachment.dataUrl }
      });

      const ocrText = await extractTextFromImageDataUrl(attachment.dataUrl);
      if (ocrText) {
        modelContent.push({
          type: "text",
          text: `OCR text from image ${attachment.name}:\n\n${ocrText}`
        });
        memoryAttachment.textContent = ocrText;
      }

      memoryAttachments.push(memoryAttachment);
      continue;
    }

    const extractedText = await extractAttachmentText(attachment);
    if (extractedText) {
      modelContent.push({
        type: "text",
        text: `File: ${attachment.name}\n\n${extractedText.slice(0, 40000)}`
      });
      memoryAttachment.textContent = extractedText;
    }

    const embeddedImages = await extractEmbeddedImagesFromOfficeFile(attachment);
    if (embeddedImages.length > 0) {
      modelContent.push({
        type: "text",
        text: `Embedded images extracted from file: ${attachment.name}`
      });

      const ocrSnippets: string[] = [];
      for (const [index, imageDataUrl] of embeddedImages.entries()) {
        modelContent.push({
          type: "image_url",
          image_url: { url: imageDataUrl }
        });

        if (index < OCR_MAX_IMAGES_PER_DOC) {
          const ocrText = await extractTextFromImageDataUrl(imageDataUrl);
          if (ocrText) {
            ocrSnippets.push(`Image ${index + 1} OCR:\n${ocrText}`);
          }
        }
      }

      if (ocrSnippets.length > 0) {
        const combinedOcr = ocrSnippets.join("\n\n");
        modelContent.push({
          type: "text",
          text: `OCR text from images in ${attachment.name}:\n\n${combinedOcr}`
        });
        memoryAttachment.textContent = [memoryAttachment.textContent, combinedOcr].filter(Boolean).join("\n\n");
      }

      memoryAttachments.push(memoryAttachment);
      continue;
    }

    if (!extractedText) {
      modelContent.push({
        type: "text",
        text: `File uploaded: ${attachment.name} (${attachment.mimeType}).`
      });
    }

    memoryAttachments.push(memoryAttachment);
  }

  return {
    modelContent,
    storedContent,
    memoryText: buildUserMemoryText(prompt, memoryAttachments),
    metadata: memoryAttachments.length > 0 ? { attachments: memoryAttachments } : {}
  };
}


function buildCurrentDateTimeSystemMessage() {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const localDateTime = now.toLocaleString("en-US", { hour12: false, timeZone: timezone });

  return {
    role: "system" as const,
    content: [
      "Current date/time context for this request:",
      `- Local datetime (${timezone}): ${localDateTime}`,
      `- ISO datetime (UTC): ${now.toISOString()}`,
      "Use this as the authoritative current time when answering time/date questions."
    ].join("\n")
  };
}

function buildWorkspaceSystemMessage(workspace: { name: string; path: string } | null) {
  if (!workspace) return null;

  return {
    role: "system" as const,
    content: [
      "Workspace context for this request:",
      `- Active workspace name: ${workspace.name}`,
      `- Active workspace path: ${workspace.path}`,
      "When the user asks about current workspace, files, folders, or project location, use this workspace context."
    ].join("\n")
  };
}

function buildMathFormattingSystemMessage() {
  return {
    role: "system" as const,
    content: [
      "Math and equation formatting guidelines:",
      "- For inline math expressions, use single dollar signs: $E = mc^2$",
      "- For display (block) equations, use double dollar signs on separate lines:",
      "$$",
      "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
      "$$",
      "- NEVER use \\[ \\] or \\( \\) delimiters - they are not supported",
      "- NEVER use plain brackets [ ] for equations",
      "- Always use proper LaTeX syntax within the dollar signs",
      "- Examples: $\\alpha$, $\\sum_{i=1}^{n}$, $\\int_0^1 x^2 dx$, $\\frac{a}{b}$"
    ].join("\n")
  };
}

function normalizeTokenUsage(usage?: ProviderTokenUsage | null) {
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

function buildChatModeSystemMessage() {
  return {
    role: "system" as const,
    content: [
      "IMPORTANT: You are in CHAT MODE - a pure conversational assistant.",
      "RESTRICTIONS:",
      "- You CANNOT access, read, write, or modify any files or folders",
      "- You CANNOT execute commands or run code",
      "- You CANNOT browse the filesystem",
      "- You are LIMITED to text-based conversation only",
      "",
      "CAPABILITIES:",
      "- Answer questions and provide information",
      "- Explain concepts and provide examples",
      "- Help with problem-solving and brainstorming",
      "- Analyze text, images, and documents that users upload",
      "- Write code examples (but cannot save or execute them)",
      "",
      "If the user asks you to access files, modify code, or perform system operations,",
      "politely explain that these features are only available in Agent mode."
    ].join("\n")
  };
}

function shouldOfferAgentMode(prompt: string) {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return false;

  const directWorkspacePatterns = [
    /\b(analyze|review|understand|inspect|scan|check|explore|examine|trace)\b[\s\S]{0,80}\b(codebase|repo|repository|workspace|project|files?|folders?|structure|architecture)\b/,
    /\b(read|open|search|find|locate|look at|check)\b[\s\S]{0,80}\b(file|folder|directory|package\.json|readme|src|component|module)\b/,
    /\b(edit|modify|change|update|fix|refactor|rewrite|patch|implement)\b[\s\S]{0,80}\b(code|file|project|component|module|workspace)\b/,
    /\b(run|execute|test|build|lint|debug)\b[\s\S]{0,80}\b(command|commands|terminal|npm|pnpm|yarn|project|workspace)\b/,
    /\b(codebase|repository|repo|workspace)\b/
  ];

  return directWorkspacePatterns.some((pattern) => pattern.test(normalized));
}

function buildAgentModeSuggestion(
  prompt: string,
  sourceConversationId?: string
): { content: string; interactive: ChatInteractivePayload } {
  return {
    content: [
      "This request needs workspace access, so Chat mode is likely to give you a weak or incorrect answer.",
      "",
      "Switch to Agent mode and I can continue with the same request using workspace-aware tools."
    ].join("\n"),
    interactive: {
      type: "mode_switch",
      suggestedMode: "agent",
      prompt,
      sourceConversationId,
      approveLabel: "Switch to Agent",
      cancelLabel: "Stay in Chat"
    }
  };
}

async function resolveConversationAndWorkspace(userId: string, payload: ChatRequestPayload, title: string) {
  const result = await resolveConversationAndWorkspaceImpl(userId, payload, title, /* allowCreate */ true);
  // The wrapper always creates the conversation, so it's never null here.
  // The non-null assertion is safe because allowCreate=true guarantees a row.
  if (!result.conversation) {
    throw new Error("Failed to create conversation");
  }
  return result as { conversation: NonNullable<typeof result.conversation>; workspace: typeof result.workspace };
}

/**
 * Internal: resolves the workspace and (optionally) the conversation. When
 * `allowCreate` is false, no new conversation row is created — the caller
 * intends to create one later (e.g. after the upstream LLM call succeeds,
 * to avoid orphan rows when the LLM errors out).
 */
async function resolveConversationAndWorkspaceImpl(
  userId: string,
  payload: ChatRequestPayload,
  _title: string,
  allowCreate: boolean
) {
  const existingConversation = payload.conversationId
    ? await prisma.conversation.findFirst({
        where: {
          id: payload.conversationId,
          userId
        }
      })
    : null;

  if (payload.conversationId && !existingConversation) {
    throw new Error("Conversation not found");
  }

  const workspaceIdToUse = payload.workspaceId ?? existingConversation?.workspaceId;

  const workspace = workspaceIdToUse
    ? await prisma.workspace.findFirst({ where: { id: workspaceIdToUse, userId } })
    : await prisma.workspace.findFirst({ where: { userId, isActive: true } });

  const conversation = existingConversation
    ?? (allowCreate
      ? await prisma.conversation.create({
          data: {
            userId,
            workspaceId: workspace?.id,
            title: "New Conversation"
          }
        })
      : null);

  // Backfill: if an existing conversation has no workspace binding yet but we
  // resolved one, pin it now so future loads restore the correct context.
  if (conversation && !conversation.workspaceId && workspace?.id) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { workspaceId: workspace.id }
    });
    conversation.workspaceId = workspace.id;
  }

  return { conversation, workspace };
}

function queueConversationSummaryRefresh(app: FastifyInstance, params: {
  conversationId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}) {
  void refreshConversationSummary(params).catch((error) => {
    app.log.warn({ err: error, conversationId: params.conversationId }, "Failed to refresh conversation memory summary");
  });
}

async function generateConversationTitle(params: {
  firstMessage: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<string> {
  try {
    const response = await fetch(`${params.baseUrl.replace(/\/$/, "")}/chat/completions`, {
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
    
    // Clean up the title - remove quotes if present, limit length
    return title.replace(/^["']|["']$/g, "").slice(0, 60);
  } catch {
    return "New Conversation";
  }
}

function queueConversationTitleGeneration(app: FastifyInstance, params: {
  conversationId: string;
  firstMessage: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}) {
  void generateConversationTitle({
    firstMessage: params.firstMessage,
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    model: params.model
  }).then(async (title) => {
    await prisma.conversation.update({
      where: { id: params.conversationId },
      data: { title }
    });
  }).catch((error) => {
    app.log.warn({ err: error, conversationId: params.conversationId }, "Failed to generate conversation title");
  });
}

export async function registerChatRoutes(app: FastifyInstance) {

  app.post("/chat", async (request, reply) => {
    const parsed = chatSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const payload = parsed.data;
    const user = await getLocalUser();
    const secret = process.env.APP_SECRET;

    if (!secret) {
      return reply.code(500).send({ message: "APP_SECRET is not configured" });
    }

    let settings = await getOrCreateProviderSetting(user.id, payload.provider);
    if (!settings) {
      return reply.code(400).send({ message: "Missing API key. Save it in Settings first." });
    }

    settings = await materializeLegacyKeys(user.id, payload.provider, secret) ?? settings;

    if (!settings.enabled) {
      return reply.code(400).send({ message: `${payload.provider} is disabled in settings` });
    }

    if (settings.apiKeys.length === 0 && !providerAllowsKeylessAccess(payload.provider)) {
      return reply.code(400).send({ message: "Missing API key. Save it in Settings first." });
    }

    const models = (settings.models as string[] | null) ?? getDefaultModels(payload.provider);
    const model = payload.model ?? models[0];

    if (!model) {
      return reply.code(400).send({ message: "No model configured. Save at least one model in settings." });
    }

    const preparedUserPrompt = await prepareUserPrompt(payload.prompt, payload.attachments);

    let conversationContext: Awaited<ReturnType<typeof resolveConversationAndWorkspace>>;
    try {
      conversationContext = await resolveConversationAndWorkspace(user.id, payload, preparedUserPrompt.storedContent);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to resolve conversation";
      return reply.code(message === "Conversation not found" ? 404 : 500).send({ message });
    }

    const { conversation, workspace } = conversationContext;
    const loadedMemory = await loadConversationMemory(conversation.id);
    const memorySystemMessage = buildConversationMemoryMessage(loadedMemory);
    const workspaceSystemMessage = payload.mode === "chat" ? null : buildWorkspaceSystemMessage(
      workspace ? { name: workspace.name, path: workspace.path } : null
    );

    if (payload.mode === "chat" && shouldOfferAgentMode(payload.prompt)) {
      const suggestion = buildAgentModeSuggestion(payload.prompt, conversation.id);

      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "user",
          mode: "chat",
          content: preparedUserPrompt.storedContent,
          memoryText: preparedUserPrompt.memoryText,
          metadata: serializeMessageMetadata(preparedUserPrompt.metadata),
          model: payload.model,
          provider: payload.provider,
          reasoningEffort: payload.reasoningEffort ?? null
        }
      });

      const assistantMessage = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          mode: "chat",
          content: suggestion.content,
          memoryText: buildAssistantMemoryText(suggestion.content, { mode: "chat" }),
          metadata: serializeMessageMetadata({ interactive: suggestion.interactive }),
          model: payload.model,
          provider: payload.provider,
          reasoningEffort: payload.reasoningEffort ?? null
        }
      });

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() }
      });

      return {
        message: assistantMessage
      };
    }

    const ordered = settings.apiKeys.length > 0
      ? listKeysInPriority(settings.apiKeys)
      : [{
          id: `${payload.provider}-direct`,
          name: "Direct connection",
          apiKeyEncrypted: "",
          isActive: true
        }];
    const keysToTry = ordered;
    const initialKey = ordered[0];
    const timeoutMs = getConfiguredLlmTimeoutMs();

    let chosenKey: KeyRecord | undefined;
    let chosenApiKey: string | undefined;
    let upstream: Response | undefined;
    let lastFailure = "";

    for (let i = 0; i < keysToTry.length; i += 1) {
      const current = keysToTry[i];
      const apiKey = current.apiKeyEncrypted
        ? tryDecryptApiKey(current.apiKeyEncrypted, secret)
        : "ollama";
      if (!apiKey) {
        lastFailure = "Stored API key cannot be decrypted with current APP_SECRET";
        const canTryNext = i < keysToTry.length - 1;

        if (canTryNext) {
          continue;
        }
        return reply.code(400).send({ message: "Stored API key is invalid. Please re-save it in Settings." });
      }

      const requestBody: Record<string, unknown> = {
        model,
        messages: [
          buildCurrentDateTimeSystemMessage(),
          buildMathFormattingSystemMessage(),
          ...(payload.mode === "chat" ? [buildChatModeSystemMessage()] : []),
          ...(workspaceSystemMessage ? [workspaceSystemMessage] : []),
          ...(memorySystemMessage ? [memorySystemMessage] : []),
          ...loadedMemory.recentMessages,
          { role: "user", content: preparedUserPrompt.modelContent }
        ],
        // Reasoning / thinking-mode control — translated to the right
        // parameter shape for the active provider (see
        // server/src/lib/agent/reasoning-translator.ts).
        ...translateReasoning(payload.provider, model, payload.reasoningEffort)
      };

      app.log.info({
        model,
        hasAttachments: payload.attachments && payload.attachments.length > 0,
        attachmentCount: payload.attachments?.length ?? 0,
        contentType: typeof preparedUserPrompt.modelContent,
        isArray: Array.isArray(preparedUserPrompt.modelContent),
        contentLength: Array.isArray(preparedUserPrompt.modelContent) ? preparedUserPrompt.modelContent.length : 1
      }, "Sending request to AI provider");

      let candidate: Response;
      try {
        candidate = await fetchWithLlmTimeout(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(requestBody)
        }, timeoutMs);
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : "Upstream provider request failed";
        const canFallback = settings.autoSwitchApiKey && i < keysToTry.length - 1 && isTimeoutError(error);
        if (canFallback) {
          app.log.warn({ provider: payload.provider, model, apiKeyId: current.id }, "LLM request timed out, trying next API key");
          continue;
        }
        return reply.code(isTimeoutError(error) ? 504 : 502).send({
          message: isTimeoutError(error) ? "Upstream provider request timed out" : "Upstream provider request failed",
          details: lastFailure
        });
      }


      if (candidate.ok) {
        chosenKey = current;
        chosenApiKey = apiKey;
        upstream = candidate;
        break;
      }


      lastFailure = await candidate.text();
      const canFallback = settings.autoSwitchApiKey && i < keysToTry.length - 1 && shouldAutoFallback(candidate.status, lastFailure);
      if (!canFallback) {
        return reply.code(502).send({ message: "Upstream provider request failed", details: lastFailure });
      }
    }

    if (!upstream || !chosenKey) {
      return reply.code(502).send({ message: "Upstream provider request failed", details: lastFailure });
    }

    const apiKeySwitch = initialKey && chosenKey.id !== initialKey.id
      ? {
          fromKeyName: initialKey.name,
          toKeyName: chosenKey.name
        } satisfies ApiKeySwitchInfo
      : undefined;

    if (!chosenKey.isActive && settings.apiKeys.some((item) => item.id === chosenKey.id)) {
      await prisma.$transaction(async (tx) => {
        await tx.providerApiKey.updateMany({
          where: { providerSettingId: settings.id },
          data: { isActive: false }
        });

        await tx.providerApiKey.update({
          where: { id: chosenKey.id },
          data: { isActive: true }
        });
      });
    }

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        mode: "chat",
        content: preparedUserPrompt.storedContent,
        memoryText: preparedUserPrompt.memoryText,
        metadata: serializeMessageMetadata(preparedUserPrompt.metadata),
        model,
        provider: payload.provider,
        reasoningEffort: payload.reasoningEffort ?? null
      }
    });

    const completion = (await upstream.json()) as ChatCompletionResponse;


    const content = completion.choices?.[0]?.message?.content ?? "";
    const tokenUsage = normalizeTokenUsage(completion.usage);

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        mode: "chat",
        content,
        memoryText: buildAssistantMemoryText(content, { mode: "chat" }),
        metadata: serializeMessageMetadata(tokenUsage ? { tokenUsage } : {}),
        model,
        provider: payload.provider,
        reasoningEffort: payload.reasoningEffort ?? null
      }
    });

    await recordUsage({
      userId: user.id,
      provider: payload.provider,
      model,
      mode: "chat",
      tokenUsage,
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() }
    });

    // Generate title for new conversations
    const isNewConversation = !payload.conversationId;
    if (isNewConversation && chosenApiKey) {
      queueConversationTitleGeneration(app, {
        conversationId: conversation.id,
        firstMessage: preparedUserPrompt.storedContent,
        baseUrl: settings.baseUrl,
        apiKey: chosenApiKey,
        model
      });
    }

    if (chosenApiKey) {
      queueConversationSummaryRefresh(app, {
        conversationId: conversation.id,
        baseUrl: settings.baseUrl,
        apiKey: chosenApiKey,
        model
      });
    }


    return {
      conversationId: conversation.id,
      model,
      tokenUsage,
      apiKeySwitch
    };
  });

  app.post("/chat/stream", async (request, reply) => {
    const parsed = chatSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const payload = parsed.data;
    const user = await getLocalUser();
    const secret = process.env.APP_SECRET;

    if (!secret) {
      return reply.code(500).send({ message: "APP_SECRET is not configured" });
    }

    let settings = await getOrCreateProviderSetting(user.id, payload.provider);
    if (!settings) {
      return reply.code(400).send({ message: "Missing API key. Save it in Settings first." });
    }

    settings = await materializeLegacyKeys(user.id, payload.provider, secret) ?? settings;

    if (!settings.enabled) {
      return reply.code(400).send({ message: `${payload.provider} is disabled in settings` });
    }

    if (settings.apiKeys.length === 0 && !providerAllowsKeylessAccess(payload.provider)) {
      return reply.code(400).send({ message: "Missing API key. Save it in Settings first." });
    }

    const models = (settings.models as string[] | null) ?? getDefaultModels(payload.provider);
    const model = payload.model ?? models[0];

    if (!model) {
      return reply.code(400).send({ message: "No model configured. Save at least one model in settings." });
    }

    const preparedUserPrompt = await prepareUserPrompt(payload.prompt, payload.attachments);

    // For the streaming route, we resolve the workspace up front but defer
    // creating a new conversation until AFTER the LLM call has succeeded.
    // This way, an upstream error (404 model not found, 401 invalid key, 500
    // upstream failure) never leaves an orphan conversation row in the
    // sidebar — the user retries without their history getting polluted.
    let conversationContext: Awaited<ReturnType<typeof resolveConversationAndWorkspaceImpl>>;
    try {
      conversationContext = await resolveConversationAndWorkspaceImpl(
        user.id,
        payload,
        preparedUserPrompt.storedContent,
        /* allowCreate */ Boolean(payload.conversationId)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to resolve conversation";
      return reply.code(message === "Conversation not found" ? 404 : 500).send({ message });
    }

    const { conversation: existingConversation, workspace } = conversationContext;
    // For new conversations, `conversation` is null until the LLM responds.
    // We bind the rest of the handler to a mutable `conversation` so the
    // post-success path can create the row and update the SSE events.
    let conversation = existingConversation;
    const loadedMemory: Awaited<ReturnType<typeof loadConversationMemory>> = conversation
      ? await loadConversationMemory(conversation.id)
      : { recentMessages: [], summary: null };
    const memorySystemMessage = buildConversationMemoryMessage(loadedMemory);
    const workspaceSystemMessage = payload.mode === "chat" ? null : buildWorkspaceSystemMessage(
      workspace ? { name: workspace.name, path: workspace.path } : null
    );

    if (payload.mode === "chat" && shouldOfferAgentMode(payload.prompt)) {
      // For the suggestion path we DO need a real conversation row, so
      // create one now. The actual LLM call is skipped on this path.
      if (!conversation) {
        conversation = await prisma.conversation.create({
          data: {
            userId: user.id,
            workspaceId: workspace?.id,
            title: "New Conversation"
          }
        });
      }
      const suggestion = buildAgentModeSuggestion(payload.prompt, conversation.id);

      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "user",
          mode: "chat",
          content: preparedUserPrompt.storedContent,
          memoryText: preparedUserPrompt.memoryText,
          metadata: serializeMessageMetadata(preparedUserPrompt.metadata),
          model: payload.model,
          provider: payload.provider,
          reasoningEffort: payload.reasoningEffort ?? null
        }
      });

      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          mode: "chat",
          content: suggestion.content,
          memoryText: buildAssistantMemoryText(suggestion.content, { mode: "chat" }),
          metadata: serializeMessageMetadata({ interactive: suggestion.interactive }),
          model: payload.model,
          provider: payload.provider,
          reasoningEffort: payload.reasoningEffort ?? null
        }
      });

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() }
      });

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": request.headers.origin ?? "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      });

      reply.raw.write(
        `data: ${JSON.stringify({
          type: "start",
          conversationId: conversation.id,
          model: payload.model
        })}\n\n`
      );
      reply.raw.write(
        `data: ${JSON.stringify({
          type: "done",
          conversationId: conversation.id,
          model: payload.model,
          content: suggestion.content,
          interactive: suggestion.interactive
        })}\n\n`
      );
      reply.raw.end();
      return reply;
    }

    const ordered = settings.apiKeys.length > 0
      ? listKeysInPriority(settings.apiKeys)
      : [{
          id: `${payload.provider}-direct`,
          name: "Direct connection",
          apiKeyEncrypted: "",
          isActive: true
        }];
    const keysToTry = ordered;
    const initialKey = ordered[0];
    const timeoutMs = getConfiguredLlmTimeoutMs();

    let chosenKey: KeyRecord | undefined;
    let chosenApiKey: string | undefined;
    let upstream: Response | undefined;
    let lastFailure = "";

    for (let i = 0; i < keysToTry.length; i += 1) {
      const current = keysToTry[i];
      const apiKey = current.apiKeyEncrypted
        ? tryDecryptApiKey(current.apiKeyEncrypted, secret)
        : "ollama";
      if (!apiKey) {
        lastFailure = "Stored API key cannot be decrypted with current APP_SECRET";
        const canTryNext = i < keysToTry.length - 1;
        if (canTryNext) {
          continue;
        }
        return reply.code(400).send({ message: "Stored API key is invalid. Please re-save it in Settings." });
      }

      const requestBody: Record<string, unknown> = {
        model,
        stream: true,
        ...(payload.provider !== "huggingface" ? { stream_options: { include_usage: true } } : {}),
        messages: [
          buildCurrentDateTimeSystemMessage(),
          buildMathFormattingSystemMessage(),
          ...(payload.mode === "chat" ? [buildChatModeSystemMessage()] : []),
          ...(workspaceSystemMessage ? [workspaceSystemMessage] : []),
          ...(memorySystemMessage ? [memorySystemMessage] : []),
          ...loadedMemory.recentMessages,
          { role: "user", content: preparedUserPrompt.modelContent }
        ],
        // Reasoning / thinking-mode control — see reasoning-translator.ts.
        ...translateReasoning(payload.provider, model, payload.reasoningEffort)
      };

      app.log.info({
        model,
        hasAttachments: payload.attachments && payload.attachments.length > 0,
        attachmentCount: payload.attachments?.length ?? 0,
        contentType: typeof preparedUserPrompt.modelContent,
        isArray: Array.isArray(preparedUserPrompt.modelContent),
        contentLength: Array.isArray(preparedUserPrompt.modelContent) ? preparedUserPrompt.modelContent.length : 1
      }, "Sending streaming request to AI provider");

      let candidate: Response;
      try {
        candidate = await fetchWithLlmTimeout(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(requestBody)
        }, timeoutMs);
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : "Upstream provider request failed";
        const canFallback = settings.autoSwitchApiKey && i < keysToTry.length - 1 && isTimeoutError(error);
        if (canFallback) {
          app.log.warn({ provider: payload.provider, model, apiKeyId: current.id }, "Streaming LLM request timed out, trying next API key");
          continue;
        }
        return reply.code(isTimeoutError(error) ? 504 : 502).send({
          message: isTimeoutError(error) ? "Upstream provider request timed out" : "Upstream provider request failed",
          details: lastFailure
        });
      }

      if (!candidate.ok) {
        const errorBody = await candidate.text().catch(() => candidate.statusText);
        app.log.warn({ provider: payload.provider, model, status: candidate.status, body: errorBody.slice(0, 500) }, "Provider returned non-ok status, will retry without stream_options");

        const retryBody = { ...requestBody };
        delete (retryBody as { stream_options?: unknown }).stream_options;
        try {
          candidate = await fetchWithLlmTimeout(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify(retryBody)
          }, timeoutMs);
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : "Upstream provider request failed";
          const canFallback = settings.autoSwitchApiKey && i < keysToTry.length - 1 && isTimeoutError(error);
          if (canFallback) {
            app.log.warn({ provider: payload.provider, model, apiKeyId: current.id }, "Streaming retry request timed out, trying next API key");
            continue;
          }
          return reply.code(isTimeoutError(error) ? 504 : 502).send({
            message: isTimeoutError(error) ? "Upstream provider request timed out" : "Upstream provider request failed",
            details: lastFailure
          });
        }
      }


      if (candidate.ok) {
        app.log.info({ provider: payload.provider, model, status: candidate.status }, "Provider returned ok, starting stream");
        chosenKey = current;
        chosenApiKey = apiKey;
        upstream = candidate;
        break;
      }


      lastFailure = await candidate.text();
      app.log.warn({ provider: payload.provider, model, status: candidate.status, body: lastFailure.slice(0, 500) }, "Provider still non-ok after retry");
      const canFallback = settings.autoSwitchApiKey && i < keysToTry.length - 1 && shouldAutoFallback(candidate.status, lastFailure);
      if (!canFallback) {
        return reply.code(502).send({ message: "Upstream provider request failed", details: lastFailure });
      }
    }

    if (!upstream || !chosenKey) {
      return reply.code(502).send({ message: "Upstream provider request failed", details: lastFailure });
    }

    const apiKeySwitch = initialKey && chosenKey.id !== initialKey.id
      ? {
          fromKeyName: initialKey.name,
          toKeyName: chosenKey.name
        } satisfies ApiKeySwitchInfo
      : undefined;

    if (!chosenKey.isActive && settings.apiKeys.some((item) => item.id === chosenKey.id)) {
      await prisma.$transaction(async (tx) => {
        await tx.providerApiKey.updateMany({
          where: { providerSettingId: settings.id },
          data: { isActive: false }
        });

        await tx.providerApiKey.update({
          where: { id: chosenKey.id },
          data: { isActive: true }
        });
      });
    }

    // The LLM call succeeded — now safe to persist the conversation row
    // and the user message. If we did this BEFORE the LLM call and the
    // call had failed (e.g. 404 model not found), we'd leave an orphan
    // conversation in the sidebar that the user would need to manually
    // delete.
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          userId: user.id,
          workspaceId: workspace?.id,
          title: "New Conversation"
        }
      });
    }

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        mode: "chat",
        content: preparedUserPrompt.storedContent,
        memoryText: preparedUserPrompt.memoryText,
        metadata: serializeMessageMetadata(preparedUserPrompt.metadata),
        model,
        provider: payload.provider,
        reasoningEffort: payload.reasoningEffort ?? null
      }
    });


    reply.raw.writeHead(200, {


      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": request.headers.origin ?? "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    });

    reply.raw.write(
      `data: ${JSON.stringify({
        type: "start",
        conversationId: conversation.id,
        model
      })}\n\n`
    );

    const reader = upstream.body?.getReader();
    if (!reader) {
      reply.raw.write(`data: ${JSON.stringify({ type: "error", message: "No stream body from provider" })}\n\n`);
      reply.raw.end();
      return reply;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let assistantContent = "";
    let streamTokenUsage = undefined as ReturnType<typeof normalizeTokenUsage>;
    let streamDone = false;

    try {
      while (!streamDone) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let lineEnd = buffer.indexOf("\n");
        while (lineEnd !== -1) {
          const rawLine = buffer.slice(0, lineEnd).replace(/\r$/, "").trim();
          buffer = buffer.slice(lineEnd + 1);

          if (rawLine.startsWith("data:")) {
            const data = rawLine.slice(5).trim();

            if (data === "[DONE]") {
              streamDone = true;
              break;
            }

            try {
              const parsedChunk = JSON.parse(data) as StreamDeltaResponse & { error?: { message?: string } };

              // Surface HF-style error chunks
              if (parsedChunk.error) {
                app.log.warn({ error: parsedChunk.error }, "Provider returned error chunk in stream");
                reply.raw.write(`data: ${JSON.stringify({ type: "error", message: parsedChunk.error.message ?? "Provider error" })}\n\n`);
                streamDone = true;
                break;
              }

              const usage = normalizeTokenUsage(parsedChunk.usage);
              if (usage) {
                streamTokenUsage = usage;
              }

              const delta = parsedChunk.choices?.[0]?.delta?.content ?? "";

              if (delta) {
                assistantContent += delta;
                reply.raw.write(
                  `data: ${JSON.stringify({
                    type: "chunk",
                    conversationId: conversation.id,
                    model,
                    content: delta
                  })}\n\n`
                );
              }
            } catch {
              continue;
            }
          }

          lineEnd = buffer.indexOf("\n");
        }
      }

      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          mode: "chat",
          content: assistantContent,
          memoryText: buildAssistantMemoryText(assistantContent, { mode: "chat" }),
          metadata: serializeMessageMetadata(streamTokenUsage ? { tokenUsage: streamTokenUsage } : {}),
          model,
          provider: payload.provider,
          reasoningEffort: payload.reasoningEffort ?? null
        }
      });

      await recordUsage({
        userId: user.id,
        provider: payload.provider,
        model,
        mode: "chat",
        tokenUsage: streamTokenUsage,
      });

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() }
      });

      // Generate title for new conversations
      const isNewConversation = !payload.conversationId;
      if (isNewConversation && chosenApiKey) {
        queueConversationTitleGeneration(app, {
          conversationId: conversation.id,
          firstMessage: preparedUserPrompt.storedContent,
          baseUrl: settings.baseUrl,
          apiKey: chosenApiKey,
          model
        });
      }

      if (chosenApiKey) {
        queueConversationSummaryRefresh(app, {
          conversationId: conversation.id,
          baseUrl: settings.baseUrl,
          apiKey: chosenApiKey,
          model
        });
      }


      reply.raw.write(

        `data: ${JSON.stringify({
          type: "done",
          conversationId: conversation.id,
          model,
          content: assistantContent,
          tokenUsage: streamTokenUsage,
          apiKeySwitch
        })}\n\n`

      );
    } catch (error) {
      reply.raw.write(
        `data: ${JSON.stringify({
          type: "error",
          message: error instanceof Error ? error.message : "Stream failed"
        })}\n\n`
      );
    }

    reply.raw.end();
    return reply;
  });
}
