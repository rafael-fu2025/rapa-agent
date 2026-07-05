import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  extractTokenUsage,
  getRealOrEstimatedTokenCount,
  normalizeChatMode,
  extractAgentSteps,
  extractAgentRunId,
  extractInteractivePayload,
  stringifyErrorDetails,
  formatErrorState,
  looksLikeChatModeRestriction,
  looksLikeWorkspaceRequest,
  mapConversationToMessages,
} from "../chat-utils";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns at least 1 for non-empty string", () => {
    expect(estimateTokens("hi")).toBeGreaterThanOrEqual(1);
  });

  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("hello world this is a test")).toBe(7); // 26/4 ≈ 6.5 → 7
  });
});

describe("extractTokenUsage", () => {
  it("returns undefined for null metadata", () => {
    expect(extractTokenUsage(null)).toBeUndefined();
  });

  it("returns undefined when tokenUsage is missing", () => {
    expect(extractTokenUsage({})).toBeUndefined();
  });

  it("extracts valid token usage object", () => {
    const metadata = { tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } };
    expect(extractTokenUsage(metadata)).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30 });
  });

  it("computes totalTokens from prompt + completion when missing", () => {
    const metadata = { tokenUsage: { promptTokens: 10, completionTokens: 20 } };
    const result = extractTokenUsage(metadata);
    expect(result?.totalTokens).toBe(30);
  });

  it("returns undefined for array metadata", () => {
    expect(extractTokenUsage([])).toBeUndefined();
  });
});

describe("getRealOrEstimatedTokenCount", () => {
  it("uses totalTokens when available", () => {
    expect(getRealOrEstimatedTokenCount("content", { totalTokens: 42 })).toBe(42);
  });

  it("falls back to completionTokens", () => {
    expect(getRealOrEstimatedTokenCount("content", { completionTokens: 15 })).toBe(15);
  });

  it("falls back to estimate when no usage data", () => {
    expect(getRealOrEstimatedTokenCount("hello")).toBe(estimateTokens("hello"));
  });
});

describe("normalizeChatMode", () => {
  it("returns valid modes as-is", () => {
    expect(normalizeChatMode("chat")).toBe("chat");
    expect(normalizeChatMode("agent")).toBe("agent");
    expect(normalizeChatMode("plan")).toBe("plan");
  });

  it("returns undefined for invalid modes", () => {
    expect(normalizeChatMode("unknown")).toBeUndefined();
    expect(normalizeChatMode(undefined)).toBeUndefined();
  });
});

describe("extractAgentSteps", () => {
  it("returns empty array for null metadata", () => {
    expect(extractAgentSteps(null)).toEqual([]);
  });

  it("returns steps array when present", () => {
    const steps = [{ iteration: 1, tool: "read_file" }];
    expect(extractAgentSteps({ steps })).toEqual(steps);
  });

  it("returns empty array when steps is not an array", () => {
    expect(extractAgentSteps({ steps: "not-array" })).toEqual([]);
  });
});

describe("extractAgentRunId", () => {
  it("returns undefined for null metadata", () => {
    expect(extractAgentRunId(null)).toBeUndefined();
  });

  it("extracts valid run ID", () => {
    expect(extractAgentRunId({ agentRunId: "run-123" })).toBe("run-123");
  });

  it("returns undefined for empty string", () => {
    expect(extractAgentRunId({ agentRunId: "  " })).toBeUndefined();
  });
});

describe("extractInteractivePayload", () => {
  it("returns undefined for null metadata", () => {
    expect(extractInteractivePayload(null)).toBeUndefined();
  });

  it("extracts ask_user payload with valid questions", () => {
    const metadata = {
      interactive: {
        type: "ask_user",
        questions: [
          {
            question: "Which option?",
            header: "Choice",
            options: [{ label: "A" }, { label: "B" }],
            multiSelect: false,
          },
        ],
      },
    };
    const result = extractInteractivePayload(metadata);
    expect(result?.type).toBe("ask_user");
    if (result?.type === "ask_user") {
      expect(result.questions).toHaveLength(1);
      expect(result.questions[0].question).toBe("Which option?");
    }
  });

  it("extracts mode_switch payload", () => {
    const metadata = {
      interactive: {
        type: "mode_switch",
        suggestedMode: "agent",
        prompt: "Switch to agent mode for this task",
      },
    };
    const result = extractInteractivePayload(metadata);
    expect(result?.type).toBe("mode_switch");
    if (result?.type === "mode_switch") {
      expect(result.suggestedMode).toBe("agent");
      expect(result.prompt).toBe("Switch to agent mode for this task");
    }
  });

  it("rejects mode_switch with empty prompt", () => {
    const metadata = {
      interactive: {
        type: "mode_switch",
        suggestedMode: "agent",
        prompt: "",
      },
    };
    expect(extractInteractivePayload(metadata)).toBeUndefined();
  });

  it("rejects ask_user with fewer than 2 options", () => {
    const metadata = {
      interactive: {
        type: "ask_user",
        questions: [
          {
            question: "Only one?",
            header: "Q1",
            options: [{ label: "Only" }],
            multiSelect: false,
          },
        ],
      },
    };
    expect(extractInteractivePayload(metadata)).toBeUndefined();
  });
});

describe("stringifyErrorDetails", () => {
  it("returns empty string for null/undefined", () => {
    expect(stringifyErrorDetails(null)).toBe("");
    expect(stringifyErrorDetails(undefined)).toBe("");
  });

  it("parses JSON strings", () => {
    expect(stringifyErrorDetails('{"key":"value"}')).toContain("key");
  });

  it("handles plain strings with escaped newlines", () => {
    expect(stringifyErrorDetails("line1\\nline2")).toBe("line1\nline2");
  });
});

describe("formatErrorState", () => {
  it("returns summary for empty string", () => {
    expect(formatErrorState("")).toEqual({ summary: "Something went wrong." });
  });

  it("extracts message from JSON error", () => {
    const result = formatErrorState(JSON.stringify({ message: "Not found", details: "id=xyz" }));
    expect(result.summary).toBe("Not found");
    expect(result.details).toContain("id=xyz");
  });

  it("returns raw string as summary for non-JSON", () => {
    expect(formatErrorState("Something broke")).toEqual({ summary: "Something broke" });
  });
});

describe("looksLikeChatModeRestriction", () => {
  it("detects chat mode restriction phrases", () => {
    expect(looksLikeChatModeRestriction("This feature is only available in agent mode")).toBe(true);
    expect(looksLikeChatModeRestriction("Please switch to agent mode")).toBe(true);
    expect(looksLikeChatModeRestriction("I am still operating in chat mode")).toBe(true);
  });

  it("returns false for unrelated content", () => {
    expect(looksLikeChatModeRestriction("Here is your answer")).toBe(false);
  });
});

describe("looksLikeWorkspaceRequest", () => {
  it("detects workspace-related requests", () => {
    expect(looksLikeWorkspaceRequest("Analyze the codebase structure")).toBe(true);
    expect(looksLikeWorkspaceRequest("Read the package.json file")).toBe(true);
    expect(looksLikeWorkspaceRequest("Fix the bug in the component")).toBe(true);
  });

  it("detects generic workspace mentions", () => {
    expect(looksLikeWorkspaceRequest("Look at my repository")).toBe(true);
  });

  it("returns false for unrelated prompts", () => {
    expect(looksLikeWorkspaceRequest("What is the capital of France?")).toBe(false);
  });
});

describe("mapConversationToMessages", () => {
  it("maps empty array to empty array", () => {
    expect(mapConversationToMessages([])).toEqual([]);
  });

  it("maps user messages correctly", () => {
    const rows = [
      {
        id: "msg-1",
        conversationId: "conv-1",
        role: "user" as const,
        content: "Hello",
        model: "gemini-3.1-flash",
        provider: "gemini",
        mode: "chat" as const,
        metadata: {},
      },
    ];
    const result = mapConversationToMessages(rows);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("Hello");
    expect(result[0].mode).toBe("chat");
  });

  it("maps assistant messages with token usage", () => {
    const rows = [
      {
        id: "msg-2",
        conversationId: "conv-1",
        role: "assistant" as const,
        content: "Hi there!",
        model: "gemini-3.1-flash",
        provider: "gemini",
        mode: "chat" as const,
        metadata: { tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      },
    ];
    const result = mapConversationToMessages(rows);
    expect(result[0].stats?.totalTokens).toBe(15);
  });
});
