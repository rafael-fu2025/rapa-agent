// Tests for the LLM response parser.

import { describe, expect, it } from "vitest";
import {
  combineReasoning,
  createStreamThinkStripper,
  extractThinking,
  hasExplicitDoneSignal,
  looksLikeContinuationResponse,
  looksLikeToolUseIntent,
  parseAssistantResponse,
  pushStreamThinkDelta,
  stripResidualToolMarkup,
  stripThinking
} from "../response-parser.js";

describe("extractThinking", () => {
  it("extracts content from <thinking> tags", () => {
    const result = extractThinking("before <thinking>reasoning here</thinking> after");
    expect(result).toBe("reasoning here");
  });

  it("extracts content from <think> tags", () => {
    const result = extractThinking("before <think>more reasoning</think> after");
    expect(result).toBe("more reasoning");
  });

  it("joins multiple thinking blocks with double newlines", () => {
    const result = extractThinking("<thinking>first</thinking> and <think>second</think>");
    expect(result).toBe("first\n\nsecond");
  });

  it("returns undefined when there are no thinking tags", () => {
    expect(extractThinking("just a regular response")).toBeUndefined();
  });

  it("returns undefined when thinking tags are empty", () => {
    expect(extractThinking("<thinking></thinking>")).toBeUndefined();
  });
});

describe("stripThinking", () => {
  it("removes thinking blocks from the content", () => {
    expect(stripThinking("hello <thinking>foo</thinking> world")).toBe("hello  world");
  });

  it("returns the content unchanged when no thinking tags", () => {
    expect(stripThinking("plain text only")).toBe("plain text only");
  });
});

describe("pushStreamThinkDelta", () => {
  it("passes through content that has no think tags", () => {
    const state = createStreamThinkStripper();
    const result = pushStreamThinkDelta(state, "regular content");
    expect(result.displayDelta).toBe("regular content");
    expect(result.changed).toBe(true);
  });

  it("suppresses content inside a <thinking> block", () => {
    const state = createStreamThinkStripper();
    expect(pushStreamThinkDelta(state, "before <thinking>").displayDelta).toBe("before ");
    expect(pushStreamThinkDelta(state, "hidden reasoning").displayDelta).toBe("");
    // The closing tag must be in the same delta to exit the block.
    expect(pushStreamThinkDelta(state, "</thinking> after").displayDelta).toBe(" after");
  });

  it("handles a single delta that opens and closes think", () => {
    const state = createStreamThinkStripper();
    const result = pushStreamThinkDelta(state, "before <think>x</think> after");
    expect(result.displayDelta).toBe("before  after");
  });

  it("returns changed=false for empty delta", () => {
    const state = createStreamThinkStripper();
    expect(pushStreamThinkDelta(state, "")).toEqual({ displayDelta: "", thinkingDelta: "", changed: false });
  });
});

describe("combineReasoning", () => {
  it("joins non-empty string parts with double newlines", () => {
    expect(combineReasoning("a", "b", "c")).toBe("a\n\nb\n\nc");
  });

  it("drops empty strings", () => {
    expect(combineReasoning("a", "", "   ", "b")).toBe("a\n\nb");
  });

  it("drops non-string inputs", () => {
    expect(combineReasoning("a", undefined, null, 42, "b")).toBe("a\n\nb");
  });

  it("deduplicates strings where one is a prefix of the other (first-wins)", () => {
    // Implementation order: the first part is kept; subsequent parts that
    // are subsumed by an existing one are dropped.
    expect(combineReasoning("hello world", "hello")).toBe("hello world");
    expect(combineReasoning("hello", "hello world")).toBe("hello");
  });

  it("returns undefined when no parts are usable", () => {
    expect(combineReasoning(undefined, "", "   ", null)).toBeUndefined();
  });
});

describe("looksLikeToolUseIntent", () => {
  it("detects 'let me read' style intent", () => {
    expect(looksLikeToolUseIntent("Let me read the package.json file.")).toBe(true);
  });

  it("detects 'we should explore' intent", () => {
    expect(looksLikeToolUseIntent("We should explore the directory structure first.")).toBe(true);
  });

  it("returns false for plain prose without action verbs", () => {
    expect(looksLikeToolUseIntent("Here is the answer to your question.")).toBe(false);
  });
});

describe("looksLikeContinuationResponse", () => {
  it("treats 'Let me read X.' as a continuation", () => {
    expect(looksLikeContinuationResponse("Let me read the file.")).toBe(true);
  });

  it("treats a longer forward-looking message as a continuation", () => {
    const text = "Looking at the workspace, I see the source. Let me read the package.json to understand the structure.";
    expect(looksLikeContinuationResponse(text)).toBe(true);
  });

  it("treats a complete summary as a final response", () => {
    expect(looksLikeContinuationResponse("The package.json declares React and Vite. Done.")).toBe(false);
  });
});

describe("stripResidualToolMarkup", () => {
  it("removes tool_call XML blocks", () => {
    const text = "before <tool_call>foo</tool_call> after";
    expect(stripResidualToolMarkup(text)).not.toContain("foo");
  });

  it("leaves clean text alone", () => {
    expect(stripResidualToolMarkup("clean prose")).toBe("clean prose");
  });
});

describe("parseAssistantResponse", () => {
  it("returns a simple text response with no tool calls", () => {
    const result = parseAssistantResponse("Hello! How can I help?");
    expect(result.responseText).toBe("Hello! How can I help?");
    expect(result.toolCalls).toEqual([]);
    expect(result.parseError).toBeUndefined();
  });

  it("parses JSON tool calls envelope", () => {
    const content = JSON.stringify({
      reasoning: "I need to read the file",
      toolCalls: [{ name: "read_file", parameters: { path: "foo.txt" } }]
    });
    const result = parseAssistantResponse(content);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("read_file");
    expect(result.toolCalls[0].parameters).toEqual({ path: "foo.txt" });
    expect(result.toolCalls[0].id).toBeDefined();
  });

  it("parses XML-style tool calls", () => {
    const content = `I'll read the file. <toolCall>
      <name>read_file</name>
      <parameters><path>foo.txt</path></parameters>
    </toolCall>`;
    const result = parseAssistantResponse(content);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("read_file");
  });

  it("parses inline `call:tool{}` syntax", () => {
    const content = 'call:read_file{path: "foo.txt"}';
    const result = parseAssistantResponse(content);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("read_file");
    expect(result.toolCalls[0].parameters).toMatchObject({ path: "foo.txt" });
  });

  it("uses native tool calls when provided and ignores parsed ones", () => {
    const content = JSON.stringify({
      toolCalls: [{ name: "should_be_ignored", parameters: {} }]
    });
    const native = [
      { id: "native-1", name: "real_tool", parameters: { arg: "value" } }
    ];
    const result = parseAssistantResponse(content, undefined, native);
    expect(result.toolCalls).toEqual(native);
  });

  it("extracts reasoning from <thinking> tags and combines with provider reasoning", () => {
    const content = "<thinking>my reasoning</thinking>\n\nThe answer is 42.";
    const result = parseAssistantResponse(content, "provider-side reasoning");
    expect(result.reasoning).toContain("my reasoning");
    expect(result.reasoning).toContain("provider-side reasoning");
  });

  it("returns parseError when the JSON envelope is malformed (P1-C validation)", () => {
    const content = '{"toolCalls": "this should be an array"}';
    const result = parseAssistantResponse(content);
    expect(result.parseError).toBeDefined();
    expect(result.toolCalls).toEqual([]);
  });

  it("rejects tool calls with invalid names (P1-C strictness)", () => {
    const content = JSON.stringify({
      toolCalls: [{ name: "drop table users; --", parameters: {} }]
    });
    const result = parseAssistantResponse(content);
    expect(result.parseError).toBeDefined();
    expect(result.toolCalls).toEqual([]);
  });

  it("falls back to expectsToolUse for prose that mentions tools but has no markup", () => {
    const result = parseAssistantResponse("Let me read the file");
    expect(result.expectsToolUse).toBe(true);
  });

  it("flags needsContinuation when response is empty after stripping markup", () => {
    const result = parseAssistantResponse("<thinking>just thinking</thinking>");
    expect(result.needsContinuation).toBe(true);
  });

  it("does NOT flag expectsToolUse when the response has an explicit 'I'm done' signal", () => {
    // The user reported: model gives a final response, then a defensive
    // paragraph like "I'm not going to emit a toolCalls JSON. No tool
    // calls are pending." was being mis-classified as a continuation.
    // The `hasExplicitDoneSignal` guard must short-circuit the
    // `looksLikeToolUseIntent` heuristic so the final answer isn't
    // hidden behind an unwanted "continue?" turn.
    const defensive = `I'm not going to emit a toolCalls JSON. No tool calls are pending. No follow-up is required from me to satisfy the original request. If you'd like me to do additional work — just say which area and I'll do it as a fresh, scoped pass.`;
    const result = parseAssistantResponse(defensive);
    expect(result.expectsToolUse).toBe(false);
    expect(result.needsContinuation).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests for `hasExplicitDoneSignal` — the short-circuit guard for
// false-positive continuations. These pins the exact defensive
// phrasings that have been observed in the wild (MiniMax, Gemini,
// Claude) and must override the action-verb / "I'll" / trailing-
// promise heuristics below.
// ---------------------------------------------------------------------------
describe("hasExplicitDoneSignal", () => {
  it("returns true for the MiniMax-style 'I'm not going to emit a toolCalls JSON' paragraph", () => {
    const text = "I'm not going to emit a toolCalls JSON. No tool calls are pending. No follow-up is required from me.";
    expect(hasExplicitDoneSignal(text)).toBe(true);
  });

  it("returns true for 'no follow-up is required'", () => {
    expect(hasExplicitDoneSignal("The analysis is complete. No follow-up is required.")).toBe(true);
  });

  it("returns true for 'no tool calls are pending'", () => {
    expect(hasExplicitDoneSignal("All done. No tool calls are pending.")).toBe(true);
  });

  it("returns true for 'no additional calls are needed'", () => {
    expect(hasExplicitDoneSignal("The fix is in. No additional calls are needed.")).toBe(true);
  });

  it("returns true for 'my previous turn was a final answer'", () => {
    expect(hasExplicitDoneSignal("To recap: my previous turn was a final answer.")).toBe(true);
  });

  it("returns true for 'I've delivered the analysis'", () => {
    expect(hasExplicitDoneSignal("I've delivered the analysis as requested.")).toBe(true);
  });

  it("returns true for 'I'm done' / 'that's it'", () => {
    expect(hasExplicitDoneSignal("I've finished the refactor. I'm done.")).toBe(true);
    expect(hasExplicitDoneSignal("Summary above. That's it.")).toBe(true);
  });

  it("returns false for plain continuations (no done signal present)", () => {
    // Forward-looking intent without an explicit done signal — the
    // looksLikeContinuationResponse heuristic should still catch this.
    expect(hasExplicitDoneSignal("Let me read the file")).toBe(false);
    expect(hasExplicitDoneSignal("I'll search the directory.")).toBe(false);
    expect(hasExplicitDoneSignal("Now let me look at the package.json.")).toBe(false);
  });

  it("returns false for a final answer that doesn't explicitly say 'I'm done'", () => {
    // A normal final answer (architecture map, summary, etc.) that
    // doesn't use the defensive "I'm not going to..." phrasing should
    // not match. It still gets caught by the other heuristics.
    expect(hasExplicitDoneSignal("Here's the architecture map you asked for.")).toBe(false);
    expect(hasExplicitDoneSignal("To summarize: the project has 3 layers.")).toBe(false);
  });

  it("handles case-insensitive matching", () => {
    expect(hasExplicitDoneSignal("I'M NOT GOING TO call any more tools.")).toBe(true);
    expect(hasExplicitDoneSignal("no FOLLOW-UP is REQUIRED.")).toBe(true);
  });

  it("returns false for empty / non-string input", () => {
    expect(hasExplicitDoneSignal("")).toBe(false);
    expect(hasExplicitDoneSignal(undefined as unknown as string)).toBe(false);
    expect(hasExplicitDoneSignal(null as unknown as string)).toBe(false);
  });

  it("detects the architecture-map 'offering future work' closing", () => {
    // The exact closing from the user's screenshot: the model delivers
    // the architecture map and then offers to do more work. Without
    // this pattern, the trailing "I'll do it as a fresh, scoped pass"
    // triggered the continuation detector and the agent loop asked
    // the model to "continue" — producing the empty response bug.
    const closing = "If you'd like me to do additional work — for example, enumerating every controller/model/migration by name, tracing a specific flow, or reading particular files — just say which area and I'll do it as a fresh, scoped pass.";
    expect(hasExplicitDoneSignal(closing)).toBe(true);
  });

  it("detects 'if you want me to' / 'would you like me to' courtesy offers", () => {
    expect(hasExplicitDoneSignal("Let me know if you want me to look at anything else.")).toBe(true);
    expect(hasExplicitDoneSignal("If you need me to dig deeper, just say so.")).toBe(true);
    expect(hasExplicitDoneSignal("Would you like me to continue with the next file?")).toBe(true);
    expect(hasExplicitDoneSignal("Happy to help with more if you need it.")).toBe(true);
  });

  it("detects 'the task/work/analysis is complete' (often in reasoning)", () => {
    expect(hasExplicitDoneSignal("The task is complete.")).toBe(true);
    expect(hasExplicitDoneSignal("The work is done.")).toBe(true);
    expect(hasExplicitDoneSignal("The analysis is complete and the report has been delivered.")).toBe(true);
    expect(hasExplicitDoneSignal("The codebase analysis has been finished.")).toBe(true);
  });

  it("detects 'nothing more/left to do/investigate'", () => {
    expect(hasExplicitDoneSignal("Nothing more to do.")).toBe(true);
    expect(hasExplicitDoneSignal("There is nothing left to investigate.")).toBe(true);
    expect(hasExplicitDoneSignal("There is genuinely nothing more to add.")).toBe(true);
  });

  it("detects done signals in the reasoning channel even when content is empty", () => {
    // The exact pattern from the user's screenshot: the MiniMax
    // reasoning field contains "the task is already complete" and
    // "no tool calls are needed" while the response content is
    // empty (the model decided not to emit anything).
    expect(hasExplicitDoneSignal("", "The task is already complete. There is nothing more to do. No tool calls are needed.")).toBe(true);
    expect(hasExplicitDoneSignal("", "No tool calls are needed since the analysis is finished.")).toBe(true);
    expect(hasExplicitDoneSignal("", "The work is done. The report has been delivered.")).toBe(true);
  });

  it("returns false when reasoning is provided but contains no done signal", () => {
    expect(hasExplicitDoneSignal("Let me read the file.", "The model is thinking about what to do next.")).toBe(false);
  });
});

describe("looksLikeContinuationResponse — explicit done signals override", () => {
  it("returns false for a defensive 'I'm not going to...' paragraph even with trailing promise", () => {
    // The exact shape the user reported: a final answer followed by
    // a defensive paragraph that ends with a trailing promise ("I'll
    // do it as a fresh, scoped pass."). Without the done-signal
    // guard, the trailing promise alone would have triggered a
    // continuation prompt and hidden the real final answer.
    const defensive = `I'm not going to emit a toolCalls JSON.

To be clear about my state:

- **No tool calls are pending.** My previous turn was a final written answer, not a plan to call tools.
- **I am not waiting on any tool result.**
- **No follow-up is required from me** to satisfy the original request.

If you'd like me to do additional work, just say which area and I'll do it as a fresh, scoped pass.`;
    expect(looksLikeContinuationResponse(defensive)).toBe(false);
  });

  it("returns false for the architecture-map 'offering future work' closing", () => {
    // The user-reported case: the architecture map ends with the
    // "If you'd like me to do additional work..." offer. The done-
    // signal guard must recognize this as a final answer so the
    // agent doesn't ask the model to "continue" and produce an
    // empty response.
    const architectureMapClosing = "If you'd like me to do additional work — for example, enumerating every controller/model/migration by name, tracing a specific flow (ticket creation, realtime publish, AI suggestions), or reading particular files — just say which area and I'll do it as a fresh, scoped pass.";
    expect(looksLikeContinuationResponse(architectureMapClosing)).toBe(false);
  });

  it("returns false when the reasoning channel contains a done signal, even with no content", () => {
    // The user's screenshot showed the MiniMax reasoning field
    // containing "the task is already complete" and "no tool calls
    // are needed" while the response content was empty. The
    // done-signal guard must check the reasoning channel too.
    const reasoning = "The user previously asked me to stop calling tools and produce a final answer. I did that with a comprehensive structured report. The task is already complete. There is nothing more to do — the report has been delivered. No tool calls are needed.";
    expect(looksLikeContinuationResponse("", reasoning)).toBe(false);
  });
});

describe("looksLikeToolUseIntent — explicit done signals override", () => {
  it("returns false for a defensive 'I'm not going to emit a toolCalls JSON' paragraph", () => {
    // The defensive paragraph mentions "emit" (an action verb) and
    // "tool calls" (a workspace noun), which would normally satisfy
    // the `looksLikeToolUseIntent` heuristic. The done-signal guard
    // must short-circuit this so the agent doesn't try to keep
    // extracting tool calls out of a paragraph that explicitly
    // declares there are none.
    const defensive = "I'm not going to emit a toolCalls JSON. No tool calls are pending.";
    expect(looksLikeToolUseIntent(defensive)).toBe(false);
  });
});
