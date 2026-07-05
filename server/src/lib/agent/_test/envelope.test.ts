import { describe, it, expect } from "vitest";
import {
  safeParseToolCallEnvelope,
  MAX_TOOL_CALLS_PER_ENVELOPE,
  toolCallEnvelopeSchema
} from "../types.js";

function makeCall(index: number) {
  return { id: `call-${index}`, name: "read_file", parameters: { path: `f${index}.txt` } };
}

describe("safeParseToolCallEnvelope", () => {
  it("returns success for a small envelope", () => {
    const result = safeParseToolCallEnvelope({
      reasoning: "thinking",
      toolCalls: [makeCall(1), makeCall(2)]
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.toolCalls).toHaveLength(2);
      expect(result.truncated).toBeUndefined();
    }
  });

  it("returns success for an envelope with no tool calls", () => {
    const result = safeParseToolCallEnvelope({ reasoning: "ok" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.toolCalls).toEqual([]);
    }
  });

  it("truncates gracefully when there are too many tool calls", () => {
    const overCount = MAX_TOOL_CALLS_PER_ENVELOPE + 50;
    const tooMany = Array.from({ length: overCount }, (_, i) => makeCall(i));
    const result = safeParseToolCallEnvelope({ toolCalls: tooMany });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.toolCalls).toHaveLength(MAX_TOOL_CALLS_PER_ENVELOPE);
      expect(result.truncated).toBeDefined();
      expect(result.truncated?.from).toBe(overCount);
      expect(result.truncated?.to).toBe(MAX_TOOL_CALLS_PER_ENVELOPE);
      expect(result.truncated?.reason).toMatch(/truncated/i);
    }
  });

  it("does not truncate when at the cap exactly", () => {
    const exactly = Array.from({ length: MAX_TOOL_CALLS_PER_ENVELOPE }, (_, i) => makeCall(i));
    const result = safeParseToolCallEnvelope({ toolCalls: exactly });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.toolCalls).toHaveLength(MAX_TOOL_CALLS_PER_ENVELOPE);
      expect(result.truncated).toBeUndefined();
    }
  });

  it("returns failure for invalid tool name", () => {
    const result = safeParseToolCallEnvelope({
      toolCalls: [{ name: "bad name with spaces", parameters: {} }]
    });
    expect(result.success).toBe(false);
  });

  it("returns failure for missing required fields", () => {
    const result = safeParseToolCallEnvelope({ toolCalls: [{}] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toMatch(/name/);
    }
  });
});

describe("MAX_TOOL_CALLS_PER_ENVELOPE", () => {
  it("is greater than the previous 32 cap", () => {
    expect(MAX_TOOL_CALLS_PER_ENVELOPE).toBeGreaterThan(32);
  });
});

describe("toolCallEnvelopeSchema", () => {
  it("is exported and usable directly", () => {
    const result = toolCallEnvelopeSchema.safeParse({ toolCalls: [makeCall(1)] });
    expect(result.success).toBe(true);
  });
});
