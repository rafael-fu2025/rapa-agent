import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { getDefaultBaseUrl, getDefaultModels } from "../lib/constants.js";

import { prisma, getLocalUser } from "../lib/db.js";
import { decryptText, encryptText } from "../lib/crypto.js";
import { diffModelLists, parseModelsResponse } from "../lib/provider-models.js";


const providerSchema = z.object({
  provider: z.string().default("gemini")
});

const updateSchema = z.object({
  provider: z.string().default("gemini"),
  enabled: z.boolean().optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  apiKeyName: z.string().min(1).max(80).optional(),
  selectedApiKeyId: z.string().min(1).nullable().optional(),
  autoSwitchApiKey: z.boolean().optional(),
  removeApiKeyIds: z.array(z.string().min(1)).optional(),
  models: z.array(z.string().min(1)).optional()
});

const testKeySchema = z.object({
  provider: z.string().default("gemini"),
  apiKeyId: z.string().min(1).optional()
});

type LegacyBundle = {
  keys: Array<{ id: string; name: string; key: string }>;
  activeKeyId?: string;
  autoSwitchApiKey: boolean;
};

type GeneralSettingsResponse = {
  version: string;
  language: string;
  dataFolder: string;
  docsUrl: string;
  releasesUrl: string;
  githubUrl: string;
  discordUrl: string;
  reportIssueUrl: string;
};

const GENERAL_DEFAULTS: Omit<GeneralSettingsResponse, "version"> = {
  language: "English",
  dataFolder: "C:\\Users\\Rafael\\AppData\\Roaming\\Rapadata",
  docsUrl: "https://docs.menlo.ai",
  releasesUrl: "https://github.com",
  githubUrl: "https://github.com",
  discordUrl: "https://discord.com",
  reportIssueUrl: "https://github.com/issues"
};

function providerAllowsKeylessAccess(provider: string) {
  // Puter doesn't require an API key in our system — it proxies user auth via
  // the browser session when called from `puter.ai.chat()`. For model-listing
  // purposes, Puter's catalog endpoint is also publicly readable, so we treat
  // it as keyless like Ollama.
  return provider === "ollama" || provider === "puter";
}

/**
 * Resolve the URL used to fetch the model catalog for a provider. Most
 * OpenAI-compatible providers expose their list at `<baseUrl>/models`, but
 * some aggregators/proxies publish the catalog at a non-standard path. Puter
 * in particular serves a rich, multi-vendor catalog at
 * `https://api.puter.com/puterai/chat/models/details` — its standard
 * OpenAI-compatible `/puterai/openai/v1/models` endpoint returns 404.
 */
function getProviderModelsUrl(provider: string, baseUrl: string): string {
  if (provider === "puter") {
    return "https://api.puter.com/puterai/chat/models/details";
  }
  return `${baseUrl.replace(/\/$/, "")}/models`;
}

async function getAppVersion() {
  try {
    const packageJsonPath = resolve(process.cwd(), "..", "package.json");
    const raw = await readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
    return version ? `v${version}` : "v0.0.0";
  } catch {
    return "v0.0.0";
  }
}

function maskKey() {

  return "••••••••••••";
}

function canDecryptApiKey(apiKeyEncrypted: string, secret: string) {
  try {
    decryptText(apiKeyEncrypted, secret);
    return true;
  } catch {
    return false;
  }
}

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

function toSettingsResponse(setting: {
  provider: string;
  enabled: boolean;
  baseUrl: string;
  autoSwitchApiKey: boolean;
  models: unknown;
  apiKeys: Array<{ id: string; name: string; isActive: boolean }>;
}) {
  const apiKeys = setting.apiKeys.map((item) => ({
    id: item.id,
    name: item.name,
    maskedKey: maskKey(),
    isActive: item.isActive
  }));

  return {
    provider: setting.provider,
    enabled: setting.enabled,
    baseUrl: setting.baseUrl,
    apiKeyMasked: apiKeys.find((item) => item.isActive)?.maskedKey ?? "",
    hasApiKey: apiKeys.length > 0,
    apiKeys,
    activeApiKeyId: apiKeys.find((item) => item.isActive)?.id ?? null,
    autoSwitchApiKey: setting.autoSwitchApiKey,
    models: (setting.models as string[] | null) ?? getDefaultModels(setting.provider)

  };
}

type UsageAnalyticsAccumulator = {
  provider: string;
  model?: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  chatRequests: number;
  agentRequests: number;
  lastUsedAt: Date | null;
};

function createUsageAccumulator(provider: string, model?: string): UsageAnalyticsAccumulator {
  return {
    provider,
    model,
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    chatRequests: 0,
    agentRequests: 0,
    lastUsedAt: null
  };
}

function serializeUsageAccumulator(item: UsageAnalyticsAccumulator) {
  return {
    provider: item.provider,
    model: item.model,
    requests: item.requests,
    conversations: 0,
    promptTokens: item.promptTokens,
    completionTokens: item.completionTokens,
    totalTokens: item.totalTokens,
    chatRequests: item.chatRequests,
    agentRequests: item.agentRequests,
    lastUsedAt: item.lastUsedAt?.toISOString() ?? null
  };
}

// Format a Date as YYYY-MM-DD in the **local** timezone. We deliberately
// avoid `toISOString().slice(0, 10)` because that returns the UTC date —
// which for users in any timezone east of UTC (e.g. UTC+8) can be one
// day behind their local date when the request is made in the early
// morning hours. Using the local date components keeps the dailyUsage
// array's date keys aligned with what the user actually sees on their
// wall clock (and on their taskbar, e.g. 18/06/2026).
function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function buildUsageAnalytics(userId: string) {
  const records = await prisma.usageRecord.findMany({
    where: { userId },
    orderBy: { recordedAt: "asc" }
  });

  const providerMap = new Map<string, UsageAnalyticsAccumulator>();
  const modelMap = new Map<string, UsageAnalyticsAccumulator>();
  const dailyMap = new Map<string, { tokens: number; requests: number }>();
  let totalRequests = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;

  for (const record of records) {
    const providerKey = record.provider;
    const modelKey = `${record.provider}::${record.model}`;
    const isAgent = record.mode === "agent" || record.mode === "plan";

    // Accumulate daily usage — key by LOCAL date so the entry lands in
    // the bucket the user actually sees on their calendar (the previous
    // UTC-keyed version was off-by-one for any user east of UTC).
    const dayKey = formatLocalDate(record.recordedAt);
    const dayStats = dailyMap.get(dayKey) ?? { tokens: 0, requests: 0 };
    dayStats.tokens += record.totalTokens;
    dayStats.requests += 1;
    dailyMap.set(dayKey, dayStats);

    const providerStats = providerMap.get(providerKey) ?? createUsageAccumulator(record.provider);
    const modelStats = modelMap.get(modelKey) ?? createUsageAccumulator(record.provider, record.model);

    [providerStats, modelStats].forEach((stats) => {
      stats.requests += 1;
      stats.promptTokens += record.promptTokens;
      stats.completionTokens += record.completionTokens;
      stats.totalTokens += record.totalTokens;
      if (isAgent) stats.agentRequests += 1;
      else stats.chatRequests += 1;
      if (!stats.lastUsedAt || record.recordedAt > stats.lastUsedAt) {
        stats.lastUsedAt = record.recordedAt;
      }
    });

    providerMap.set(providerKey, providerStats);
    modelMap.set(modelKey, modelStats);
    totalRequests += 1;
    promptTokens += record.promptTokens;
    completionTokens += record.completionTokens;
    totalTokens += record.totalTokens;
  }

  const byUsage = (left: UsageAnalyticsAccumulator, right: UsageAnalyticsAccumulator) =>
    right.totalTokens - left.totalTokens || right.requests - left.requests || left.provider.localeCompare(right.provider);

  // Build 168-day (24 weeks) daily usage array for heatmap. Dates are
  // keyed in the LOCAL timezone (matching the dailyMap above) so the
  // last entry corresponds to the user's local "today" — not UTC today.
  const dailyUsage: Array<{ date: string; tokens: number; requests: number }> = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 167; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = formatLocalDate(d);
    const entry = dailyMap.get(key);
    dailyUsage.push({ date: key, tokens: entry?.tokens ?? 0, requests: entry?.requests ?? 0 });
  }

  return {
    totalRequests,
    totalConversations: 0,
    promptTokens,
    completionTokens,
    totalTokens,
    providers: Array.from(providerMap.values()).sort(byUsage).map(serializeUsageAccumulator),
    models: Array.from(modelMap.values()).sort(byUsage).map(serializeUsageAccumulator),
    dailyUsage
  };
}

export async function registerSettingsRoutes(app: FastifyInstance) {
  app.get("/general-settings", async () => {
    const version = await getAppVersion();
    return {
      version,
      ...GENERAL_DEFAULTS
    } satisfies GeneralSettingsResponse;
  });

  app.get("/settings", async (request, reply) => {

    const parsed = providerSchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid query" });
    }

    const user = await getLocalUser();
    const secret = process.env.APP_SECRET;

    let setting = await getSettingWithKeys(user.id, parsed.data.provider);

    if (setting && secret) {
      setting = await materializeLegacyKeys(user.id, parsed.data.provider, secret);
    }

    if (!setting) {
      return {
        provider: parsed.data.provider,
        enabled: true,
        baseUrl: getDefaultBaseUrl(parsed.data.provider),
        apiKeyMasked: "",
        hasApiKey: false,
        apiKeys: [],
        activeApiKeyId: null,
        autoSwitchApiKey: false,
        models: getDefaultModels(parsed.data.provider)

      };
    }

    return toSettingsResponse(setting);
  });

  app.get("/settings/usage-analytics", async () => {
    const user = await getLocalUser();
    return buildUsageAnalytics(user.id);
  });

  app.post("/settings/test-key", async (request, reply) => {
    const parsed = testKeySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const secret = process.env.APP_SECRET;
    if (!secret) {
      return reply.code(500).send({ message: "APP_SECRET is not configured" });
    }

    let setting = await getSettingWithKeys(user.id, parsed.data.provider);
    const allowsKeyless = providerAllowsKeylessAccess(parsed.data.provider);

    if (!setting && !allowsKeyless) {
      return reply.code(400).send({ message: "No API key saved for this provider" });
    }

    setting = setting ? await materializeLegacyKeys(user.id, parsed.data.provider, secret) ?? setting : null;

    const selected = setting
      ? (
          parsed.data.apiKeyId
            ? setting.apiKeys.find((item) => item.id === parsed.data.apiKeyId)
            : setting.apiKeys.find((item) => item.isActive && canDecryptApiKey(item.apiKeyEncrypted, secret))
              ?? setting.apiKeys.find((item) => canDecryptApiKey(item.apiKeyEncrypted, secret))
        )
      : undefined;

    if (!selected && !allowsKeyless) {
      return reply.code(400).send({ message: "No decryptable API key available. Paste the key again in Settings and save." });
    }

    let apiKey: string | undefined;
    if (selected) {
      try {
        app.log.info({
          keyId: selected.id,
          provider: setting?.provider,
          hasSecret: true
        }, "Attempting to decrypt API key");

        apiKey = decryptText(selected.apiKeyEncrypted, secret);

        app.log.info({ keyId: selected.id, provider: setting?.provider }, "Decryption successful");
      } catch (error) {
        app.log.error({
          keyId: selected.id,
          provider: setting?.provider,
          error: error instanceof Error ? error.message : String(error)
        }, "Decryption failed");

        return reply.code(400).send({ message: "Stored API key is invalid. Please re-save it in Settings." });
      }
    }

    const baseUrl = setting?.baseUrl ?? getDefaultBaseUrl(parsed.data.provider);
    const upstream = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined
    });

    app.log.info({
      url: `${baseUrl.replace(/\/$/, "")}/models`,
      status: upstream.status,
      statusText: upstream.statusText,
      ok: upstream.ok
    }, "Provider API response");
    if (!upstream.ok) {
      const details = await upstream.text();
      app.log.error({ details: details.substring(0, 500) }, "Provider API error details");
      return reply.code(400).send({ message: "API key test failed", details: details || `status:${upstream.status}` });
    }

    return {
      ok: true,
      keyId: selected?.id,
      keyName: selected?.name ?? (allowsKeyless ? "Direct connection" : undefined),
      status: upstream.status
    };
  });

  // Refresh the available model list for a provider by calling its
  // upstream `/models` endpoint and persisting the result. Supports all
  // built-in providers (Gemini, NVIDIA, Groq, Hugging Face, MiniMax, …) and
  // any custom OpenAI-compatible provider the user has registered.
  const refreshModelsSchema = z.object({
    provider: z.string().min(1),
    apiKeyId: z.string().min(1).optional(),
    /**
     * When true, merge the fetched list with the existing saved models.
     * When false (default), replace the saved list entirely.
     */
    merge: z.boolean().optional()
  });

  app.post("/settings/refresh-models", async (request, reply) => {
    const parsed = refreshModelsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const secret = process.env.APP_SECRET;
    if (!secret) {
      return reply.code(500).send({ message: "APP_SECRET is not configured" });
    }

    let setting = await getSettingWithKeys(user.id, parsed.data.provider);
    const allowsKeyless = providerAllowsKeylessAccess(parsed.data.provider);

    if (!setting && !allowsKeyless) {
      return reply.code(400).send({ message: "No API key saved for this provider" });
    }

    setting = setting ? await materializeLegacyKeys(user.id, parsed.data.provider, secret) ?? setting : null;

    const selected = setting
      ? (
          parsed.data.apiKeyId
            ? setting.apiKeys.find((item) => item.id === parsed.data.apiKeyId)
            : setting.apiKeys.find((item) => item.isActive && canDecryptApiKey(item.apiKeyEncrypted, secret))
              ?? setting.apiKeys.find((item) => canDecryptApiKey(item.apiKeyEncrypted, secret))
        )
      : undefined;

    if (!selected && !allowsKeyless) {
      return reply.code(400).send({ message: "No decryptable API key available. Paste the key again in Settings and save." });
    }

    let apiKey: string | undefined;
    if (selected) {
      try {
        apiKey = decryptText(selected.apiKeyEncrypted, secret);
      } catch (error) {
        app.log.error({
          keyId: selected.id,
          provider: parsed.data.provider,
          error: error instanceof Error ? error.message : String(error)
        }, "Decryption failed during refresh-models");
        return reply.code(400).send({ message: "Stored API key is invalid. Please re-save it in Settings." });
      }
    }

    const baseUrl = setting?.baseUrl ?? getDefaultBaseUrl(parsed.data.provider);
    const upstreamUrl = getProviderModelsUrl(parsed.data.provider, baseUrl);
    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined
    });

    if (!upstream.ok) {
      const details = await upstream.text();
      app.log.error(
        { provider: parsed.data.provider, url: upstreamUrl, status: upstream.status, details: details.substring(0, 500) },
        "Refresh-models upstream error"
      );
      return reply.code(400).send({
        message: `Provider rejected the request (status ${upstream.status})`,
        details: details || `status:${upstream.status}`
      });
    }

    let raw: unknown;
    try {
      raw = await upstream.json();
    } catch (error) {
      app.log.error(
        { provider: parsed.data.provider, url: upstreamUrl, error: error instanceof Error ? error.message : String(error) },
        "Refresh-models: failed to parse JSON"
      );
      return reply.code(502).send({
        message: "Provider returned a non-JSON response at /models",
        details: error instanceof Error ? error.message : String(error)
      });
    }

    const { models: fetched, source } = parseModelsResponse(raw);

    if (fetched.length === 0) {
      return reply.code(502).send({
        message: "Provider returned an empty model list. The response shape may be unsupported.",
        details: `source=${source}; body-type=${typeof raw}`
      });
    }

    // Decide which list to save. Default behaviour is REPLACE — the upstream
    // is the source of truth. With merge=true we union with whatever was
    // previously saved so user-curated entries aren't lost on a refresh.
    const existing = (setting?.models as string[] | null) ?? getDefaultModels(parsed.data.provider);
    const merged = parsed.data.merge
      ? Array.from(new Set([...existing, ...fetched])).sort((a, b) => a.localeCompare(b))
      : fetched;
    const diff = diffModelLists(existing, merged);

    if (setting) {
      const updated = await prisma.providerSetting.update({
        where: { id: setting.id },
        data: { models: merged },
        include: {
          apiKeys: {
            orderBy: { createdAt: "asc" }
          }
        }
      });
      return {
        models: updated.models as string[],
        added: diff.added,
        removed: diff.removed,
        source,
        replaced: parsed.data.merge !== true
      };
    }

    // No setting row yet (keyless provider) — create one with the fetched list.
    const created = await prisma.providerSetting.create({
      data: {
        userId: user.id,
        provider: parsed.data.provider,
        enabled: true,
        baseUrl,
        models: fetched
      }
    });
    return {
      models: created.models as string[],
      added: diff.added,
      removed: diff.removed,
      source,
      replaced: parsed.data.merge !== true
    };
  });

  // Get decrypted API key value
  const getApiKeySchema = z.object({
    provider: z.string(),
    apiKeyId: z.string().min(1)
  });

  app.post("/settings/get-api-key", async (request, reply) => {
    const parsed = getApiKeySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const secret = process.env.APP_SECRET;
    if (!secret) {
      return reply.code(500).send({ message: "APP_SECRET is not configured" });
    }

    const setting = await getSettingWithKeys(user.id, parsed.data.provider);
    if (!setting) {
      return reply.code(404).send({ message: "Provider settings not found" });
    }

    const apiKey = setting.apiKeys.find(k => k.id === parsed.data.apiKeyId);
    if (!apiKey) {
      return reply.code(404).send({ message: "API key not found" });
    }

    try {
      const decrypted = decryptText(apiKey.apiKeyEncrypted, secret);
      return {
        id: apiKey.id,
        name: apiKey.name,
        apiKey: decrypted,
        isActive: apiKey.isActive
      };
    } catch (error) {
      return reply.code(400).send({ message: "Failed to decrypt API key. It may be corrupted." });
    }
  });

  // Update API key name or value
  const updateApiKeySchema = z.object({
    provider: z.string(),
    apiKeyId: z.string().min(1),
    name: z.string().min(1).max(80).optional(),
    apiKey: z.string().min(1).optional()
  });

  app.patch("/settings/api-key", async (request, reply) => {
    const parsed = updateApiKeySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const secret = process.env.APP_SECRET;
    if (!secret) {
      return reply.code(500).send({ message: "APP_SECRET is not configured" });
    }

    const setting = await getSettingWithKeys(user.id, parsed.data.provider);
    if (!setting) {
      return reply.code(404).send({ message: "Provider settings not found" });
    }

    const existingKey = setting.apiKeys.find(k => k.id === parsed.data.apiKeyId);
    if (!existingKey) {
      return reply.code(404).send({ message: "API key not found" });
    }

    const updateData: { name?: string; apiKeyEncrypted?: string } = {};
    
    if (parsed.data.name) {
      updateData.name = parsed.data.name;
    }

    if (parsed.data.apiKey) {
      updateData.apiKeyEncrypted = encryptText(parsed.data.apiKey, secret);
    }

    await prisma.providerApiKey.update({
      where: { id: parsed.data.apiKeyId },
      data: updateData
    });

    return { ok: true };
  });

  app.put("/settings", async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const payload = parsed.data;
    const user = await getLocalUser();
    const secret = process.env.APP_SECRET;

    app.log.info({ provider: payload.provider, hasSecret: Boolean(secret) }, "Saving provider settings");

    if (!secret) {
      return reply.code(500).send({ message: "APP_SECRET is not configured" });
    }

    const baseUrl = payload.baseUrl ?? getDefaultBaseUrl(payload.provider);


    let setting = await prisma.providerSetting.upsert({
      where: {
        userId_provider: {
          userId: user.id,
          provider: payload.provider
        }
      },
      update: {
        enabled: payload.enabled,
        baseUrl: payload.baseUrl ?? baseUrl,
        models: payload.models,
        autoSwitchApiKey: payload.autoSwitchApiKey
      },
      create: {
        userId: user.id,
        provider: payload.provider,
        enabled: payload.enabled ?? true,
        baseUrl,
        models: payload.models ?? getDefaultModels(payload.provider),

        autoSwitchApiKey: payload.autoSwitchApiKey ?? false
      },
      include: {
        apiKeys: {
          orderBy: { createdAt: "asc" }
        }
      }
    });

    setting = await materializeLegacyKeys(user.id, payload.provider, secret) ?? setting;

    if (payload.removeApiKeyIds?.length) {
      await prisma.providerApiKey.deleteMany({
        where: {
          providerSettingId: setting.id,
          id: { in: payload.removeApiKeyIds }
        }
      });
    }

    let newlyCreatedApiKeyId: string | undefined;

    if (payload.apiKey?.trim()) {
      const encrypted = encryptText(payload.apiKey.trim(), secret);
      const createdKey = await prisma.providerApiKey.create({
        data: {
          providerSettingId: setting.id,
          name: payload.apiKeyName?.trim() || `API Key ${setting.apiKeys.length + 1}`,
          apiKeyEncrypted: encrypted
        }
      });
      newlyCreatedApiKeyId = createdKey.id;
      
      app.log.info({ keyId: createdKey.id }, 'API key saved to database');
    }

    let currentKeys = await prisma.providerApiKey.findMany({

      where: { providerSettingId: setting.id },
      orderBy: { createdAt: "asc" }
    });

    if (newlyCreatedApiKeyId) {
      const undecryptableKeyIds = currentKeys
        .filter((item) => item.id !== newlyCreatedApiKeyId && !canDecryptApiKey(item.apiKeyEncrypted, secret))
        .map((item) => item.id);

      if (undecryptableKeyIds.length > 0) {
        await prisma.providerApiKey.deleteMany({
          where: {
            providerSettingId: setting.id,
            id: { in: undecryptableKeyIds }
          }
        });

        currentKeys = await prisma.providerApiKey.findMany({
          where: { providerSettingId: setting.id },
          orderBy: { createdAt: "asc" }
        });
      }
    }

    const selectedApiKeyId = newlyCreatedApiKeyId ?? (payload.selectedApiKeyId === null

      ? undefined
      : payload.selectedApiKeyId ?? currentKeys.find((item) => item.isActive)?.id);


    const activeApiKeyId = currentKeys.some((item) => item.id === selectedApiKeyId)
      ? selectedApiKeyId
      : currentKeys[0]?.id;

    if (currentKeys.length > 0) {
      await prisma.providerApiKey.updateMany({
        where: { providerSettingId: setting.id },
        data: { isActive: false }
      });

      if (activeApiKeyId) {
        await prisma.providerApiKey.update({
          where: { id: activeApiKeyId },
          data: { isActive: true }
        });
      }
    }

    const finalSetting = await prisma.providerSetting.update({
      where: { id: setting.id },
      data: {
        enabled: payload.enabled ?? setting.enabled,
        baseUrl: payload.baseUrl ?? setting.baseUrl,
        models: payload.models ?? setting.models ?? getDefaultModels(payload.provider),

        autoSwitchApiKey: payload.autoSwitchApiKey ?? setting.autoSwitchApiKey
      },
      include: {
        apiKeys: {
          orderBy: { createdAt: "asc" }
        }
      }
    });

    return toSettingsResponse(finalSetting);
  });

  // Custom provider management
  app.get("/providers", async () => {
    const user = await getLocalUser();
    
    const customProviders = await prisma.providerSetting.findMany({
      where: {
        userId: user.id,
        isCustom: true
      },
      select: {
        provider: true,
        displayName: true,
        enabled: true,
        baseUrl: true,
        models: true
      }
    });

    const builtInProviders = [
      { provider: "gemini", displayName: "Gemini", isCustom: false },
      { provider: "puter", displayName: "Puter", isCustom: false },
      { provider: "ollama", displayName: "Ollama", isCustom: false },
      { provider: "nvidia", displayName: "NVIDIA", isCustom: false },
      { provider: "groq", displayName: "Groq", isCustom: false },
      { provider: "huggingface", displayName: "Hugging Face", isCustom: false },
      { provider: "minimax", displayName: "Minimax", isCustom: false },
      { provider: "openrouter", displayName: "OpenRouter", isCustom: false }
    ];

    return {
      providers: [
        ...builtInProviders,
        ...customProviders.map(p => ({
          provider: p.provider,
          displayName: p.displayName || p.provider,
          isCustom: true,
          enabled: p.enabled,
          baseUrl: p.baseUrl,
          models: p.models as string[] | null
        }))
      ]
    };
  });

  const createCustomProviderSchema = z.object({
    provider: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
    displayName: z.string().min(1).max(100),
    baseUrl: z.string().url(),
    models: z.array(z.string().min(1)).min(1)
  });

  app.post("/providers/custom", async (request, reply) => {
    const parsed = createCustomProviderSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }

    const user = await getLocalUser();
    const { provider, displayName, baseUrl, models } = parsed.data;

    // Check if provider already exists
    const existing = await prisma.providerSetting.findUnique({
      where: {
        userId_provider: {
          userId: user.id,
          provider
        }
      }
    });

    if (existing) {
      return reply.code(400).send({ message: "Provider with this ID already exists" });
    }

    const created = await prisma.providerSetting.create({
      data: {
        userId: user.id,
        provider,
        displayName,
        isCustom: true,
        enabled: true,
        baseUrl,
        models
      }
    });

    return {
      provider: created.provider,
      displayName: created.displayName,
      isCustom: true,
      enabled: created.enabled,
      baseUrl: created.baseUrl,
      models: created.models as string[]
    };
  });

  app.delete("/providers/custom/:provider", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const user = await getLocalUser();

    const existing = await prisma.providerSetting.findUnique({
      where: {
        userId_provider: {
          userId: user.id,
          provider
        }
      }
    });

    if (!existing) {
      return reply.code(404).send({ message: "Provider not found" });
    }

    if (!existing.isCustom) {
      return reply.code(400).send({ message: "Cannot delete built-in providers" });
    }

    await prisma.providerSetting.delete({
      where: {
        userId_provider: {
          userId: user.id,
          provider
        }
      }
    });

    return { ok: true };
  });
}
