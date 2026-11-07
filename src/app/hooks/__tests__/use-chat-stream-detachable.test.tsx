// Detachable-runs behavior of useChatStream: the module-level live-run
// store keeps updating after the owning view unmounts (agent mode), a
// remounted view hydrates from the store instantly, chat partials merge
// into the trailing message, and the queued-prompt flush never fires
// headless. The pre-existing hook contract is covered by
// use-chat-stream.test.tsx.

import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type MutableRefObject } from "react";

import { useChatStream } from "../use-chat-stream";
import type { ChatMessage, ChatMode, ApiKeySwitchNotice } from "../../types/chat";
import {
  getLiveRunState,
  hasLiveRun,
  resetAllLiveRuns,
  setLiveActiveRun,
  setLivePending,
  setLiveStreamingText,
  pushLiveToolCall,
} from "../../../lib/live-run-store";

const streamAgentMock = vi.hoisted(() => vi.fn());
const abortAgentRunMock = vi.hoisted(() => vi.fn());

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../../../lib/agent-api", () => ({
  streamAgent: (...args: unknown[]) => streamAgentMock(...args),
  submitAgentToolApproval: vi.fn(),
  abortAgentRun: (...args: unknown[]) => abortAgentRunMock(...args),
  pauseAgentRun: vi.fn(async () => ({ ok: true })),
  resumeAgentRun: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../../lib/agent-settings", () => ({
  DEFAULT_AUTO_APPROVE_TOOLS: [],
  useAgentSettings: () => ({
    settings: { maxIterations: 5, autoApproveCategories: [] },
  }),
}));

vi.mock("../../../lib/api", () => ({
  streamChat: vi.fn(),
  forkConversation: vi.fn(),
  deleteConversationMessages: vi.fn(),
}));

type HookApi = ReturnType<typeof useChatStream>;

function HookHarness({
  hookRef,
  initialConversationId,
  initialMessages = [],
}: {
  hookRef: MutableRefObject<HookApi | null>;
  initialConversationId?: string;
  initialMessages?: ChatMessage[];
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId);
  const [provider, setProvider] = useState("gemini");
  const [model, setModel] = useState("test-model");
  const [mode, setMode] = useState<ChatMode>("agent");
  const [, setError] = useState<string | null>(null);
  const [, setApiKeySwitchNotice] = useState<ApiKeySwitchNotice | null>(null);
  const [, setApprovalBusyIds] = useState<string[]>([]);

  const hook = useChatStream({
    conversationId,
    selectedConversationId: initialConversationId,
    selectedProvider: provider,
    selectedModel: model,
    selectedReasoningEffort: "off",
    mode,
    workspaceId: undefined,
    messages,
    setMessages,
    setConversationId,
    setSelectedProvider: setProvider,
    setSelectedModel: setModel,
    setError,
    setApiKeySwitchNotice,
    setMode,
    setApprovalBusyIds,
  });
  hookRef.current = hook;

  const last = messages[messages.length - 1];
  return (
    <div>
      <span data-testid="pending">{String(hook.pending)}</span>
      <span data-testid="queued">{String(hook.queuedPrompt ?? "")}</span>
      <span data-testid="message-count">{String(messages.length)}</span>
      <span data-testid="last-content">{last?.content ?? ""}</span>
      <span
        data-testid="last-message"
        data-role={last?.role ?? ""}
        data-run-id={last?.agentRunId ?? ""}
        data-mode={last?.mode ?? ""}
        data-live-tools={String(last?.liveToolCalls?.length ?? 0)}
      />
    </div>
  );
}

const DONE_EVENT = {
  type: "done" as const,
  status: "completed" as const,
  response: "final answer",
  steps: [],
  iterations: 2,
};

beforeEach(() => {
  resetAllLiveRuns();
  streamAgentMock.mockReset();
  abortAgentRunMock.mockReset();
  abortAgentRunMock.mockResolvedValue({ ok: true });
});

describe("detachable runs: unmount keeps the run alive", () => {
  it("does not abort an agent stream on unmount; the loop keeps writing the store", async () => {
    const hookRef: MutableRefObject<HookApi | null> = { current: null };
    let handlers: Record<string, ((event: unknown) => void) | undefined> = {};
    let settle: (() => void) | null = null;
    streamAgentMock.mockImplementation((_params: unknown, streamHandlers: typeof handlers) => {
      handlers = streamHandlers;
      return new Promise<void>((resolve) => {
        settle = resolve;
      });
    });

    const { unmount } = render(<HookHarness hookRef={hookRef} />);
    await act(async () => {
      void hookRef.current?.submitPrompt("long running task");
    });
    await act(async () => {
      handlers.onStart?.({ type: "start", conversationId: "c-live", model: "test-model", runId: "run-live" });
    });
    expect(hasLiveRun("c-live")).toBe(true);
    expect(getLiveRunState("c-live").activeRunId).toBe("run-live");

    // The critical property: unmounting must NOT abort the in-flight run.
    unmount();

    await act(async () => {
      handlers.onThinking?.({ type: "thinking", iteration: 2, reasoning: "still working" });
      handlers.onToolCall?.({
        type: "tool_call",
        iteration: 2,
        status: "running",
        call: { id: "t1", name: "read_file", parameters: {} },
      });
    });
    const state = getLiveRunState("c-live");
    expect(state.pending).toBe(true);
    expect(state.liveReasoning).toBe("still working");
    expect(state.liveToolCalls).toHaveLength(1);

    // Settling after unmount finalizes the store instead of losing the run.
    await act(async () => {
      handlers.onDone?.({ ...DONE_EVENT });
      settle?.();
      await Promise.resolve();
    });
    const settled = getLiveRunState("c-live");
    expect(settled.pending).toBe(false);
    expect(settled.streamingText).toBe("final answer");
  });

  it("still aborts a chat stream on unmount (server cancels upstream)", async () => {
    const { streamChat } = await import("../../../lib/api");
    const streamChatMock = streamChat as ReturnType<typeof vi.fn>;
    const hookRef: MutableRefObject<HookApi | null> = { current: null };
    const streamChatHandlers: Record<string, ((event: unknown) => void) | undefined> = {};
    let settle: (() => void) | null = null;
    streamChatMock.mockImplementation((_params: unknown, handlers: typeof streamChatHandlers) => {
      Object.assign(streamChatHandlers, handlers);
      return new Promise<void>((resolve) => {
        settle = resolve;
      });
    });

    const { unmount } = render(<HookHarness hookRef={hookRef} />);
    await act(async () => {
      void hookRef.current?.submitPrompt("chat it", [], { mode: "chat" });
    });
    await act(async () => {
      streamChatHandlers.onStart?.({ type: "start", conversationId: "c-chat", model: "test-model" });
    });
    expect(hasLiveRun("c-chat")).toBe(true);

    unmount();

    // The unmount abort caused the chat stream to unwind with an
    // AbortError — the store settles (the empty partial is kept for the
    // return trip) and the chat executor released its lock.
    await act(async () => {
      settle?.();
      await Promise.resolve();
    });
    expect(hasLiveRun("c-chat")).toBe(false);
    expect(getLiveRunState("c-chat").streamingText).toBe("");
  });
});

describe("detachable runs: remount hydration", () => {
  it("derives pending and synthesizes the in-flight assistant message from the store", async () => {
    setLivePending("c-hy", true);
    setLiveActiveRun("c-hy", "run-hy", { source: "attached", mode: "agent" });
    setLiveStreamingText("c-hy", "partial answer", "replace");
    pushLiveToolCall("c-hy", {
      iteration: 2,
      status: "running",
      call: { id: "t9", name: "edit_file", parameters: {} },
    });

    const hookRef: MutableRefObject<HookApi | null> = { current: null };
    const { container } = render(<HookHarness hookRef={hookRef} initialConversationId="c-hy" />);

    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe("true");
    const lastMessage = container.querySelector('[data-testid="last-message"]');
    expect(lastMessage?.getAttribute("data-run-id")).toBe("run-hy");
    expect(lastMessage?.getAttribute("data-mode")).toBe("agent");
    expect(lastMessage?.getAttribute("data-live-tools")).toBe("1");
    expect(container.querySelector('[data-testid="last-content"]')?.textContent).toBe("partial answer");
    expect(container.querySelector('[data-testid="message-count"]')?.textContent).toBe("1");
  });

  it("applies live store deltas to the remounted view while the run streams", async () => {
    setLivePending("c-hy2", true);
    setLiveActiveRun("c-hy2", "run-hy2", { source: "attached", mode: "agent" });
    setLiveStreamingText("c-hy2", "chunk one", "replace");

    const hookRef: MutableRefObject<HookApi | null> = { current: null };
    const { container } = render(<HookHarness hookRef={hookRef} initialConversationId="c-hy2" />);
    expect(container.querySelector('[data-testid="last-content"]')?.textContent).toBe("chunk one");

    await act(async () => {
      setLiveStreamingText("c-hy2", " chunk two", "append");
    });
    expect(container.querySelector('[data-testid="last-content"]')?.textContent).toBe("chunk one chunk two");
  });

  it("hydrates a chat-mode partial into an empty trailing assistant message", async () => {
    setLiveActiveRun("c-chatpartial", null, { source: "chat", mode: "chat" });
    setLiveStreamingText("c-chatpartial", "aborted partial text", "replace");

    const hookRef: MutableRefObject<HookApi | null> = { current: null };
    const { container } = render(
      <HookHarness
        hookRef={hookRef}
        initialConversationId="c-chatpartial"
        initialMessages={[
          { id: "u1", role: "user", content: "hello" },
          { id: "a1", role: "assistant", content: "", mode: "chat" },
        ]}
      />
    );

    expect(container.querySelector('[data-testid="last-content"]')?.textContent).toBe("aborted partial text");
  });

  it("does not overwrite a trailing assistant message that already has content", async () => {
    setLiveActiveRun("c-chatdone", null, { source: "chat", mode: "chat" });
    setLiveStreamingText("c-chatdone", "stale partial", "replace");

    const hookRef: MutableRefObject<HookApi | null> = { current: null };
    const { container } = render(
      <HookHarness
        hookRef={hookRef}
        initialConversationId="c-chatdone"
        initialMessages={[
          { id: "u1", role: "user", content: "hello" },
          { id: "a1", role: "assistant", content: "canonical response", mode: "chat" },
        ]}
      />
    );

    expect(container.querySelector('[data-testid="last-content"]')?.textContent).toBe("canonical response");
  });

  it("stops a reattached run via the store's run id and settles the store", async () => {
    setLivePending("c-stop", true);
    setLiveActiveRun("c-stop", "run-stop", { source: "reattached", mode: "agent" });

    const hookRef: MutableRefObject<HookApi | null> = { current: null };
    render(<HookHarness hookRef={hookRef} initialConversationId="c-stop" />);
    expect(hookRef.current?.pending).toBe(true);

    act(() => {
      hookRef.current?.handleStopGeneration();
    });
    expect(abortAgentRunMock).toHaveBeenCalledWith("run-stop");
    expect(hasLiveRun("c-stop")).toBe(false);
    expect(hookRef.current?.pending).toBe(false);
  });
});

describe("detachable runs: queued prompt flush guard", () => {
  it("does not flush the queued prompt when no mounted consumer exists", async () => {
    const hookRef: MutableRefObject<HookApi | null> = { current: null };
    let settle: (() => void) | null = null;
    streamAgentMock.mockImplementation((_params: unknown, handlers: Record<string, (event: unknown) => void>) => {
      handlers.onStart?.({ type: "start", conversationId: "c-q", model: "test-model", runId: "run-q" });
      return new Promise<void>((resolve) => {
        settle = resolve;
      });
    });

    const { unmount } = render(<HookHarness hookRef={hookRef} />);
    await act(async () => {
      void hookRef.current?.submitPrompt("first");
    });
    await act(async () => {
      void hookRef.current?.submitPrompt("second"); // queued
    });
    unmount();

    await act(async () => {
      settle?.();
      await Promise.resolve();
    });
    // The run's own post-run flush must be refused headless — exactly one
    // stream was ever opened.
    expect(streamAgentMock).toHaveBeenCalledTimes(1);
  });

  it("flushes the queued prompt when a remounted view for the run's conversation exists", async () => {
    const hookRef: MutableRefObject<HookApi | null> = { current: null };
    let call = 0;
    let settleFirst: (() => void) | null = null;
    streamAgentMock.mockImplementation((_params: unknown, handlers: Record<string, (event: unknown) => void>) => {
      call += 1;
      handlers.onStart?.({ type: "start", conversationId: "c-q2", model: "test-model", runId: `run-q2-${call}` });
      if (call === 1) {
        return new Promise<void>((resolve) => {
          settleFirst = resolve;
        });
      }
      handlers.onDone?.({ ...DONE_EVENT });
      return Promise.resolve();
    });

    const first = render(<HookHarness hookRef={hookRef} />);
    await act(async () => {
      void hookRef.current?.submitPrompt("first");
    });
    await act(async () => {
      void hookRef.current?.submitPrompt("second"); // queued
    });
    first.unmount();

    // Remount for the same conversation — a live consumer exists again.
    const secondHookRef: MutableRefObject<HookApi | null> = { current: null };
    const second = render(<HookHarness hookRef={secondHookRef} initialConversationId="c-q2" />);

    await act(async () => {
      settleFirst?.();
      await Promise.resolve();
    });

    expect(streamAgentMock).toHaveBeenCalledTimes(2);
    second.unmount();
  });
});
