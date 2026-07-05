// Per-provider reasoning-effort / thinking-mode translation.
//
// Different providers expose chain-of-thought control under different
// parameter names and with different value spaces. This module is the
// single place that turns the agent's normalized "reasoning effort"
// setting (`"off" | "low" | "medium" | "high" | "max"`) into the
// right request-body field(s) for the target provider.
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
// Sources used to derive the mapping (see docs/REASONING_PROVIDERS.md):
//   - OpenAI o-series / GPT-5.x docs — `reasoning_effort: low|medium|high`
//     (GPT-5.1+ also accepts `none` / `xhigh`; we keep the closed set
//     that every supported model accepts).
//   - DeepSeek Reasoner / R1 — `reasoning_effort: high|max` (low/medium
//     silently ignored, but we still forward them for symmetry).
//   - Anthropic Claude 3.7–4.5 — `thinking: { type: "enabled", budget_tokens: N }`.
//   - Anthropic Claude Opus 4.7+ — `thinking: { type: "adaptive" }` +
//     top-level `effort: low|medium|high` (budget_tokens REMOVED in 4.7).
//   - Google Gemini 2.5/3.x — `thinking_budget: N` (integer tokens;
//     `0` = off, `-1` = dynamic).
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

export type ReasoningEffort = "low" | "medium" | "high" | "max";

export type ReasoningBudgetLevel = "off" | "low" | "medium" | "high" | "max";

/**
 * The canonical user-facing setting. `"off"` means "do not request
 * reasoning / thinking" (providers that always reason will still
 * reason a little; this is the best we can do without provider-level
 * opt-out support).
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
 * Map our 5-tier `ReasoningSetting` to a Claude `budget_tokens`
 * integer. The defaults are conservative — 1024 / 4096 / 16384 / 32768
 * — matching common community guidance. `max` doubles `high` because
 * the legacy shape had no native `max`; we don't want to silently
 * spend the user's full context budget on thinking.
 */
function claudeBudgetFromLevel(level: Exclude<ReasoningSetting, "off">): number {
  switch (level) {
    case "low":    return 1024;
    case "medium": return 4096;
    case "high":   return 16384;
    case "max":    return 32768;
  }
}

/**
 * Map our 5-tier `ReasoningSetting` to a Gemini `thinking_budget`
 * integer. Gemini accepts:
 *   - `0`  → thinking disabled (where supported)
 *   - `N`  → max N tokens used for thinking
 *   - `-1` → dynamic / "let the model decide"
 *
 * We use:
 *   - off    → 0
 *   - low    → 1024
 *   - medium → 8192
 *   - high   → 24576
 *   - max    → 65536
 *
 * (Gemini 2.5+ tops out at 24576 for Flash and 32768 for Pro; we
 * clamp by passing these values — the provider returns 400 if the
 * model-specific max is exceeded. Callers can override per-model by
 * passing a different `thinkingBudget` if/when we expose that.)
 */
function geminiBudgetFromLevel(level: ReasoningSetting): number {
  switch (level) {
    case "off":    return 0;
    case "low":    return 1024;
    case "medium": return 8192;
    case "high":   return 24576;
    case "max":    return 65536;
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
      // NOTE: deepseek only honors "high" and "max" — low/medium are
      // silently dropped. That's fine: it degrades gracefully.
      return { reasoning_effort: setting };
    }

    case "anthropic":
    case "claude": {
      // Two shapes depending on model version:
      //   - Claude 4.7+ and 5.x → adaptive + effort
      //   - Claude 3.7 – 4.5  → enabled + budget_tokens
      if (CLAUDE_ADAPTIVE_EFFORT_PATTERN.test(normalizedModel)) {
        return {
          thinking: { type: "adaptive" },
          effort: setting === "max" ? "high" : setting
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
      // Gemini is special: its OpenAI-compat endpoint accepts an
      // `extra_body` style for `thinking_budget`. Most OpenAI-compat
      // proxies for Gemini (including Google's own
      // `generativelanguage.googleapis.com/v1beta/openai` endpoint)
      // accept the parameter as a top-level body field rather than
      // wrapping it in `extra_body`.
      //
      // The base URL used in this codebase is the official
      // `.../v1beta/openai` endpoint, so a top-level field is the
      // right place. If a future proxy rejects this shape, callers
      // can override by extending this switch.
      return { thinking_budget: geminiBudgetFromLevel(setting) };
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
      // accepts `low` / `medium` / `high` for most models. We pass
      // through `max` for vendors that recognize it (DeepSeek); the
      // envelope degrades to a no-op on providers that don't.
      return {
        reasoning: {
          effort: setting
        }
      };
    }

    case "puter": {
      // Puter proxies underlying vendors. The OpenAI-compat
      // `/puterai/openai/v1/chat/completions` endpoint forwards
      // unknown body fields to the upstream, so `reasoning_effort`
      // is the safest universal shape (works for the OpenAI /
      // DeepSeek / OpenRouter upstreams Puter serves).
      return { reasoning_effort: setting };
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

/**
 * Static capability map for the UI: which providers + model-prefixes
 * have meaningful reasoning-control support. This is intentionally
 * coarse-grained — the actual per-model decision is in
 * `translateReasoning()`. The UI uses this list to decide whether to
 * show the effort dropdown at all (e.g. hide it for MiniMax since
 * we don't actually wire a setting, hide it for Hugging Face
 * because most hosted models don't honor the param).
 */
export const REASONING_CAPABLE_PROVIDERS = new Set<string>([
  "openai",
  "azure-openai",
  "deepseek",
  "nvidia",
  "anthropic",
  "claude",
  "gemini",
  "ollama",
  "openrouter",
  "puter",
  // MiniMax M3 supports the `thinking: { type: "disabled" | "adaptive" }`
  // control. M2.x is intentionally not separately gated here — see the
  // `MINIMAX_NO_REASONING_CONTROL` pattern below, which hides the
  // dropdown for M2.x models because they can't actually disable
  // thinking (the API silently ignores the field).
  "minimax"
]);

/**
 * Test/model-prefix patterns that the UI uses to hide the reasoning
 * dropdown even for a normally-capable provider. e.g. regular
 * `gpt-4o` and `gemini-2.0-flash` are not reasoning models — they
 * ignore reasoning_effort and don't emit thinking tokens.
 */
export const NON_REASONING_MODEL_PATTERNS: RegExp[] = [
  /^gpt-4o(?!-mini)/i,                 // gpt-4o, gpt-4o-2024-… (no mini)
  /^gpt-4(?!-turbo|-o|-5)/i,           // plain gpt-4
  /^gemini-2\.0-/i,                    // gemini-2.0 family
  /^gemini-1\./i,                      // legacy
  /^claude-(?:3-(?:opus|sonnet|haiku)|3-5-sonnet)$/i,  // pre-3.7
  /^text-embedding-/i,
  /^claude-fable-/i,                   // not always a reasoning model
  // MiniMax M2.x family — per the API docs these models "cannot
  // disable thinking" and the `thinking: { type: "disabled" }` field
  // is accepted but silently ignored. We hide the dropdown for them
  // rather than expose a setting that doesn't work.
  /^MiniMax-M2(?:\.\d+)?(?:-highspeed)?$/i
];

/**
 * Decide whether a (provider, model) pair should surface the
 * reasoning-effort control. This is a soft check — the dropdown is
 * still safe to show for non-reasoning models (they will just
 * ignore the parameter), but hiding it makes the UI less noisy.
 */
export function isReasoningCapable(provider: string, model: string): boolean {
  const normalizedProvider = provider.toLowerCase();
  if (!REASONING_CAPABLE_PROVIDERS.has(normalizedProvider)) {
    return false;
  }
  if (NON_REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(model))) {
    return false;
  }
  return true;
}
