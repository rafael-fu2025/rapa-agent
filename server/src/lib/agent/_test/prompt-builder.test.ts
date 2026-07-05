// Tests for buildProviderMessages — the function that turns the agent's
// internal AgentMessage[] history into the OpenAI chat-completions wire format.
//
// This is the function that was producing the "invalid params, tool results"
// 400 from providers (MiniMax, Gemini, etc.) on the second LLM call: the agent
// was flattening native tool_calls into JSON text and sending tool results as
// a single unlinked role:"tool" blob. The OpenAI spec requires one role:"tool"
// message PER call, each linked back by tool_call_id. These tests pin that
// contract so it can't silently regress.

import { describe, expect, it } from "vitest";
import { buildProviderMessages, sanitizeLlmMessages } from "../prompt-builder.js";
import type { AgentMessage, ProviderChatMessage } from "../types.js";
import type { ToolResult } from "../../tools.js";

function toolResult(output: string, success = true): ToolResult {
  return { success, output };
}

describe("buildProviderMessages — plain turns", () => {
  it("passes system/user/assistant messages through with truncation", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" }
    ];
    const out = buildProviderMessages(history, undefined, false);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(out[0].content).toBe("You are helpful.");
    expect(out[1].content).toBe("Hello");
  });

  it("appends the extra instruction as a trailing user message", () => {
    const history: AgentMessage[] = [{ role: "user", content: "Hi" }];
    const out = buildProviderMessages(history, "One more thing", false);
    const last = out[out.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("One more thing");
  });

  it("marks an empty assistant turn with no tool calls as a placeholder", () => {
    const history: AgentMessage[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "" }
    ];
    const out = buildProviderMessages(history, undefined, false);
    const assistant = out.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("[Empty assistant response]");
  });
});

describe("buildProviderMessages — native tool-call expansion", () => {
  it("emits an assistant tool_calls array (not JSON-in-content) for a tool-call turn", () => {
    const history: AgentMessage[] = [
      { role: "user", content: "Read the file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "read_file", parameters: { path: "foo.ts" } }]
      }
    ];
    const out = buildProviderMessages(history, undefined, false);
    const assistant = out.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls).toEqual([
      {
        id: "call-1",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: "foo.ts" }) }
      }
    ]);
    // Content must be null (not "" and not a JSON blob of the tool calls).
    // MiniMax/GLM reject empty-string content alongside tool_calls (error
    // 2013 "chat content is empty"); the OpenAI convention is null.
    expect(assistant?.content).toBeNull();
  });

  it("expands a tool-results blob into one role:tool message per call, linked by tool_call_id", () => {
    const history: AgentMessage[] = [
      { role: "user", content: "Read two files" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-a", name: "read_file", parameters: { path: "a.ts" } },
          { id: "call-b", name: "read_file", parameters: { path: "b.ts" } }
        ]
      },
      {
        role: "tool",
        content: "[]",
        toolResults: [toolResult("content of a"), toolResult("content of b")]
      }
    ];
    const out = buildProviderMessages(history, undefined, false);
    const toolMessages = out.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    // Each tool message is linked to its call id and carries the tool name.
    expect(toolMessages[0].tool_call_id).toBe("call-a");
    expect(toolMessages[0].name).toBe("read_file");
    expect(String(toolMessages[0].content)).toContain("content of a");
    expect(toolMessages[1].tool_call_id).toBe("call-b");
    expect(toolMessages[1].name).toBe("read_file");
    expect(String(toolMessages[1].content)).toContain("content of b");
  });

  it("preserves assistant prose alongside tool_calls when the model wrote both", () => {
    const history: AgentMessage[] = [
      {
        role: "assistant",
        content: "Let me check that for you.",
        toolCalls: [{ id: "c1", name: "list_directory", parameters: { path: "." } }]
      },
      {
        role: "tool",
        content: "[]",
        toolResults: [toolResult("file1\nfile2")]
      }
    ];
    const out = buildProviderMessages(history, undefined, false);
    const assistant = out.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("Let me check that for you.");
    expect(assistant?.tool_calls).toHaveLength(1);
  });

  it("demotes an orphan tool-results blob (no preceding tool-call turn) to a user message", () => {
    // This mirrors the auto-lint synthetic result path: the agent pushes a
    // role:"tool" blob without a matching assistant tool_calls turn. Emitting
    // a bare role:"tool" message would 400 on most providers; demoting to user
    // keeps the conversation schema-valid while preserving the information.
    const history: AgentMessage[] = [
      { role: "user", content: "Do something" },
      { role: "assistant", content: "Done." },
      { role: "tool", content: "[]", toolResults: [toolResult("lint: no errors")] }
    ];
    const out = buildProviderMessages(history, undefined, false);
    // No role:"tool" messages should be emitted.
    expect(out.some((m) => m.role === "tool")).toBe(false);
    // The orphan blob becomes a trailing user message carrying the result text.
    const last = out[out.length - 1];
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("lint: no errors");
  });

  it("does not falsely link an orphan blob to an earlier unrelated tool-call turn", () => {
    // Turn 1: a real tool-call exchange. Turn 2: plain assistant. Turn 3:
    // an orphan tool blob. The orphan must NOT steal turn 1's call IDs —
    // it should demote to user, and turn 1's tool messages stay intact.
    const history: AgentMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "real-1", name: "read_file", parameters: { path: "x" } }]
      },
      { role: "tool", content: "[]", toolResults: [toolResult("x-content")] },
      { role: "assistant", content: "Working on it." },
      { role: "tool", content: "[]", toolResults: [toolResult("orphan")] }
    ];
    const out = buildProviderMessages(history, undefined, false);
    const toolMessages = out.filter((m) => m.role === "tool");
    // Only turn 1's result becomes a tool message — linked to real-1.
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].tool_call_id).toBe("real-1");
    // The orphan is demoted to user text.
    const orphanUser = out
      .filter((m) => m.role === "user")
      .find((m) => String(m.content).includes("orphan"));
    expect(orphanUser).toBeDefined();
  });
});

describe("buildProviderMessages — budget grouping keeps tool exchanges atomic", () => {
  it("never splits an assistant tool_calls turn from its tool replies when trimming", () => {
    // Build a history large enough to force trimming: many turns, with a
    // tool-call exchange near the start. The exchange must survive intact or
    // be dropped entirely — emitting tool_calls without matching tool answers
    // is the malformed sequence that produces the provider 400.
    const history: AgentMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 20; i += 1) {
      history.push({ role: "user", content: `User message ${i} `.repeat(50) });
      history.push({
        role: "assistant",
        content: `Assistant reply ${i} `.repeat(50),
        toolCalls: [{ id: `call-${i}`, name: "read_file", parameters: { path: `f${i}` } }]
      });
      history.push({
        role: "tool",
        content: "[]",
        toolResults: [toolResult(`result ${i} `.repeat(50))]
      });
    }
    // Force a tight budget so trimming kicks in.
    const out = buildProviderMessages(history, undefined, false, { historyCharBudget: 2000 });

    // Walk the output and assert: every assistant with tool_calls is
    // immediately followed by the right number of role:tool messages.
    for (let i = 0; i < out.length; i += 1) {
      const msg = out[i];
      if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        const callIds = msg.tool_calls.map((tc) => tc.id);
        // The next callIds.length messages must be role:tool with matching ids.
        for (let j = 0; j < callIds.length; j += 1) {
          const reply = out[i + 1 + j];
          expect(reply?.role).toBe("tool");
          expect(reply?.tool_call_id).toBe(callIds[j]);
        }
      }
    }
    // Sanity: trimming should have actually dropped something.
    expect(out.length).toBeLessThan(history.length);
  });
});

// ---------------------------------------------------------------------------
// Tests for `sanitizeLlmMessages` — the post-processing repair step that
// keeps strict OpenAI-compatible providers (MiniMax, DeepSeek) from rejecting
// requests with HTTP 400 "tool call result does not follow tool call" (2013).
//
// These tests pin the contract independently of `buildProviderMessages` so a
// future change to the main builder can't silently regress the repair.
// ---------------------------------------------------------------------------
describe("sanitizeLlmMessages — orphan tool messages", () => {
  it("passes through a tool message that immediately follows its parent assistant turn", () => {
    const input: ProviderChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }
        ]
      },
      { role: "tool", content: "result", tool_call_id: "c1", name: "read_file" }
    ];
    const out = sanitizeLlmMessages(input);
    expect(out).toHaveLength(3);
    expect(out[2].role).toBe("tool");
    expect(out[2].tool_call_id).toBe("c1");
  });

  it("demotes a tool message that follows a user message (the MiniMax 2013 case)", () => {
    // This is the exact scenario that produced the user's 400 error:
    // after trimming or grace-synthesis, a role:"tool" message can end up
    // separated from its parent assistant turn by a user turn. MiniMax
    // rejects this with "tool call result does not follow tool call".
    const input: ProviderChatMessage[] = [
      { role: "user", content: "first" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }
        ]
      },
      { role: "tool", content: "result", tool_call_id: "c1", name: "read_file" },
      { role: "user", content: "follow-up question" },
      { role: "tool", content: "stale result", tool_call_id: "c1", name: "read_file" }
    ];
    const out = sanitizeLlmMessages(input);
    // The first tool message (immediately after its parent) is kept.
    expect(out[2].role).toBe("tool");
    // The second tool message (after the user follow-up) is demoted.
    expect(out[4].role).toBe("user");
    expect(String(out[4].content)).toContain("stale result");
    expect(String(out[4].content)).toContain("read_file");
    expect(String(out[4].content)).toContain("c1");
  });

  it("demotes a tool message whose tool_call_id doesn't match the preceding assistant", () => {
    // The assistant turn has an unanswered tool_call (the "ghost" tool
    // message references an id that was never issued). The assistant
    // turn is not the last message AND has no prose, so it gets
    // dropped entirely. The ghost tool message is then demoted to a
    // user message because no parent assistant turn is adjacent.
    const input: ProviderChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "real-1", type: "function", function: { name: "read_file", arguments: "{}" } }
        ]
      },
      // tool_call_id "ghost-9" was never issued by any assistant turn.
      { role: "tool", content: "ghost result", tool_call_id: "ghost-9", name: "read_file" }
    ];
    const out = sanitizeLlmMessages(input);
    // The ghost tool message is demoted to a user message and is the
    // only entry in the output (the tool-only assistant turn had no
    // prose and no valid answers, so it was dropped).
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    expect(String(out[0].content)).toContain("ghost result");
  });

  it("demotes a tool message that follows a system message", () => {
    const input: ProviderChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "tool", content: "orphan", tool_call_id: "c1", name: "read_file" }
    ];
    const out = sanitizeLlmMessages(input);
    expect(out[1].role).toBe("user");
    expect(String(out[1].content)).toContain("orphan");
  });
});

describe("sanitizeLlmMessages — unanswered tool_calls", () => {
  it("drops unanswered tool_calls when the assistant has prose", () => {
    const input: ProviderChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "Let me check that.",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }
        ]
      }
      // No tool answer follows.
    ];
    const out = sanitizeLlmMessages(input);
    const assistant = out.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("Let me check that.");
    expect(assistant?.tool_calls).toBeUndefined();
  });

  it("drops the entire tool-only assistant turn when no tool answers follow", () => {
    const input: ProviderChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }
        ]
      },
      { role: "user", content: "next question" }
    ];
    const out = sanitizeLlmMessages(input);
    // The tool-only assistant turn is dropped; only the two user messages remain.
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.role === "user")).toBe(true);
  });

  it("prunes partial answers — only unanswered tool_calls are dropped", () => {
    const input: ProviderChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "read_file", arguments: "{}" } }
        ]
      },
      // Only c1 is answered.
      { role: "tool", content: "result-1", tool_call_id: "c1", name: "read_file" }
    ];
    const out = sanitizeLlmMessages(input);
    const assistant = out.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls).toHaveLength(1);
    expect(assistant?.tool_calls?.[0].id).toBe("c1");
    const toolMessages = out.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].tool_call_id).toBe("c1");
  });
});

describe("sanitizeLlmMessages — happy path", () => {
  it("passes through a valid tool-call exchange unchanged", () => {
    const input: ProviderChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "read_file", arguments: "{}" } }
        ]
      },
      { role: "tool", content: "r1", tool_call_id: "c1", name: "read_file" },
      { role: "tool", content: "r2", tool_call_id: "c2", name: "read_file" },
      { role: "assistant", content: "Done." }
    ];
    const out = sanitizeLlmMessages(input);
    expect(out).toEqual(input);
  });

  it("is a no-op on plain text conversations", () => {
    const input: ProviderChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ];
    const out = sanitizeLlmMessages(input);
    expect(out).toEqual(input);
  });
});

describe("buildProviderMessages — sanitization integration", () => {
  it("applies sanitizeLlmMessages so a user message between assistant and tool result doesn't 400 on MiniMax", () => {
    // Simulate the post-trim state: an assistant turn with tool_calls,
    // a user follow-up, then a stale tool result. Without sanitization,
    // the tool result would be emitted with tool_call_id pointing to a
    // turn that's no longer adjacent — MiniMax returns 400 (2013).
    const history: AgentMessage[] = [
      { role: "user", content: "Read the file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", parameters: { path: "x.ts" } }]
      },
      { role: "user", content: "Actually, never mind." },
      { role: "tool", content: "[]", toolResults: [toolResult("file contents")] }
    ];
    const out = buildProviderMessages(history, undefined, false);
    // No role:"tool" messages — the orphan was demoted to user.
    expect(out.some((m) => m.role === "tool")).toBe(false);
    // The demoted message appears as a trailing user message with the
    // "[Tool result from `read_file` (call c1)]" prefix.
    const demoted = out
      .filter((m) => m.role === "user")
      .find((m) => String(m.content).includes("file contents"));
    expect(demoted).toBeDefined();
    expect(String(demoted!.content)).toContain("read_file");
    expect(String(demoted!.content)).toContain("c1");
  });
});
