// Per-model reasoning-effort capabilities — the single source of truth for
// WHAT effort levels a (provider, model) pair actually supports.
//
// The old world: one generalized 5-option list (off/low/medium/high/max)
// shown for every reasoning-capable model, with a provider set + regex
// denylist duplicated between the backend (reasoning-translator.ts) and the
// frontend (model-selector.tsx, "kept in sync manually").
//
// The honest world: models differ —
//   - MiniMax M3 / Ollama: on/off only (binary)
//   - OpenAI o-series / GPT-5 / Claude-adaptive: low/medium/high (standard)
//   - GPT-5.1+: adds xhigh
//   - Claude legacy budget / Gemini Pro: extends to max
//   - Qwen3-Max / GLM-5 style: extends to ultra
// This module encodes that as a data-driven pattern table; the picker in
// the UI renders exactly what the profile says, and translateReasoning()
// clamps per model so requests never carry values the model would 400 on.
//
// Resolution order (getReasoningProfile):
//   1. model-pattern table (most specific first)
//   2. provider default (capable provider → standard)
//   3. denylist → style "none" (always-reasons or non-reasoning models)
// Upstream /models metadata (when a provider serves it — see
// provider-models.ts extractReasoningMetadata) can override the provider
// default via the /api/settings/reasoning-profile endpoint.

/** The full closed value space. Ordered by effort; "on" is the binary tier. */
export type EffortLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "on";

/** Picker shape: what kind of control the model exposes. */
export type EffortStyle = "none" | "binary" | "standard" | "extended";

export type ReasoningProfile = {
  style: EffortStyle;
  /** Ordered levels the UI may offer. Always starts with "off". */
  levels: EffortLevel[];
  source: "model-pattern" | "provider-default" | "upstream-metadata" | "denylist";
};

const STANDARD_LEVELS: EffortLevel[] = ["off", "low", "medium", "high"];

type PatternEntry = {
  pattern: RegExp;
  style: EffortStyle;
  levels: EffortLevel[];
};

/**
 * Ordered model-pattern table — FIRST match wins, so specific patterns must
 * precede generic ones. Adding support for a new model is one line here.
 */
const MODEL_EFFORT_PATTERNS: PatternEntry[] = [
  // ── OpenAI family ──────────────────────────────────────────────────────
  // GPT-5.1+ accepts none/low/medium/high/xhigh ("none" == our "off":
  // omit the parameter entirely, which is already the off behavior).
  { pattern: /gpt-5\.[1-9]/i, style: "extended", levels: ["off", "low", "medium", "high", "xhigh"] },
  { pattern: /gpt-5(?!\.\d)/i, style: "standard", levels: STANDARD_LEVELS },
  { pattern: /^o[1-9]/i, style: "standard", levels: STANDARD_LEVELS },

  // ── Anthropic ──────────────────────────────────────────────────────────
  // Opus 4.7+/5.x: adaptive + effort (low/medium/high only — no max).
  {
    pattern: /claude-(?:opus)-(?:4-(?:7|8|9|10|11|12)|[5-9]\d*)(?:-|$)/i,
    style: "standard",
    levels: STANDARD_LEVELS
  },
  // Claude 3.7 – 4.5 legacy budget_tokens: low..max (max = 32768).
  { pattern: /claude-/i, style: "extended", levels: ["off", "low", "medium", "high", "max"] },

  // ── Google Gemini ──────────────────────────────────────────────────────
  // Flash models cap at a 24576-token budget — "max" (65536) would 400.
  // (Checked first so the pro pattern below can stay simple.)
  { pattern: /gemini-(?:2\.5|3)[^/]*-flash/i, style: "standard", levels: STANDARD_LEVELS },
  // Pro / plain 3.x cap at 32768 — max maps there, not 65536.
  { pattern: /gemini-(?:2\.5-pro|3)/i, style: "extended", levels: ["off", "low", "medium", "high", "max"] },

  // ── MiniMax ────────────────────────────────────────────────────────────
  // M3 is a single on/off switch (thinking: disabled | adaptive).
  { pattern: /MiniMax-M3/i, style: "binary", levels: ["off", "on"] },
  // M2.x cannot disable thinking at all → denylist style below.

  // ── Extended-tier vendors (ultra) ──────────────────────────────────────
  { pattern: /qwen3-max|qwen3\.5/i, style: "extended", levels: ["off", "low", "medium", "high", "max", "ultra"] },
  { pattern: /glm-(?:4\.[7-9]|5)/i, style: "extended", levels: ["off", "low", "medium", "high", "max", "ultra"] }
];

/** Providers with meaningful reasoning control at the provider level. */
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
  // MiniMax M3 supports thinking: disabled|adaptive. M2.x is gated by the
  // denylist pattern below (can't disable thinking).
  "minimax"
]);

/**
 * Model patterns that never surface the picker: non-reasoning models, and
 * models that always reason with no way to control it.
 */
export const NON_REASONING_MODEL_PATTERNS: RegExp[] = [
  /^gpt-4o(?!-mini)/i,                 // gpt-4o, gpt-4o-2024-… (no mini)
  /^gpt-4(?!-turbo|-o|-5)/i,           // plain gpt-4
  /^gemini-2\.0-/i,                    // gemini-2.0 family
  /^gemini-1\./i,                      // legacy
  /^claude-(?:3-(?:opus|sonnet|haiku)|3-5-sonnet)$/i,  // pre-3.7
  /^text-embedding-/i,
  /^claude-fable-/i,                   // not always a reasoning model
  // MiniMax M2.x — "cannot disable thinking"; the field is accepted but
  // silently ignored. Hide the control rather than expose a dead setting.
  /^MiniMax-M2(?:\.\d+)?(?:-highspeed)?$/i
];

/**
 * Resolve the reasoning profile for a (provider, model) pair. Pure —
 * no I/O, no env reads; safe from any context.
 */
export function getReasoningProfile(provider: string, model: string): ReasoningProfile {
  const normalizedProvider = provider.toLowerCase();
  const modelName = model ?? "";

  if (NON_REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(modelName))) {
    return { style: "none", levels: [], source: "denylist" };
  }

  if (normalizedProvider === "ollama") {
    // Ollama exposes think: true|false only — provider-wide binary.
    return { style: "binary", levels: ["off", "on"], source: "provider-default" };
  }

  const matched = MODEL_EFFORT_PATTERNS.find((entry) => entry.pattern.test(modelName));
  if (matched) {
    return { style: matched.style, levels: matched.levels, source: "model-pattern" };
  }

  if (REASONING_CAPABLE_PROVIDERS.has(normalizedProvider)) {
    // Known-capable provider, unrecognized model name: offer the tiers
    // every supported model accepts. The translator still clamps per
    // model, so nothing here can 400 a request.
    return { style: "standard", levels: STANDARD_LEVELS, source: "provider-default" };
  }

  return { style: "none", levels: [], source: "denylist" };
}

/** Total order of effort levels, low → high. "off" is the floor. */
const EFFORT_ORDER: Exclude<EffortLevel, "on">[] = ["off", "low", "medium", "high", "xhigh", "max", "ultra"];
/** Binary "on" sits at "high" conceptually — nearest-down maps it there. */
const BINARY_ON_EQUIVALENT: Exclude<EffortLevel, "on"> = "high";

/**
 * Snap an effort level down to the nearest level a profile supports.
 * Ladder: ultra→max→xhigh→high→medium→low→off. Binary "on" snaps down
 * from "high". Falls back to "off" (including for the "none" profile).
 */
export function snapEffortToProfile(current: EffortLevel, profile: ReasoningProfile): EffortLevel {
  // Exact membership always wins — keeps binary "on" stable.
  if (profile.levels.includes(current)) return current;
  const normalized: Exclude<EffortLevel, "on"> = current === "on" ? BINARY_ON_EQUIVALENT : current;
  let index = EFFORT_ORDER.indexOf(normalized);
  if (index === -1) index = 0;
  while (index >= 0) {
    const candidate = EFFORT_ORDER[index];
    if (profile.levels.includes(candidate)) return candidate;
    index -= 1;
  }
  return "off";
}

/**
 * Decide whether a (provider, model) pair should surface the reasoning
 * control at all. Kept for backward compatibility with existing imports.
 */
export function isReasoningCapable(provider: string, model: string): boolean {
  return getReasoningProfile(provider, model).style !== "none";
}

/**
 * Normalize raw upstream effort-level strings (from a provider's /models
 * metadata) into our EffortLevel space. Recognized aliases:
 *   "none" → treated as unsupported metadata (our "off" is the absence of
 *   the parameter, not an explicit disable we need to send).
 * Returns null when nothing usable remains.
 */
export function levelsFromUpstreamValues(values: string[]): EffortLevel[] | null {
  const allowed: EffortLevel[] = ["off", "low", "medium", "high", "xhigh", "max", "ultra", "on"];
  const seen = new Set<EffortLevel>();
  for (const raw of values) {
    const value = raw.trim().toLowerCase();
    if ((allowed as string[]).includes(value)) {
      seen.add(value as EffortLevel);
    }
  }
  // A usable profile needs at least one "on" tier (an ["off"] or ["none"]
  // list means the model has no controllable reasoning).
  const onTiers = [...seen].filter((v) => v !== "off");
  if (onTiers.length === 0) return null;
  const ordered = allowed.filter((v) => seen.has(v));
  return ordered;
}
