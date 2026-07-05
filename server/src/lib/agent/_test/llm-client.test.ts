// Tests for the provider-specific request body extras produced by
// `buildProviderRequestExtras` in llm-client.ts. The MiniMax branch is the
// only one that emits extras today, so most of these tests focus on the
// shape the agent sends to https://api.minimax.io/v1/chat/completions for
// each model family.
//
// IMPORTANT: the MiniMax-specific extras (thinking, reasoning_split,
// top_p, max_completion_tokens, temperature) are OPT-IN via the
// `MINIMAX_ENABLE_EXTRAS` env var. By default the helper returns `{}` so
// the agent sends a bare OpenAI-compatible request — the same shape that
// works for every other provider and that we know doesn't trigger the
// "invalid params, tool cal..." 400 on MiniMax deployments that reject
// those fields.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProviderRequestExtras } from "../llm-client.js";

describe("buildProviderRequestExtras — default (extras disabled)", () => {
  it("returns an empty object for non-MiniMax providers", () => {
    expect(buildProviderRequestExtras("gemini", "gemini-2.5-pro")).toEqual({});
    expect(buildProviderRequestExtras("openai", "gpt-5")).toEqual({});
    expect(buildProviderRequestExtras("groq", "llama-3.3-70b-versatile")).toEqual({});
  });

  it("returns an empty object for MiniMax when MINIMAX_ENABLE_EXTRAS is unset", () => {
    // The agent sends a bare OpenAI-compatible request. This is the safe
    // path when the deployment rejects documented-but-flaky fields like
    // `reasoning_split` or `thinking` with HTTP 400 "invalid params".
    expect(buildProviderRequestExtras("minimax", "MiniMax-M3")).toEqual({});
    expect(buildProviderRequestExtras("minimax", "MiniMax-M2.7")).toEqual({});
    expect(buildProviderRequestExtras("minimax", "MiniMax-M2.5-highspeed")).toEqual({});
    expect(buildProviderRequestExtras("minimax", "MiniMax-M2")).toEqual({});
  });
});

describe("buildProviderRequestExtras — with MINIMAX_ENABLE_EXTRAS=true", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.MINIMAX_ENABLE_EXTRAS;
    process.env.MINIMAX_ENABLE_EXTRAS = "true";
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MINIMAX_ENABLE_EXTRAS;
    } else {
      process.env.MINIMAX_ENABLE_EXTRAS = originalEnv;
    }
  });

  it("emits adaptive thinking and reasoning_split for MiniMax-M3", () => {
    const extras = buildProviderRequestExtras("minimax", "MiniMax-M3");
    expect(extras.thinking).toEqual({ type: "adaptive" });
    expect(extras.reasoning_split).toBe(true);
  });

  it("uses the documented top_p for each MiniMax family", () => {
    expect(buildProviderRequestExtras("minimax", "MiniMax-M3").top_p).toBe(0.95);
    expect(buildProviderRequestExtras("minimax", "MiniMax-M2.7").top_p).toBe(0.9);
    expect(buildProviderRequestExtras("minimax", "MiniMax-M2.5-highspeed").top_p).toBe(0.9);
  });

  it("uses the recommended max_completion_tokens for each MiniMax family", () => {
    // M3: recommended 131072, max 524288
    expect(buildProviderRequestExtras("minimax", "MiniMax-M3").max_completion_tokens).toBe(131072);
    // M2.x: recommended 65536, max 204800
    expect(buildProviderRequestExtras("minimax", "MiniMax-M2.7").max_completion_tokens).toBe(65536);
    expect(buildProviderRequestExtras("minimax", "MiniMax-M2").max_completion_tokens).toBe(65536);
  });

  it("always sets temperature: 1 for MiniMax (documented default)", () => {
    expect(buildProviderRequestExtras("minimax", "MiniMax-M3").temperature).toBe(1);
    expect(buildProviderRequestExtras("minimax", "MiniMax-M2.7").temperature).toBe(1);
    expect(buildProviderRequestExtras("minimax", "MiniMax-M2").temperature).toBe(1);
  });

  it("does not emit thinking / reasoning_split for M2.x models", () => {
    // Per the docs, M2.x cannot disable thinking and reasoning_split only
    // applies to M3. We must not add those fields to M2.x requests or the
    // provider may reject them.
    const extras = buildProviderRequestExtras("minimax", "MiniMax-M2.7-highspeed");
    expect(extras.thinking).toBeUndefined();
    expect(extras.reasoning_split).toBeUndefined();
  });

  it("honors an explicit maxCompletionTokens override", () => {
    // User can bump the ceiling for long agentic runs that emit many
    // tool calls. The override should always win over the family default.
    const extras = buildProviderRequestExtras("minimax", "MiniMax-M3", 524288);
    expect(extras.max_completion_tokens).toBe(524288);
  });

  it("falls back to a default max_completion_tokens for unknown MiniMax models", () => {
    // If a new MiniMax model is added that we don't recognize, omit
    // `max_completion_tokens` rather than guessing — a wrong value is
    // worse than the provider-side default, which is conservative.
    const extras = buildProviderRequestExtras("minimax", "MiniMax-Mystery");
    expect(extras.max_completion_tokens).toBeUndefined();
  });
});

describe("buildProviderRequestExtras — opt-in env var values", () => {
  let originalEnv: string | undefined;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MINIMAX_ENABLE_EXTRAS;
    } else {
      process.env.MINIMAX_ENABLE_EXTRAS = originalEnv;
    }
  });

  it("accepts '1' as truthy", () => {
    originalEnv = process.env.MINIMAX_ENABLE_EXTRAS;
    process.env.MINIMAX_ENABLE_EXTRAS = "1";
    expect(buildProviderRequestExtras("minimax", "MiniMax-M3").reasoning_split).toBe(true);
  });

  it("treats 'false' as falsy", () => {
    originalEnv = process.env.MINIMAX_ENABLE_EXTRAS;
    process.env.MINIMAX_ENABLE_EXTRAS = "false";
    expect(buildProviderRequestExtras("minimax", "MiniMax-M3")).toEqual({});
  });

  it("treats 'yes' as falsy (only 'true' and '1' opt in)", () => {
    // We deliberately accept a strict set of truthy values to avoid
    // accidentally enabling extras via a typo in the env var.
    originalEnv = process.env.MINIMAX_ENABLE_EXTRAS;
    process.env.MINIMAX_ENABLE_EXTRAS = "yes";
    expect(buildProviderRequestExtras("minimax", "MiniMax-M3")).toEqual({});
  });
});
