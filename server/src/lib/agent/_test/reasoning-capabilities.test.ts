// Tests for the per-model reasoning capability table — the single source
// of truth for which effort levels a (provider, model) pair supports.

import { describe, expect, it } from "vitest";
import {
  getReasoningProfile,
  snapEffortToProfile,
  levelsFromUpstreamValues,
  isReasoningCapable
} from "../reasoning-capabilities.js";

describe("getReasoningProfile — model pattern table", () => {
  it("GPT-5.1+ gets the xhigh tier; plain GPT-5 and o-series do not", () => {
    expect(getReasoningProfile("openai", "gpt-5.1").levels).toEqual(["off", "low", "medium", "high", "xhigh"]);
    expect(getReasoningProfile("openai", "gpt-5").levels).toEqual(["off", "low", "medium", "high"]);
    expect(getReasoningProfile("openai", "o4-mini").levels).toEqual(["off", "low", "medium", "high"]);
  });

  it("adaptive Claude (Opus 4.7+/5.x) is standard; legacy budget Claude extends to max", () => {
    expect(getReasoningProfile("anthropic", "claude-opus-5").levels).toEqual(["off", "low", "medium", "high"]);
    expect(getReasoningProfile("anthropic", "claude-opus-4-7").levels).toEqual(["off", "low", "medium", "high"]);
    expect(getReasoningProfile("anthropic", "claude-sonnet-4-5").levels).toEqual(["off", "low", "medium", "high", "max"]);
    expect(getReasoningProfile("anthropic", "claude-3-7-sonnet").levels).toEqual(["off", "low", "medium", "high", "max"]);
  });

  it("Gemini flash models cap below max; pro / 3.x extend to max", () => {
    expect(getReasoningProfile("gemini", "gemini-2.5-flash").levels).toEqual(["off", "low", "medium", "high"]);
    expect(getReasoningProfile("gemini", "gemini-3-flash-preview").levels).toEqual(["off", "low", "medium", "high"]);
    expect(getReasoningProfile("gemini", "gemini-2.5-pro").levels).toEqual(["off", "low", "medium", "high", "max"]);
    expect(getReasoningProfile("gemini", "gemini-3-pro-preview").levels).toEqual(["off", "low", "medium", "high", "max"]);
  });

  it("MiniMax M3 is binary; M2.x has no control at all", () => {
    const m3 = getReasoningProfile("minimax", "MiniMax-M3");
    expect(m3.style).toBe("binary");
    expect(m3.levels).toEqual(["off", "on"]);

    const m2 = getReasoningProfile("minimax", "MiniMax-M2.7");
    expect(m2.style).toBe("none");
    expect(m2.levels).toEqual([]);
  });

  it("ollama is provider-wide binary", () => {
    const profile = getReasoningProfile("ollama", "deepseek-r1");
    expect(profile.style).toBe("binary");
    expect(profile.levels).toEqual(["off", "on"]);
  });

  it("extended-tier vendors get ultra", () => {
    expect(getReasoningProfile("openrouter", "qwen/qwen3-max").levels).toContain("ultra");
    expect(getReasoningProfile("custom", "glm-5-air").levels).toContain("ultra");
  });
});

describe("getReasoningProfile — fallbacks and denylist", () => {
  it("unknown model on a capable provider falls back to standard", () => {
    const profile = getReasoningProfile("gemini", "some-future-gemini");
    expect(profile.style).toBe("standard");
    expect(profile.source).toBe("provider-default");
    expect(profile.levels).toEqual(["off", "low", "medium", "high"]);
  });

  it("non-reasoning models and unknown providers get none", () => {
    expect(getReasoningProfile("openai", "gpt-4o").style).toBe("none");
    expect(getReasoningProfile("gemini", "gemini-2.0-flash").style).toBe("none");
    expect(getReasoningProfile("huggingface", "some-model").style).toBe("none");
  });

  it("isReasoningCapable still answers the boolean question", () => {
    expect(isReasoningCapable("openai", "gpt-5.1")).toBe(true);
    expect(isReasoningCapable("openai", "gpt-4o")).toBe(false);
    expect(isReasoningCapable("minimax", "MiniMax-M3")).toBe(true);
    expect(isReasoningCapable("minimax", "MiniMax-M2")).toBe(false);
  });
});

describe("snapEffortToProfile", () => {
  const standard = getReasoningProfile("gemini", "gemini-2.5-flash");
  const extended = getReasoningProfile("anthropic", "claude-sonnet-4-5");

  it("snaps down the ladder one rung at a time", () => {
    // The legacy-Claude extended profile tops out at max.
    expect(snapEffortToProfile("ultra", extended)).toBe("max");
    expect(snapEffortToProfile("ultra", standard)).toBe("high");
    expect(snapEffortToProfile("xhigh", standard)).toBe("high");
    expect(snapEffortToProfile("max", standard)).toBe("high");
    expect(snapEffortToProfile("medium", standard)).toBe("medium");
  });

  it("binary 'on' snaps from the high rung", () => {
    expect(snapEffortToProfile("on", standard)).toBe("high");
    expect(snapEffortToProfile("on", getReasoningProfile("minimax", "MiniMax-M3"))).toBe("on");
  });

  it("falls back to off for the none profile", () => {
    const none = getReasoningProfile("openai", "gpt-4o");
    expect(snapEffortToProfile("ultra", none)).toBe("off");
    expect(snapEffortToProfile("high", none)).toBe("off");
  });

  it("already-supported levels pass through unchanged", () => {
    expect(snapEffortToProfile("low", standard)).toBe("low");
    expect(snapEffortToProfile("off", standard)).toBe("off");
  });
});

describe("levelsFromUpstreamValues", () => {
  it("normalizes and orders recognized upstream level strings", () => {
    expect(levelsFromUpstreamValues(["high", "low", "medium"])).toEqual(["low", "medium", "high"]);
  });

  it("includes off only when the upstream advertises it", () => {
    expect(levelsFromUpstreamValues(["off", "low", "high"])).toEqual(["off", "low", "high"]);
    expect(levelsFromUpstreamValues(["low", "high"])).toEqual(["low", "high"]);
  });

  it("drops unrecognized values and returns null when nothing usable remains", () => {
    expect(levelsFromUpstreamValues(["none", "turbo"])).toBeNull();
    expect(levelsFromUpstreamValues([])).toBeNull();
    expect(levelsFromUpstreamValues(["medium", "banana"])).toEqual(["medium"]);
  });

  it("accepts the extended tiers", () => {
    expect(levelsFromUpstreamValues(["low", "medium", "high", "xhigh"])).toEqual(["low", "medium", "high", "xhigh"]);
    expect(levelsFromUpstreamValues(["max", "ultra", "high"])).toEqual(["high", "max", "ultra"]);
  });
});
