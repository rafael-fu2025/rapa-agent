import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type MutableRefObject } from "react";

import { useChatStream } from "../use-chat-stream";
import type { ChatMessage, ChatMode, ApiKeySwitchNotice } from "../../types/chat";
import type { AgentExecutionEvent } from "../../../lib/agent-api";

// Module-level spies wired through vi.mock factory.
const streamAgentMock = vi.hoisted(() => vi.fn());
const streamChatMock = vi.hoisted(() => vi.fn());

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../../../lib/agent-api", () => ({
  streamAgent: (...args: unknown[]) => streamAgentMock(...args),
  submitAgentToolApproval: vi.fn(),
  abortAgentRun: vi.fn(async () => ({ ok: true })),
  pauseAgentRun: vi.fn(async () => ({ ok: true })),
  resumeAgentRun: vi.fn(async () => ({ ok: true })),
}));

// Mutable settings fixture — the payload test overrides it, beforeEach
// restores the defaults.
const agentSettingsFixture = vi.hoisted(() => ({
  value: { maxIterations: 5, autoApproveCategories: [] } as Record<string, unknown>,
}));

vi.mock("../../../lib/agent-settings", () => ({
  DEFAULT_AUTO_APPROVE_TOOLS: [],
  useAgentSettings: () => ({
    settings: agentSettingsFixture.value,
  }),
}));

vi.mock("../../../lib/api", () => ({
  streamChat: (...args: unknown[]) => streamChatMock(...args),
  forkConversation: vi.fn(),
  deleteConversationMessages: vi.fn(),
}));

type HookApi = ReturnType<typeof useChatStream>;

function HookHarness({ hookRef }: { hookRef: MutableRefObject<HookApi | null> }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [provider, setProvider] = useState("gemini");
  const [model, setModel] = useState("test-model");
  const [mode, setMode] = useState<ChatMode>("agent");
  const [, setError] = useState<string | null>(null);
  const [, setApiKeySwitchNotice] = useState<ApiKeySwitchNotice | null>(null);
  const [, setApprovalBusyIds] = useState<string[]>([]);

  const hook = useChatStream({
    conversationId,
    selectedConversationId: undefined,
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

  return (
    <div>
      <span data-testid="usage">{JSON.stringify(hook.sessionUsage)}</span>
      <span data-testid="queued">{String(hook.queuedPrompt ?? "")}</span>
      <span data-testid="last-worktree">{JSON.stringify(messages.at(-1)?.worktree ?? null)}</span>
    </div>
  );
}

function readJson(container: HTMLElement, testId: string): Record<string, unknown> {
  return JSON.parse(container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "{}");
}

/** streamAgent mock returning a manually-settleable promise so tests can
 *  simulate the stream dying (e.g. from the user's abort) without relying
 *  on jsdom AbortSignal event dispatch. */
function mockControllableAgentStream() {
  let settle: ((err?: Error) => void) | null = null;
  streamAgentMock.mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => {
        settle = (err) => (err ? reject(err) : resolve());
      })
  );
  return {
    rejectAborted: () => settle?.(new DOMException("Aborted", "AbortError")),
  };
}

const DONE_EVENT: Extract<AgentExecutionEvent, { type: "done" }> = {
  type: "done",
  status: "completed",
  response: "final answer",
  steps: [],
  iterations: 3,
  tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  contextUsage: { percent: 42, usedTokens: 4200, budgetTokens: 10000 },
  estimatedCostUsd: 0.0125,
  verification: { testsPassed: true, typecheckPassed: false },
};

beforeEach(() => {
  // Call counts are asserted per test — reset the shared module-level mocks.
  streamAgentMock.mockClear();
  streamChatMock.mockClear();
  agentSettingsFixture.value = { maxIterations: 5, autoApproveCategories: [] };
});

describe("useChatStream session usage meter", () => {
  it("accumulates context/cost/lastTotalTokens from agent done events", async () => {
    const hookRef: MutableRefObject<HookApi | null> = { current: null };
    streamAgentMock.mockImplementation(async (_params, handlers) => {
      handlers.onStart?.({ type: "start", conversationId: "c1", model: "test-model" });
      handlers.onDone?.({ ...DONE_EVENT });
    });

    const { container } = render(<HookHarness hookRef={hookRef} />);
    expect(readJson(container, "usage")).toEqual({ contextPercent: null, costUsd: 0, lastTotalTokens: null });

    await act(async () => {
      await hookRef.current?.submitPrompt("run one");
    });
    expect(readJson(container, "usage")).toEqual({ contextPercent: 42, costUsd: 0.0125, lastTotalTokens: 30 });

    // Second run: cost accumulates; a done without contextUsage resets
    // contextPercent to null (per-run reporting contract).
    streamAgentMock.mockImplementation(async (_params, handlers) => {
      handlers.onStart?.({ type: "start", conversationId: "c1", model: "test-model" });
      handlers.onDone?.({ ...DONE_EVENT, estimatedCostUsd: 0.0075, contextUsage: undefined, tokenUsage: { totalTokens: 55 } });
    });
    await act(async () => {
      await hookRef.current?.submitPrompt("run two");
    });
    expect(readJson(container, "usage")).toEqual({ contextPercent: null, costUsd: 0.02, lastTotalTokens: 55 });
  });

  it("resets the meter on resetStreamState (new conversation)", async () => {
    const hookRef: MutableRefObject<HookApi | null> = { current: null };
    streamAgentMock.mockImplementation(async (_params, handlers) => {
      handlers.onStart?.({ type: "start", conversationId: "c1", model: "test-model" });
      handlers.onDone?.({ ...DONE_EVENT });
    });

    const { container } = render(<HookHarness hookRef={hookRef} />);
    await act(async () => {
      await hookRef.current?.submitPrompt("run");
    });
    expect(readJson(container, "usage").costUsd).toBeGreaterThan(0);

    act(() => {
      hookRef.current?.resetStreamState();
    });
    expect(readJson(container, "usage")).toEqual({ contextPercent: null, costUsd: 0, lastTotalTokens: null });
  });
});

describe("useChatStream send-now (queued prompt)", () => {
  it("handleStopGeneration discards the queue", async () => {
    const hookRef: MutableRefObject<HookApi | null> = { current: null };
    const { rejectAborted } = mockControllableAgentStream();

    const { container } = render(<HookHarness hookRef={hookRef} />);

    await act(async () => {
      void hookRef.current?.submitPrompt("first");
    });
    act(() => {
      void hookRef.current?.submitPrompt("second");
    });
    expect(container.querySelector('[data-testid="queued"]')?.textContent).toBe("second");

    act(() => {
      hookRef.current?.handleStopGeneration();
    });
    // The queue is discarded immediately by the stop itself.
    expect(container.querySelector('[data-testid="queued"]')?.textContent).toBe("");

    // Let the aborted stream unwind — its post-run flush must be a no-op.
    await act(async () => {
      rejectAborted();
      await Promise.resolve();
    });
    expect(streamAgentMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="queued"]')?.textContent).toBe("");
  });

  it("handleSendQueuedNow aborts the run, keeps the queue, and flushes it", async () => {
    vi.useRealTimers();
    const hookRef: MutableRefObject<HookApi | null> = { current: null };
    const { rejectAborted } = mockControllableAgentStream();

    const { container } = render(<HookHarness hookRef={hookRef} />);

    await act(async () => {
      void hookRef.current?.submitPrompt("first");
    });
    act(() => {
      void hookRef.current?.submitPrompt("second");
    });
    expect(container.querySelector('[data-testid="queued"]')?.textContent).toBe("second");

    await act(async () => {
      hookRef.current?.handleSendQueuedNow();
      await Promise.resolve();
    });
    // keepQueue: the queued prompt survives the abort…
    expect(container.querySelector('[data-testid="queued"]')?.textContent).toBe("second");

    // …and once the stream settles, it is re-sent as a new agent run
    // (either the aborted stream's own flush or the 150ms send-now timer).
    await act(async () => {
      rejectAborted();
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(streamAgentMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="queued"]')?.textContent).toBe("");

    // The re-sent stream is still the never-settling controlled promise —
    // reject it so the hook's finally unwinds (releases the module-level
    // submit lock) before the next describe's tests run.
    await act(async () => {
      rejectAborted();
      await Promise.resolve();
    });
  });
});

describe("useChatStream agent request payload (Item 3 wiring)", () => {
  it("threads sandboxMode, classifier, and worktree from agent settings", async () => {
    agentSettingsFixture.value = {
      maxIterations: 5,
      autoApproveCategories: [],
      sandboxMode: "docker",
      autoApproveClassifier: { enabled: true, provider: "openai", model: "gpt-5-mini" },
      worktree: true,
    };
    const hookRef: MutableRefObject<HookApi | null> = { current: null };
    streamAgentMock.mockImplementation(async (_params, handlers) => {
      handlers.onStart?.({ type: "start", conversationId: "c1", model: "test-model" });
      handlers.onDone?.({ ...DONE_EVENT });
    });

    render(<HookHarness hookRef={hookRef} />);
    await act(async () => {
      await hookRef.current?.submitPrompt("isolated run");
    });

    expect(streamAgentMock).toHaveBeenCalledTimes(1);
    expect(streamAgentMock.mock.calls[0][0]).toMatchObject({
      sandboxMode: "docker",
      autoApproveClassifier: { enabled: true, provider: "openai", model: "gpt-5-mini" },
      worktree: true,
    });
  });

  it("omits the optional fields when settings are at their defaults", async () => {
    const hookRef: MutableRefObject<HookApi | null> = { current: null };
    streamAgentMock.mockImplementation(async (_params, handlers) => {
      handlers.onStart?.({ type: "start", conversationId: "c1", model: "test-model" });
      handlers.onDone?.({ ...DONE_EVENT });
    });

    render(<HookHarness hookRef={hookRef} />);
    await act(async () => {
      await hookRef.current?.submitPrompt("default run");
    });

    const params = streamAgentMock.mock.calls[0][0] as Record<string, unknown>;
    expect(params.sandboxMode).toBeUndefined();
    expect(params.autoApproveClassifier).toBeUndefined();
    expect(params.worktree).toBeUndefined();
  });

  it("merges done.worktree into the assistant message metadata", async () => {
    const hookRef: MutableRefObject<HookApi | null> = { current: null };
    streamAgentMock.mockImplementation(async (_params, handlers) => {
      handlers.onStart?.({ type: "start", conversationId: "c1", model: "test-model" });
      handlers.onDone?.({
        ...DONE_EVENT,
        worktree: { branch: "rapa/run-abc12345", path: "C:/repo/.rapa/worktrees/run-abc12345" },
      });
    });

    const { container } = render(<HookHarness hookRef={hookRef} />);
    await act(async () => {
      await hookRef.current?.submitPrompt("worktree run");
    });

    expect(JSON.parse(container.querySelector('[data-testid="last-worktree"]')?.textContent ?? "null")).toMatchObject({
      branch: "rapa/run-abc12345",
    });
  });
});
