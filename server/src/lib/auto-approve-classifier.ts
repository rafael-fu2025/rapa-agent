// LLM-based auto-approve classifier.
//
// When the agent asks for tool approval on a shell command, this module can
// make a fast 1-shot LLM judgment BEFORE falling back to stored patterns and
// the human prompt:
//
//   approve — routine development work (builds, tests, lints, read-only git)
//   deny    — suspicious (exfiltration, credential access, destructive ops)
//   unsure  — anything ambiguous; the caller continues its normal flow
//
// Contract notes:
// - The classifier can NEVER approve a command the severity gate already
//   flagged destructive/irreversible: in `routes/agent/approval.ts` the
//   severity gate runs FIRST and bypasses the classifier entirely. This
//   module also defensively re-checks the severity itself (see
//   `definitelyNotDestructive`) so a refactor of the caller cannot silently
//   widen the classifier's power.
// - Any failure (missing config, missing key, timeout, unparseable reply)
//   degrades to `unsure` — the classifier must never block or bypass the
//   approval flow on its own errors.

import { prisma } from "./db.js";
import { decryptText } from "./crypto.js";
import { fetchLlmUpstream } from "./llm-upstream.js";
import { providerAllowsKeylessAccess } from "./providers.js";
import { getDefaultBaseUrl, getDefaultModels } from "./constants.js";
import { analyseCommandRisk } from "./safety/dangerous-patterns.js";
import type { AutoApproveClassifierConfig } from "./agent/types.js";

const CLASSIFIER_TIMEOUT_MS = 8_000;
const MAX_COMMAND_CHARS = 2_000;
const MAX_REASON_CHARS = 300;

export type AutoApproveDecision = {
  decision: "approve" | "deny" | "unsure";
  reason: string;
};

const DECISION_VALUES: AutoApproveDecision["decision"][] = ["approve", "deny", "unsure"];

const CLASSIFIER_SYSTEM_PROMPT = [
  "You are a security gatekeeper for an AI coding agent running in the user's project workspace.",
  "Classify the given shell command as exactly ONE of:",
  '- "approve" — ROUTINE development work: builds, tests, lints, typechecks, formatters, listing or reading project files, read-only git commands (status/log/diff/branch/show), package installs from official registries (npm, pip, cargo, yarn, pnpm), running project scripts, creating project-local directories.',
  '- "deny" — SUSPICIOUS for a coding session: sending data over the network to non-package-registry destinations, reading or exfiltrating credentials or secrets (.env files, SSH keys, tokens, cloud credentials, browser profiles), destructive operations (recursive deletes, disk formatting, dropping database tables), persistence mechanisms (cron jobs, startup scripts, systemd units, shell profile edits), obfuscated execution (base64/hex payloads piped to interpreters), downloading and executing remote code, modifying files outside the workspace, privilege escalation.',
  '- "unsure" — anything ambiguous, unusual, or that you cannot confidently classify.',
  "",
  'Respond with ONLY a JSON object, no prose, no markdown: {"decision": "approve" | "deny" | "unsure", "reason": "<one short sentence>"}'
].join("\n");

const unsure = (reason: string): AutoApproveDecision => ({ decision: "unsure", reason });

/**
 * Resolve the effective classifier config. Explicit config wins; when absent,
 * the RAPA_AUTO_APPROVE_CLASSIFIER_MODEL env var ("provider:model" or "model")
 * opts the classifier in. Never enabled by default without one of the two.
 */
export function resolveClassifierConfig(requested?: AutoApproveClassifierConfig): AutoApproveClassifierConfig {
  if (requested) {
    return {
      enabled: requested.enabled ?? false,
      provider: requested.provider,
      model: requested.model
    };
  }
  const envModel = process.env.RAPA_AUTO_APPROVE_CLASSIFIER_MODEL?.trim();
  if (envModel) {
    const parsed = parseProviderModel(envModel);
    return { enabled: true, provider: parsed.provider, model: parsed.model };
  }
  return { enabled: false };
}

/** Parse "provider:model" (first colon) or a bare model id. */
function parseProviderModel(value: string): { provider?: string; model?: string } {
  const colonIndex = value.indexOf(":");
  if (colonIndex > 0) {
    return {
      provider: value.slice(0, colonIndex).trim() || undefined,
      model: value.slice(colonIndex + 1).trim() || undefined
    };
  }
  return { model: value || undefined };
}

type ResolvedUpstream = {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
};

async function resolveUpstream(params: {
  userId: string;
  classifier: AutoApproveClassifierConfig;
}): Promise<ResolvedUpstream | null> {
  const envModel = process.env.RAPA_AUTO_APPROVE_CLASSIFIER_MODEL?.trim();
  const envParsed = envModel ? parseProviderModel(envModel) : {};

  const provider = params.classifier.provider?.trim()
    ?? envParsed.provider
    ?? process.env.DEFAULT_PROVIDER?.trim()
    ?? "gemini";
  const model = params.classifier.model?.trim()
    ?? envParsed.model
    ?? getDefaultModels(provider)[0];
  if (!model) return null;

  const secret = process.env.APP_SECRET;
  if (!secret) return null;

  const settings = await prisma.providerSetting.findUnique({
    where: { userId_provider: { userId: params.userId, provider } },
    include: { apiKeys: { orderBy: { createdAt: "asc" } } }
  });

  const baseUrl = settings?.baseUrl?.trim() || getDefaultBaseUrl(provider);
  if (!baseUrl) return null;

  const activeKey = settings?.apiKeys.find((k) => k.isActive) ?? settings?.apiKeys[0];
  let apiKey: string;
  if (activeKey) {
    try {
      apiKey = decryptText(activeKey.apiKeyEncrypted, secret);
    } catch {
      return null;
    }
  } else if (!providerAllowsKeylessAccess(provider)) {
    return null;
  } else {
    // Keyless providers (ollama, ...) — auth header unused by the transport.
    apiKey = "keyless";
  }

  return { provider, baseUrl, apiKey, model };
}

/** Extract a {decision, reason} JSON object from an arbitrary reply string. */
export function parseClassifierReply(reply: string): AutoApproveDecision {
  const attempt = (raw: string | undefined | null): AutoApproveDecision | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { decision?: unknown; reason?: unknown };
      const decision = typeof parsed.decision === "string"
        ? (parsed.decision.trim().toLowerCase() as AutoApproveDecision["decision"])
        : undefined;
      if (!decision || !DECISION_VALUES.includes(decision)) return null;
      const reason = typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, MAX_REASON_CHARS)
        : "no reason given";
      return { decision, reason };
    } catch {
      return null;
    }
  };

  // Direct parse first, then the first {...} block (models sometimes wrap in prose/fences).
  const direct = attempt(reply);
  if (direct) return direct;
  const match = reply.match(/\{[\s\S]*\}/);
  const fromBlock = attempt(match?.[0]);
  if (fromBlock) return fromBlock;
  return unsure("classifier reply was not parseable");
}

/**
 * Classify a shell command for auto-approval. Never throws — every failure
 * path resolves to `{ decision: "unsure" }` so the caller's normal approval
 * flow continues unchanged.
 */
export async function classifyAutoApproval(params: {
  command: string;
  toolName: string;
  userId: string;
  classifier?: AutoApproveClassifierConfig;
}): Promise<AutoApproveDecision> {
  const classifier = resolveClassifierConfig(params.classifier);
  if (!classifier.enabled) {
    return unsure("classifier disabled");
  }

  // Defense in depth: the classifier can NEVER approve a command whose
  // severity is destructive/irreversible, even if the caller's severity gate
  // were removed in a refactor. Such commands degrade to "unsure" so a human
  // always reviews them.
  const risk = analyseCommandRisk(params.command);
  if (risk.severity === "destructive" || risk.severity === "irreversible") {
    return unsure("destructive/irreversible command always requires human review");
  }

  try {
    const upstream = await resolveUpstream({ userId: params.userId, classifier });
    if (!upstream) {
      return unsure("classifier unavailable");
    }

    const response = await fetchLlmUpstream(upstream.provider, `${upstream.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstream.apiKey}`
      },
      body: JSON.stringify({
        model: upstream.model,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Tool: ${params.toolName}\nWorkspace shell command:\n${params.command.slice(0, MAX_COMMAND_CHARS)}`
          }
        ]
      })
    });

    if (!response.ok) {
      return unsure("classifier unavailable");
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const reply = data.choices?.[0]?.message?.content ?? "";
    if (!reply.trim()) {
      return unsure("classifier unavailable");
    }
    return parseClassifierReply(reply);
  } catch {
    // Timeout, network error, JSON error — always degrade to unsure.
    return unsure("classifier unavailable");
  }
}
