// Tests for the provider `/models` response normaliser.

import { describe, expect, it } from "vitest";
import {
  diffModelLists,
  parseModelsResponse
} from "../provider-models.js";

describe("parseModelsResponse", () => {
  it("parses OpenAI-compatible shape ({ data: [{ id }] })", () => {
    const raw = {
      object: "list",
      data: [
        { id: "gpt-4o", object: "model", owned_by: "openai" },
        { id: "gpt-4o-mini", object: "model", owned_by: "openai" },
        { id: "o1-preview", object: "model", owned_by: "openai" }
      ]
    };
    const result = parseModelsResponse(raw);
    expect(result.source).toBe("openai");
    expect(result.models).toEqual(["gpt-4o", "gpt-4o-mini", "o1-preview"]);
  });

  it("parses MiniMax / NVIDIA / Groq-style responses identically", () => {
    const raw = {
      data: [
        { id: "MiniMax-M3" },
        { id: "MiniMax-M2.7-highspeed" },
        { id: "MiniMax-M2" }
      ]
    };
    const result = parseModelsResponse(raw);
    expect(result.source).toBe("openai");
    expect(result.models).toEqual([
      "MiniMax-M2",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M3"
    ]);
  });

  it("parses OpenRouter model cards (full shape with id + name + pricing + context_length)", () => {
    // A trimmed sample of the real OpenRouter /api/v1/models response.
    // Verifies that the rich metadata fields don't trip up the parser —
    // we only extract the `id`.
    const raw = {
      data: [
        {
          id: "minimax/minimax-m3",
          canonical_slug: "minimax/minimax-m3-20260531",
          name: "MiniMax: MiniMax M3",
          created: 1780245374,
          description: "MiniMax-M3 is a multimodal foundation model",
          context_length: 1048576,
          architecture: { modality: "text+image+video->text", tokenizer: "Other" },
          pricing: { prompt: "0.0000003", completion: "0.0000012" },
          top_provider: { context_length: 524288, is_moderated: false },
          supported_parameters: ["temperature", "tools", "reasoning"]
        },
        {
          id: "anthropic/claude-sonnet-5",
          canonical_slug: "anthropic/claude-sonnet-5-20260630",
          name: "Anthropic: Claude Sonnet 5",
          context_length: 1000000,
          pricing: { prompt: "0.000002", completion: "0.00001" }
        },
        {
          id: "openai/gpt-5.5",
          canonical_slug: "openai/gpt-5.5-20260423",
          name: "OpenAI: GPT-5.5",
          context_length: 1050000,
          pricing: { prompt: "0.000005", completion: "0.00003" }
        }
      ]
    };
    const result = parseModelsResponse(raw);
    expect(result.source).toBe("openai");
    expect(result.models).toEqual([
      "anthropic/claude-sonnet-5",
      "minimax/minimax-m3",
      "openai/gpt-5.5"
    ]);
  });

  it("parses Gemini shape ({ models: [{ name }] }) and strips models/ prefix", () => {
    const raw = {
      models: [
        { name: "models/gemini-3-pro-preview", displayName: "Gemini 3 Pro" },
        { name: "models/gemini-2.5-flash" },
        { name: "models/gemma-4-31b-it" }
      ]
    };
    const result = parseModelsResponse(raw);
    expect(result.source).toBe("gemini");
    expect(result.models).toEqual([
      "gemini-2.5-flash",
      "gemini-3-pro-preview",
      "gemma-4-31b-it"
    ]);
  });

  it("parses a bare array of strings", () => {
    const result = parseModelsResponse(["a", "b", "a"]);
    expect(result.source).toBe("bare-array");
    expect(result.models).toEqual(["a", "b"]);
  });

  it("parses Puter's catalog shape ({ models: [{ id, name, provider, ... }] })", () => {
    // Puter exposes its multi-vendor catalog at
    // https://api.puter.com/puterai/chat/models/details — its standard
    // OpenAI-compatible /v1/models endpoint returns 404. The response is a
    // rich object with `puterId`, `id`, `name`, `provider`, `context`,
    // `max_tokens`, `tool_call`, `costs`, `aliases`, etc. per model. We only
    // extract the bare `id` so it can be passed back to puter.ai.chat().
    const raw = {
      models: [
        {
          puterId: "alibaba:qwen/qvq-max",
          id: "qvq-max",
          name: "QVQ Max",
          modalities: { input: ["text", "image"], output: ["text"] },
          open_weights: false,
          tool_call: true,
          knowledge: "2024-04",
          release_date: "2025-03-25",
          aliases: ["qwen/vq-max", "alibaba:qwen/qvq-max"],
          context: 131072,
          max_tokens: 8192,
          costs: { tokens: 1000000, prompt_tokens: 120, completion_tokens: 480 },
          provider: "alibaba"
        },
        {
          puterId: "azure:openai/gpt-5",
          id: "gpt-5",
          name: "GPT-5",
          modalities: { input: ["text", "image"], output: ["text"] },
          tool_call: true,
          context: 128000,
          max_tokens: 128000,
          provider: "azure-openai"
        },
        {
          puterId: "anthropic:anthropic/claude-sonnet-5",
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          modalities: { input: ["text", "image", "pdf"], output: ["text"] },
          tool_call: true,
          context: 1000000,
          max_tokens: 64000,
          provider: "claude"
        }
      ]
    };
    const result = parseModelsResponse(raw);
    // Source is `gemini` because the shape is `{models: [...]}`, but the
    // extracted ids are the Puter-friendly model IDs (`gpt-5`, not the
    // OpenRouter-style `openai/gpt-5`).
    expect(result.source).toBe("gemini");
    expect(result.models).toEqual([
      "claude-sonnet-5",
      "gpt-5",
      "qvq-max"
    ]);
  });

  it("parses a bare array of objects", () => {
    const result = parseModelsResponse([
      { id: "x" },
      { id: "y" },
      { slug: "z" }
    ]);
    expect(result.source).toBe("bare-array");
    expect(result.models).toEqual(["x", "y", "z"]);
  });

  it("returns an empty list for unknown / unsupported shapes", () => {
    expect(parseModelsResponse(null).models).toEqual([]);
    expect(parseModelsResponse(undefined).models).toEqual([]);
    expect(parseModelsResponse("just a string").models).toEqual([]);
    expect(parseModelsResponse({ unexpected: [{ foo: "bar" }] }).models).toEqual([]);
  });

  it("skips entries without a recognisable id field", () => {
    const raw = {
      data: [
        { id: "keep-me" },
        { object: "model", owned_by: "openai" }, // no id
        { name: "models/skip-me" }, // no id, but name
        null,
        "raw-string",
        { id: "" } // empty string
      ]
    };
    const result = parseModelsResponse(raw);
    expect(result.source).toBe("openai");
    expect(result.models).toEqual(["keep-me", "skip-me"]);
  });

  it("deduplicates and sorts results", () => {
    const raw = { data: [{ id: "zeta" }, { id: "alpha" }, { id: "zeta" }] };
    expect(parseModelsResponse(raw).models).toEqual(["alpha", "zeta"]);
  });
});

describe("diffModelLists", () => {
  it("returns added and removed entries", () => {
    const diff = diffModelLists(["a", "b", "c"], ["b", "c", "d"]);
    expect(diff.added).toEqual(["d"]);
    expect(diff.removed).toEqual(["a"]);
  });

  it("returns empty arrays when lists match", () => {
    const diff = diffModelLists(["a", "b"], ["a", "b"]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("handles both empty lists", () => {
    expect(diffModelLists([], [])).toEqual({ added: [], removed: [] });
  });

  it("returns sorted diffs even if input is unsorted", () => {
    const diff = diffModelLists(["zeta", "alpha"], ["mike", "alpha"]);
    expect(diff.added).toEqual(["mike"]);
    expect(diff.removed).toEqual(["zeta"]);
  });
});