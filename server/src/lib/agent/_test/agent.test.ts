// Tests for the Agent iteration loop (agent.ts).
//
// The loop has no production test coverage of its own — its extracted modules
// (response-parser, tool-orchestrator, llm-client) are tested individually.
// These tests drive the loop end-to-end with a stubbed LLMClient so we can
// assert on the yielded AgentExecutionEvent stream without touching the network.
//
// The Agent constructor accepts an optional injected LLMClient (test seam);
// production callers omit it and get a real client. Here we pass a fake that
// returns canned responses from a script.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../agent.js";
import { LLMClient } from "../llm-client.js";
import { registerAllTools, toolRegistry } from "../../../tools/index.js";
import type { AgentConfig, AgentExecutionEvent, AgentMessage, ProviderChatMessage } from "../types.js";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "rapa-agent-"));
  registerAllTools();
});

afterEach(() => {
  // registerAllTools() is idempotent (guards on a `registered` flag), so we
  // don't tear it down between tests — only the workspace temp needs no cleanup
  // (the OS reaps tmpdir). Leaving tools registered matches production boot.
});

/**
 * Minimal LLMClient stub. `script` is a list of canned assistant messages the
 * fake returns, one per call to streamChat (the loop calls streamChat once per
 * iteration). The fake yields a single chunk per message and then returns the
 * AgentMessage — the loop consumes both the deltas and the final value.
 *
 * `graceSynthesisResponse` optionally overrides what the synthesis call
 * returns (the loop's grace-synthesis path calls streamChat with an empty
 * tools array, which we detect by checking the third argument).
 *
 * Returns the stubbed client PLUS a `calls` array capturing the messages
 * handed to every streamChat invocation, so tests can assert on the exact
 * wire-format payload the agent sent to the provider (e.g. that the second
 * call carries valid tool_calls + linked role:"tool" messages).
 */
function makeFakeLlm(
  script: AgentMessage[],
  opts: { graceSynthesisResponse?: string } = {}
): LLMClient & { calls: Array<{ messages: ProviderChatMessage[]; openAITools: unknown[] }> } {
  let callIndex = 0;
  const calls: Array<{ messages: ProviderChatMessage[]; openAITools: unknown[] }> = [];
  const fake = {
    async *streamChat(
      messages: ProviderChatMessage[],
      _timeoutMs: number,
      openAITools: unknown[]
    ): AsyncGenerator<unknown, AgentMessage, unknown> {
      // Capture a snapshot of what the agent is sending so tests can assert
      // on the OpenAI wire format (the previous bug was a malformed payload).
      calls.push({
        messages: messages.map((m) => ({ ...m })),
        openAITools: Array.isArray(openAITools) ? [...openAITools] : []
      });

      // Grace-synthesis calls are made with an empty tools array. If the script
      // is exhausted or the caller asked for a specific synthesis response,
      // honor it here so runGraceSynthesis() behaves deterministically.
      const isGraceSynthesis = Array.isArray(openAITools) && openAITools.length === 0;
      if (isGraceSynthesis) {
        const text = opts.graceSynthesisResponse ?? "";
        if (text) {
          yield { type: "chunk", contentDelta: text };
        }
        return { role: "assistant", content: text };
      }

      const message = script[callIndex] ?? script[script.length - 1] ?? { role: "assistant", content: "" };
      callIndex += 1;
      if (typeof message.content === "string" && message.content.length > 0) {
        yield { type: "chunk", contentDelta: message.content };
      }
      if (message.reasoning) {
        yield { type: "chunk", reasoningDelta: message.reasoning };
      }
      return message;
    },
    getApiKeySwitch() {
      return undefined;
    },
    getCurrentKeyInfo() {
      return {};
    },
    calls
  };
  return fake as unknown as LLMClient & { calls: typeof calls };
}

function buildConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    maxIterations: 10,
    autoApproveTools: [],
    provider: "test",
    model: "test-model",
    baseUrl: "http://localhost",
    apiKey: "k",
    ...overrides
  };
}

async function runAgent(
  llm: LLMClient,
  prompt: string,
  configOverrides: Partial<AgentConfig> = {}
): Promise<{
  events: AgentExecutionEvent[];
  done?: Extract<AgentExecutionEvent, { type: "done" }>;
  calls: Array<{ messages: ProviderChatMessage[]; openAITools: unknown[] }>;
}> {
  const agent = new Agent(
    { workspaceRoot, userId: "u", conversationId: "c1", mode: "agent" },
    buildConfig(configOverrides),
    llm
  );
  const events: AgentExecutionEvent[] = [];
  for await (const event of agent.stream(prompt)) {
    events.push(event);
  }
  const done = events.find((e): e is Extract<AgentExecutionEvent, { type: "done" }> => e.type === "done");
  const calls = "calls" in llm
    ? (llm as unknown as { calls: Array<{ messages: ProviderChatMessage[]; openAITools: unknown[] }> }).calls
    : [];
  return { events, done, calls };
}

describe("Agent loop — native function calling", () => {
  it("executes native tool calls without a parse error", async () => {
    // First call: native tool call to list_directory. Second call: final prose.
    const llm = makeFakeLlm([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "list_directory", parameters: { path: "." } }]
      },
      { role: "assistant", content: "The workspace root is listed." }
    ]);

    const { events, done } = await runAgent(llm, "List the workspace");

    // No parse error event should be emitted on the native path.
    expect(events.some((e) => e.type === "error")).toBe(false);
    // A completed tool_call event should fire for list_directory. The loop emits
    // a "pending" event first and a "completed" event after execution, so we
    // look for the completed one specifically.
    const completedToolCall = events.find(
      (e): e is Extract<AgentExecutionEvent, { type: "tool_call" }> =>
        e.type === "tool_call" && e.call.name === "list_directory" && e.status === "completed"
    );
    expect(completedToolCall).toBeDefined();
    // The run should finish cleanly with the final prose.
    expect(done?.status).toBe("completed");
    expect(done?.response).toBe("The workspace root is listed.");
  });

  it("treats a turn with no tool calls as the final answer", async () => {
    const llm = makeFakeLlm([
      { role: "assistant", content: "Here is the answer with no tool use." }
    ]);
    const { done } = await runAgent(llm, "Just answer");
    expect(done?.status).toBe("completed");
    expect(done?.response).toBe("Here is the answer with no tool use.");
    expect(done?.iterations).toBe(1);
  });

  it("sends a schema-valid tool-call exchange to the SECOND LLM call (round-trip)", async () => {
    // This is the regression test for the bug that produced the provider
    // 400 "invalid params, tool results" seen in production: after a native
    // tool call executes, the next streamChat call must carry the assistant
    // tool_calls turn followed by a role:"tool" message PER call, each linked
    // by tool_call_id. Anything else is rejected by MiniMax/Gemini/OpenAI.
    const llm = makeFakeLlm([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-42", name: "list_directory", parameters: { path: "." } }]
      },
      { role: "assistant", content: "Done — the directory was listed." }
    ]);

    const { calls } = await runAgent(llm, "List the workspace");

    // Two streamChat invocations: the initial call and the post-tool call.
    expect(calls).toHaveLength(2);
    const secondCallMessages = calls[1].messages;

    // Find the assistant turn with tool_calls in the second payload.
    const assistantToolTurn = secondCallMessages.find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
    );
    expect(assistantToolTurn).toBeDefined();
    expect(assistantToolTurn?.tool_calls?.[0].id).toBe("call-42");

    // Exactly one role:"tool" message must follow, linked back by tool_call_id.
    const toolReplies = secondCallMessages.filter((m) => m.role === "tool");
    expect(toolReplies).toHaveLength(1);
    expect(toolReplies[0].tool_call_id).toBe("call-42");
    expect(toolReplies[0].name).toBe("list_directory");

    // And the tool reply must come AFTER the assistant tool_calls turn.
    const assistantIdx = secondCallMessages.indexOf(assistantToolTurn!);
    const toolIdx = secondCallMessages.indexOf(toolReplies[0]);
    expect(toolIdx).toBeGreaterThan(assistantIdx);

    // No orphan role:"tool" messages (every tool message must have a call id).
    for (const m of secondCallMessages) {
      if (m.role === "tool") {
        expect(m.tool_call_id).toBeDefined();
      }
    }
  });
});

describe("Agent loop — bailouts are recoverable", () => {
  it("does not bail after 3 parse errors (threshold is now 5)", async () => {
    // Three consecutive malformed JSON envelopes should NOT kill the run — the
    // loop should still be alive and able to recover on the 4th call.
    const llm = makeFakeLlm([
      // The model emits a toolCalls field but it's malformed (string, not array),
      // which parseAssistantResponse flags as a parseError (covered by
      // response-parser.test.ts). We emit 3 of these.
      { role: "assistant", content: '{"toolCalls": "not-an-array"}' },
      { role: "assistant", content: '{"toolCalls": "not-an-array"}' },
      { role: "assistant", content: '{"toolCalls": "not-an-array"}' },
      // 4th call: clean final answer.
      { role: "assistant", content: "Recovered after three stumbles." }
    ]);

    const { done } = await runAgent(llm, "Do something");
    // The run completes with the recovered answer rather than bailing at 3.
    expect(done?.status).toBe("completed");
    expect(done?.response).toBe("Recovered after three stumbles.");
  });

  it("emits 'interrupted' (not 'completed') when grace synthesis yields nothing on the stall path", async () => {
    // Drive the stall detector by repeating the same tool-call signature with
    // no text, enough times to cross STUCK_THRESHOLD (6). We give the fake a
    // long script of identical read_file calls. forceAnswerNext fires, the
    // model emits no prose on the forced round, grace synthesis returns "" —
    // so the run should end with status "interrupted".
    //
    // We pin maxIterations low so the test is fast, but high enough that the
    // stall detector (6 useless rounds) trips before the iteration cap.
    const repeatingCall: AgentMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "r", name: "read_file", parameters: { path: "package.json" } }]
    };
    const llm = makeFakeLlm(
      Array.from({ length: 12 }, () => ({ ...repeatingCall })),
      // Grace synthesis returns empty → run is interrupted, not completed.
      { graceSynthesisResponse: "" }
    );

    const { done } = await runAgent(llm, "Loop forever", { maxIterations: 15 });
    expect(done).toBeDefined();
    expect(done?.status).toBe("interrupted");
  });
});

describe("Agent loop — iteration cap", () => {
  it("respects maxIterations and ends with max_iterations status", async () => {
    // Every turn emits a distinct tool call so no stall detector trips; the
    // only thing that ends the run is the iteration cap.
    const makeCall = (i: number): AgentMessage => ({
      role: "assistant",
      content: `Working on step ${i}.`,
      toolCalls: [{ id: `c-${i}`, name: "list_directory", parameters: { path: `sub-${i}` } }]
    });
    const llm = makeFakeLlm(Array.from({ length: 20 }, (_, i) => makeCall(i)));

    const { done } = await runAgent(llm, "Keep going", { maxIterations: 3 });
    expect(done?.status).toBe("max_iterations");
    expect(done?.iterations).toBe(3);
  });
});
