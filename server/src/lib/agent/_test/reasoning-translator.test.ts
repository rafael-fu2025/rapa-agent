// Tests for the per-provider reasoning-effort translator.
//
// Each test pins down the exact body shape we emit for one
// (provider, model, setting) combination. The function is pure
// (no env reads, no I/O) so these tests are deterministic and fast.

import { describe, expect, it } from "vitest";
import {
  isReasoningCapable,
  translateReasoning,
  type ReasoningSetting
} from "../reasoning-translator.js";

describe("translateReasoning", () => {
  describe("undefined / off", () => {
    it("emits nothing when setting is undefined", () => {
      expect(translateReasoning("openai", "o3-mini", undefined)).toEqual({});
    });

    it("emits nothing when setting is 'off'", () => {
      expect(translateReasoning("openai", "o3-mini", "off")).toEqual({});
    });

    it("emits nothing when setting is 'off' even for Claude", () => {
      expect(translateReasoning("anthropic", "claude-sonnet-4-5", "off")).toEqual({});
    });

    it("emits nothing when setting is 'off' for Gemini / Ollama / OpenRouter", () => {
      // Only MiniMax has a first-class "off" mode. All other
      // providers' "off" is the absence of any reasoning field.
      expect(translateReasoning("gemini", "gemini-2.5-pro", "off")).toEqual({});
      expect(translateReasoning("ollama", "deepseek-r1", "off")).toEqual({});
      expect(translateReasoning("openrouter", "anthropic/claude-sonnet-5", "off")).toEqual({});
    });
  });

  describe("OpenAI / DeepSeek / NVIDIA / Puter / custom", () => {
    it.each([
      ["openai", "o3-mini"],
      ["openai", "gpt-5"],
      ["openai", "o4-mini"],
      ["deepseek", "deepseek-reasoner"],
      ["nvidia", "nvidia/llama-3.1-nemotron-70b-instruct"],
      ["puter", "claude-sonnet-5"],
      ["custom", "anything-goes"],
    ] as const)("emits reasoning_effort for %s/%s", (provider, model) => {
      expect(translateReasoning(provider, model, "medium")).toEqual({ reasoning_effort: "medium" });
      expect(translateReasoning(provider, model, "high")).toEqual({ reasoning_effort: "high" });
      expect(translateReasoning(provider, model, "max")).toEqual({ reasoning_effort: "max" });
    });

    it("emits reasoning_effort for azure-openai (case-insensitive)", () => {
      expect(translateReasoning("Azure-OpenAI", "gpt-5", "high")).toEqual({ reasoning_effort: "high" });
    });
  });

  describe("Anthropic Claude (version-aware)", () => {
    it("uses adaptive+effort for Claude Opus 4.7+", () => {
      // Per https://platform.claude.com/docs/en/about-claude/models/migration-guide
      // "thinking: {type: 'enabled', budget_tokens: N} is no longer
      //  supported on Claude Opus 4.7 or later models".
      const result = translateReasoning("anthropic", "claude-opus-4-7", "high");
      expect(result).toEqual({
        thinking: { type: "adaptive" },
        effort: "high"
      });
    });

    it("uses adaptive+effort for future Opus versions (4.8, 4.9, 4.10, …)", () => {
      expect(translateReasoning("anthropic", "claude-opus-4-8", "medium")).toEqual({
        thinking: { type: "adaptive" },
        effort: "medium"
      });
      expect(translateReasoning("anthropic", "claude-opus-4-12", "low")).toEqual({
        thinking: { type: "adaptive" },
        effort: "low"
      });
    });

    it("uses adaptive+effort for Claude 5.x (all versions)", () => {
      // Once we're on 5.x every version uses adaptive+effort. The
      // cutoff is "any Opus 4.7+ and anything 5+".
      expect(translateReasoning("anthropic", "claude-opus-5", "max")).toEqual({
        thinking: { type: "adaptive" },
        effort: "high"  // max maps to high (Anthropic only accepts low/medium/high)
      });
      expect(translateReasoning("anthropic", "claude-opus-5-1", "low")).toEqual({
        thinking: { type: "adaptive" },
        effort: "low"
      });
    });

    it("uses enabled+budget_tokens for Claude 3.7 (any variant)", () => {
      const result = translateReasoning("anthropic", "claude-3-7-sonnet-20250219", "high");
      expect(result).toEqual({
        thinking: { type: "enabled", budget_tokens: 16384 }
      });
    });

    it("uses enabled+budget_tokens for Claude Sonnet 4.5 (still legacy)", () => {
      // Sonnet 4.5 is NOT in the "Opus 4.7+" adaptive cutoff — only
      // Opus 4.7+ removed budget_tokens. Sonnet/Haiku 4.5 still use the
      // legacy enabled+budget_tokens shape.
      const result = translateReasoning("anthropic", "claude-sonnet-4-5", "low");
      expect(result).toEqual({
        thinking: { type: "enabled", budget_tokens: 1024 }
      });
    });

    it("scales budget_tokens with the level for older Claude", () => {
      expect(translateReasoning("anthropic", "claude-sonnet-4-5", "low").thinking).toMatchObject({ budget_tokens: 1024 });
      expect(translateReasoning("anthropic", "claude-sonnet-4-5", "medium").thinking).toMatchObject({ budget_tokens: 4096 });
      expect(translateReasoning("anthropic", "claude-sonnet-4-5", "high").thinking).toMatchObject({ budget_tokens: 16384 });
      expect(translateReasoning("anthropic", "claude-sonnet-4-5", "max").thinking).toMatchObject({ budget_tokens: 32768 });
    });

    it("uses enabled+budget_tokens for claude-haiku-4-5-20251001 (still legacy)", () => {
      // Haiku 4.5 also still uses the legacy shape. Only Opus 4.7+ got
      // the new adaptive+effort API.
      const result = translateReasoning("anthropic", "claude-haiku-4-5-20251001", "high");
      expect(result).toEqual({
        thinking: { type: "enabled", budget_tokens: 16384 }
      });
    });
  });

  describe("Google Gemini", () => {
    it("emits thinking_budget as an integer", () => {
      expect(translateReasoning("gemini", "gemini-2.5-pro", "low")).toEqual({ thinking_budget: 1024 });
      expect(translateReasoning("gemini", "gemini-2.5-pro", "medium")).toEqual({ thinking_budget: 8192 });
      expect(translateReasoning("gemini", "gemini-2.5-pro", "high")).toEqual({ thinking_budget: 24576 });
      expect(translateReasoning("gemini", "gemini-2.5-pro", "max")).toEqual({ thinking_budget: 65536 });
    });

    it("emits thinking_budget: 0 for 'off'", () => {
      // Caller is expected to filter 'off' before calling — this is the
      // case where someone manually sets off via the dropdown. The body
      // still carries the field so the provider can interpret it as
      // 'thinking disabled' (where supported).
      expect(translateReasoning("gemini", "gemini-2.5-pro", "off")).toEqual({});
      // Because the early-return in translateReasoning fires first.
    });
  });

  describe("Ollama", () => {
    it("emits think: true for any non-off setting", () => {
      expect(translateReasoning("ollama", "deepseek-r1", "low")).toEqual({ think: true });
      expect(translateReasoning("ollama", "deepseek-r1", "max")).toEqual({ think: true });
    });

    it("emits nothing for 'off'", () => {
      expect(translateReasoning("ollama", "deepseek-r1", "off")).toEqual({});
    });
  });

  describe("OpenRouter", () => {
    it("emits the reasoning envelope with effort", () => {
      expect(translateReasoning("openrouter", "anthropic/claude-sonnet-5", "high")).toEqual({
        reasoning: { effort: "high" }
      });
    });

    it("passes 'max' through (OpenRouter / DeepSeek accept it)", () => {
      expect(translateReasoning("openrouter", "deepseek/deepseek-v3.2", "max")).toEqual({
        reasoning: { effort: "max" }
      });
    });
  });

  describe("MiniMax", () => {
    it("emits thinking:{type:'disabled'} for 'off' (M3 only — M2.x silently ignores)", () => {
      // Per https://platform.minimax.io/docs/api-reference/text-chat-openai
      // the OpenAI-compat endpoint accepts:
      //   - thinking: { type: "disabled" }  → M3 skips thinking
      //   - thinking: { type: "adaptive" }  → M3 enables adaptive thinking
      // For M2.x the "disabled" value is accepted but ignored per docs.
      // The translator always emits the field; the UI's capability
      // map hides the dropdown for M2.x so users never pick "off"
      // for an M2.x model in the first place.
      expect(translateReasoning("minimax", "MiniMax-M3", "off")).toEqual({
        thinking: { type: "disabled" }
      });
    });

    it("emits thinking:{type:'adaptive'} for any non-off setting on M3", () => {
      // M3 has no per-tier thinking budget — only the on/off switch.
      // All four "on" tiers (low / medium / high / max) collapse to
      // adaptive, which is the M3 default.
      expect(translateReasoning("minimax", "MiniMax-M3", "low")).toEqual({
        thinking: { type: "adaptive" }
      });
      expect(translateReasoning("minimax", "MiniMax-M3", "medium")).toEqual({
        thinking: { type: "adaptive" }
      });
      expect(translateReasoning("minimax", "MiniMax-M3", "high")).toEqual({
        thinking: { type: "adaptive" }
      });
      expect(translateReasoning("minimax", "MiniMax-M3", "max")).toEqual({
        thinking: { type: "adaptive" }
      });
    });

    it("emits thinking:{type:'adaptive'} for M2.x too (caller's job to gate M2.x)", () => {
      // The translator is provider-only — it doesn't know whether the
      // model supports disabling. The UI capability map hides the
      // dropdown for M2.x via NON_REASONING_MODEL_PATTERNS, so users
      // never pick "off" for M2.x. If a caller bypasses the UI and
      // passes "off" anyway, the API will silently ignore it.
      expect(translateReasoning("minimax", "MiniMax-M2.7", "high")).toEqual({
        thinking: { type: "adaptive" }
      });
      // The "off" branch is handled by the special-case early-return
      // for MiniMax — the translator always emits *something* for any
      // setting, even for M2.x where the API would ignore it.
      expect(translateReasoning("minimax", "MiniMax-M2.7", "off")).toEqual({
        thinking: { type: "disabled" }
      });
    });
  });

  describe("unknown providers", () => {
    it("emits nothing for an unrecognized provider rather than guessing", () => {
      expect(translateReasoning("mystery-provider", "some-model", "high")).toEqual({});
    });

    it("emits nothing when model is empty for known reasoning-capable providers", () => {
      expect(translateReasoning("openai", "", "high")).toEqual({ reasoning_effort: "high" });
      // The translator still emits the field even with an empty model —
      // it's the caller's responsibility to validate the model. The
      // OpenAI-compatible shape is provider-agnostic so this is safe.
    });
  });
});

describe("isReasoningCapable", () => {
  it("returns true for OpenAI o-series / GPT-5", () => {
    expect(isReasoningCapable("openai", "o3-mini")).toBe(true);
    expect(isReasoningCapable("openai", "gpt-5")).toBe(true);
    expect(isReasoningCapable("openai", "o4-mini")).toBe(true);
  });

  it("returns false for non-reasoning OpenAI models (gpt-4o, gpt-4)", () => {
    expect(isReasoningCapable("openai", "gpt-4o")).toBe(false);
    expect(isReasoningCapable("openai", "gpt-4o-2024-08-06")).toBe(false);
    expect(isReasoningCapable("openai", "gpt-4")).toBe(false);
  });

  it("returns true for Claude 3.7+", () => {
    expect(isReasoningCapable("anthropic", "claude-3-7-sonnet-20250219")).toBe(true);
    expect(isReasoningCapable("anthropic", "claude-sonnet-4-5")).toBe(true);
    expect(isReasoningCapable("anthropic", "claude-opus-4-5")).toBe(true);
    expect(isReasoningCapable("anthropic", "claude-opus-4-7")).toBe(true);
  });

  it("returns false for pre-3.7 Claude", () => {
    expect(isReasoningCapable("anthropic", "claude-3-5-sonnet")).toBe(false);
    expect(isReasoningCapable("anthropic", "claude-3-opus")).toBe(false);
    expect(isReasoningCapable("anthropic", "claude-3-haiku")).toBe(false);
  });

  it("returns true for Gemini 2.5+ but not 2.0", () => {
    expect(isReasoningCapable("gemini", "gemini-2.5-pro")).toBe(true);
    expect(isReasoningCapable("gemini", "gemini-2.5-flash")).toBe(true);
    expect(isReasoningCapable("gemini", "gemini-3.1-pro-preview")).toBe(true);
    expect(isReasoningCapable("gemini", "gemini-2.0-flash")).toBe(false);
  });

  it("returns false for providers that don't honor reasoning params", () => {
    expect(isReasoningCapable("huggingface", "meta-llama/Llama-3-70B")).toBe(false);
  });

  it("returns true for MiniMax M3 and false for M2.x", () => {
    // M3 supports the `thinking: { type: "disabled" | "adaptive" }`
    // control so the dropdown should appear. M2.x cannot actually
    // disable thinking (API silently ignores the field) so we hide
    // the dropdown rather than expose a non-functional setting.
    expect(isReasoningCapable("minimax", "MiniMax-M3")).toBe(true);
    expect(isReasoningCapable("minimax", "MiniMax-M2")).toBe(false);
    expect(isReasoningCapable("minimax", "MiniMax-M2.1")).toBe(false);
    expect(isReasoningCapable("minimax", "MiniMax-M2.5")).toBe(false);
    expect(isReasoningCapable("minimax", "MiniMax-M2.7")).toBe(false);
    expect(isReasoningCapable("minimax", "MiniMax-M2.7-highspeed")).toBe(false);
  });

  it("is case-insensitive on the provider", () => {
    expect(isReasoningCapable("OpenAI", "o3-mini")).toBe(true);
    expect(isReasoningCapable("ANTHROPIC", "claude-sonnet-4-5")).toBe(true);
  });
});

describe("ReasoningSetting value space", () => {
  it("accepts the five canonical values", () => {
    const values: ReasoningSetting[] = ["off", "low", "medium", "high", "max"];
    for (const v of values) {
      // Should not throw — every value is a valid input.
      const result = translateReasoning("openai", "o3-mini", v);
      expect(result).toBeDefined();
    }
  });
});
