// Per-provider reasoning-effort / thinking-mode translation.
//
// Different providers expose chain-of-thought control under different
// parameter names and with different value spaces. This module is the
// single place that turns the agent's normalized "reasoning effort"
// setting (`"off" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"`)
// into the right request-body field(s) for the target provider — clamping
// PER MODEL so a request never carries a value the model would 400 on.
// The set of levels a model actually supports lives in
// reasoning-capabilities.ts (single source of truth, shared with the UI).
//
// Why a dedicated module:
//   1. The `llm-client.ts` file is already large; this concern is small
//      and stable enough to live separately so the request-body builder
//      stays focused on streaming/retry/key-failover.
//   2. The translation rules are easy to unit-test in isolation — no
//      need to spin up a fake HTTP server or stub the agent loop.
//   3. The translation is the SAME whether the request came from the
//      chat route or the agent route, so it lives below the route layer
//      and is shared by both.
//
// Sources used to derive the mapping:
//   - OpenAI o-series / GPT-5.x docs — `reasoning_effort: low|medium|high`
//     (GPT-5.1+ also accepts `none` / `xhigh` — "none" == our "off",
//     which omits the parameter entirely).
//   - DeepSeek Reasoner / R1 — `reasoning_effort: high|max` (low/medium
//     silently ignored, but we still forward them for symmetry).
//   - Anthropic Claude 3.7–4.5 — `thinking: { type: "enabled", budget_tokens: N }`.
//   - Anthropic Claude Opus 4.7+ — `thinking: { type: "adaptive" }` +
//     top-level `effort: low|medium|high` (budget_tokens REMOVED in 4.7).
//   - Google Gemini 2.5/3.x — `thinking_budget: N` (integer tokens;
//     `0` = off, `-1` = dynamic). Per-model caps: Flash 24576, Pro 32768.
//   - OpenRouter — unified `reasoning: { effort, max_tokens? }` (or
//     `reasoning_effort` as a shortcut).
//   - Ollama — `think: true|false` (boolean). There is no per-tier
//     control, so anything but `"off"` becomes `true`.
//   - MiniMax M3 — `thinking: { type: "adaptive" }` is the default; we
//     only need to add `reasoning_split: true` to stream reasoning
//     separately from content. This is opt-in via env var because some
//     MiniMax deployments reject the field (see llm-client.ts).
//   - Puter — multi-vendor proxy. Whatever shape the underlying vendor
//     accepts, Puter passes through. We use the OpenAI-compatible shape
//     by default (`reasoning_effort`) which works for the OpenAI /
//     DeepSeek / OpenRouter upstream vendors it proxies.

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type ReasoningBudgetLevel = "off" | ReasoningEffort | "on";

/**
 * The canonical user-facing setting. `"off"` means "do not request
 * reasoning / thinking" (providers that always reason will still
 * reason a little; this is the best we can do without provider-level
 * opt-out support). `"on"` is the binary tier used by switch-style
 * models (MiniMax M3, Ollama).
 */
export type ReasoningSetting = ReasoningBudgetLevel;

/**
 * Result of translating a ReasoningSetting into provider-specific
 * body fields. Empty object means "don't add anything — the
 * provider either doesn't support reasoning control or the user
 * didn't set an effort".
 */
export type ReasoningTranslation = Record<string, unknown>;

/**
 * Anthropic Claude versions that *removed* the `budget_tokens` field
 * and switched to `thinking: { type: "adaptive" }` + a top-level
 * `effort` parameter. Anything matching this pattern gets the new
 * shape; older Claude models get the legacy `enabled` + budget_tokens
 * shape.
 *
 * Per https://platform.claude.com/docs/en/about-claude/models/migration-guide :
 *   "Extended thinking removed: thinking: {type: "enabled", budget_tokens: N}
 *    is no longer supported on Claude Opus 4.7 or later models and returns
 *    a 400 error."
 *
 * So the cutoff is *Opus 4.7+* (and any future 4.x ≥ 4-7, 5.x, 6.x).
 * Opus 4.5, 4.6 and all Sonnet/Haiku 4.5-4.6 still use the legacy shape.
 */
const CLAUDE_ADAPTIVE_EFFORT_PATTERN =
  /claude-(?:opus)-(?:4-(?:7|8|9|10|11|12)|[5-9]\d*)(?:-|$)/i;

/**
 * Map our effort tiers to a Claude `budget_tokens` integer. The defaults
 * are conservative — 1024 / 4096 / 16384 / 32768 — matching common
 * community guidance. Everything above high maps to 32768 because the
 * legacy shape had no native max; we don't want to silently spend the
 * user's full context budget on thinking.
 */
function claudeBudgetFromLevel(level: Exclude<ReasoningSetting, "off">): number {
  switch (level) {
    case "low":    return 1024;
    case "medium": return 4096;
    case "high":   return 16384;
    case "xhigh":
    case "max":
    case "ultra":
    case "on":     return 32768;
  }
}

/**
 * Map our effort tiers to a Gemini `thinking_budget` integer, respecting
 * the model's per-family cap: Flash models top out at 24576 tokens and
 * Pro / 3.x at 32768. Requesting more than the cap returns a 400 — the
 * old flat map sent 65536 for "max", which failed on EVERY Gemini 2.5
 * model.
 */
function geminiBudgetFromLevel(level: ReasoningSetting, model: string): number {
  const isFlash = /gemini-(?:2\.5|3)[^/]*-flash/i.test(model ?? "");
  const cap = isFlash ? 24_576 : 32_768;
  switch (level) {
    case "off":    return 0;
    case "low":    return 1024;
    case "medium": return 8192;
    case "high":   return 24_576;
    case "xhigh":
    case "max":
    case "ultra":  return cap;
    // Binary "on" (switch-style models never reach this translator —
    // only Gemini models do, which have no binary mode) — treat as high.
    case "on":     return 24_576;
  }
}

/**
 * Translate a ReasoningSetting to the right request-body fields for
 * the target provider/model. Returns an empty object if the
 * combination doesn't make sense (e.g. "off" on a provider that
 * always reasons, or unknown provider).
 *
 * IMPORTANT: This function is PURE — no env-var reads, no I/O —
 * so it's safe to call from any context (HTTP handler, agent loop,
 * unit test).
 */
export function translateReasoning(
  provider: string,
  model: string,
  setting: ReasoningSetting | undefined
): ReasoningTranslation {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModel = model ?? "";

  // Special case: MiniMax M3 is the only provider where "off" is a
  // first-class mode (it maps to `thinking: { type: "disabled" }`).
  // Every other provider treats "off" as "let the provider default"
  // which is the absence of any reasoning field. Handle MiniMax
  // BEFORE the early-return so we can route "off" through the switch.
  // For other providers the "off" check below still short-circuits.
  if (setting === "off" && normalizedProvider === "minimax") {
    return { thinking: { type: "disabled" } };
  }

  // No setting → emit nothing. The provider uses its own default
  // (usually "medium" for OpenAI o-series, dynamic for Gemini,
  // enabled for Claude 3.7+, etc.).
  if (!setting || setting === "off") {
    return {};
  }

  switch (normalizedProvider) {
    case "openai":
    case "azure-openai":
    case "deepseek":
    case "nvidia": {
      // NVIDIA NIM exposes reasoning_effort on o-series + DeepSeek
      // models it hosts. For everything else we still pass it through —
      // the provider returns 400 only if the field is invalid, not
      // for unknown models. The standard OpenAI-compatible shape is
      // `{ reasoning_effort: "low"|"medium"|"high" }`.
      //
      // GPT-5.1+ also accepts "xhigh" — forward it for those models and
      // clamp everything above high down for the rest, so strict
      // providers never see a value outside their enum.
      // (deepseek only honors "high" — lower tiers degrade gracefully.)
      const supportsXhigh = /gpt-5\.[1-9]/i.test(normalizedModel);
      const clamped = setting === "low" || setting === "medium" || setting === "high"
        ? setting
        : supportsXhigh ? "xhigh" : "high";
      return { reasoning_effort: clamped };
    }

    case "anthropic":
    case "claude": {
      // Two shapes depending on model version:
      //   - Claude 4.7+ and 5.x → adaptive + effort (low/medium/high only)
      //   - Claude 3.7 – 4.5  → enabled + budget_tokens
      if (CLAUDE_ADAPTIVE_EFFORT_PATTERN.test(normalizedModel)) {
        return {
          thinking: { type: "adaptive" },
          effort: setting === "low" || setting === "medium" ? setting : "high"
        };
      }
      return {
        thinking: {
          type: "enabled",
          budget_tokens: claudeBudgetFromLevel(setting)
        }
      };
    }

    case "gemini": {
      // Gemini's OpenAI-compat endpoint accepts `thinking_budget` as a
      // top-level body field (the official .../v1beta/openai endpoint).
      // Budgets are capped per model family — Flash 24576, Pro/3.x
      // 32768 — via geminiBudgetFromLevel(level, model).
      return { thinking_budget: geminiBudgetFromLevel(setting, normalizedModel) };
    }

    case "ollama": {
      // Ollama has no effort tiers — only `think: true|false`. Map
      // any non-off setting to `true`. Ollama models that natively
      // reason (DeepSeek R1, QwQ, etc.) will then expose their CoT
      // via the `thinking` field in the response stream.
      return { think: true };
    }

    case "openrouter": {
      // OpenRouter's unified `reasoning` envelope. The `effort` field
      // accepts `low` / `medium` / `high` for most models and `xhigh`
      // on routes that support it (GPT-5.1). We pass through up to
      // `max` for vendors that recognize it (DeepSeek); `ultra` clamps
      // to `xhigh` — the envelope's documented ceiling.
      return {
        reasoning: {
          effort: setting === "ultra" ? "xhigh" : setting
        }
      };
    }

    case "puter": {
      // Puter proxies underlying vendors. The OpenAI-compat
      // `/puterai/openai/v1/chat/completions` endpoint forwards
      // unknown body fields to the upstream, so `reasoning_effort`
      // is the safest universal shape (works for the OpenAI /
      // DeepSeek / OpenRouter upstreams Puter serves).
      // Clamp everything above high → high: the upstreams Puter serves
      // reject non-enum values.
      return {
        reasoning_effort: setting === "low" || setting === "medium" || setting === "high"
          ? setting
          : "high"
      };
    }

    case "minimax": {
      // MiniMax M3's native thinking control is the `thinking` field
      // (per the OpenAI-compat API spec at
      // https://platform.minimax.io/docs/api-reference/text-chat-openai):
      //
      //   thinking: { type: "disabled" }  — skip thinking (M3 only;
      //                                    M2.x silently keeps thinking on)
      //   thinking: { type: "adaptive" }  — let the model decide
      //                                    (the default; equivalent to
      //                                    thinking on for M3)
      //
      // The "off" setting is handled by the early-return block above
      // (which routes MiniMax → `thinking: { type: "disabled" }`).
      // This switch only runs for the four "on" tiers, all of which
      // collapse to adaptive because M3 has no per-tier thinking-budget
      // parameter — it's a single on/off switch.
      //
      // `reasoning_split: true` is still emitted by
      // buildProviderRequestExtras() so the stream parser can read
      // the thinking content from `reasoning_details` instead of
      // embedded `<think>` tags. That path is independent of this
      // translator.
      return { thinking: { type: "adaptive" } };
    }

    case "huggingface":
    case "groq":
    case "custom": {
      // These are OpenAI-compatible pass-throughs. Forward
      // reasoning_effort as-is; the upstream either honors it (some
      // Hugging Face routers do) or ignores it.
      return { reasoning_effort: setting };
    }

    default: {
      // Unknown provider — emit nothing rather than guess. Better to
      // silently degrade than to inject a parameter that could
      // trigger a 400.
      return {};
    }
  }
}

// ─── Capability map ─────────────────────────────────────────────────────────
//
// The provider set, model denylist, per-model effort profiles, and the
// snap-to-nearest ladder live in reasoning-capabilities.ts — the single
// source of truth shared by the translator, the /reasoning-profile
// endpoint, and the frontend picker. Re-exported here so existing imports
// (llm-client tests, the frontend mirror being deleted) keep working.

export {
  REASONING_CAPABLE_PROVIDERS,
  NON_REASONING_MODEL_PATTERNS,
  isReasoningCapable
} from "./reasoning-capabilities.js";
