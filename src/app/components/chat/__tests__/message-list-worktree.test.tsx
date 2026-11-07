// Worktree banner (Item 3) — merge/discard/open buttons on the newest
// agent message that ran in an isolated git worktree.

import { useCallback, useMemo, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MessageList } from "../message-list";
import type { ChatMessage } from "../../../types/chat";

const mergeRunWorktreeMock = vi.hoisted(() => vi.fn());
const discardRunWorktreeMock = vi.hoisted(() => vi.fn());
const fetchWithAuthMock = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("../../../../lib/agent-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/agent-api")>();
  return {
    ...actual,
    mergeRunWorktree: (...args: unknown[]) => mergeRunWorktreeMock(...args),
    discardRunWorktree: (...args: unknown[]) => discardRunWorktreeMock(...args),
  };
});

vi.mock("../../../../lib/http", () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));

vi.mock("sonner", () => ({
  toast: toastMock,
}));

vi.mock("../../assistant-markdown", () => ({
  AssistantMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("../../interactive-options", () => ({
  InteractiveOptions: () => null,
}));
vi.mock("../../mode-switch-prompt", () => ({
  ModeSwitchPrompt: () => null,
}));
vi.mock("../../agent-steps-viewer", () => ({
  AgentStepsViewer: () => null,
  ApprovalCard: () => null,
}));

const WORKTREE = {
  branch: "rapa/run-abc12345",
  path: "C:/repo/.rapa/worktrees/run-abc12345",
  workspaceId: "ws-1",
};

function makeMessages(withWorktree: boolean): ChatMessage[] {
  return [
    { id: "user-1", role: "user", content: "Build the thing", mode: "agent" },
    {
      id: "assistant-1",
      role: "assistant",
      content: "Done.",
      mode: "agent",
      agentRunId: "run-xyz",
      ...(withWorktree ? { worktree: WORKTREE } : {}),
      stats: { tokensPerSec: 10, totalTokens: 100, iterations: 2, status: "completed" },
    },
  ];
}

function Harness({ withWorktree }: { withWorktree: boolean }) {
  const [messages] = useState<ChatMessage[]>(() => makeMessages(withWorktree));
  const onCopy = useCallback(() => {}, []);
  const callbacks = useMemo(() => ({
    onStartEdit: () => {},
    onDraftChange: () => {},
    onSaveEdit: () => {},
    onResendEdit: () => {},
    onCancelEdit: () => {},
    onDelete: () => {},
    onFork: () => {},
    onRegenerate: () => {},
    onToolApproval: () => {},
    onModeSwitchApproval: () => {},
    onResumeRun: () => {},
    onDismissResume: () => {},
    onSubmit: () => {},
    onSetMode: () => {},
  }), []);

  return (
    <MessageList
      messages={messages}
      pending={false}
      reconnecting={null}
      mode="agent"
      editingMessageId={null}
      editDraft=""
      approvalBusyIds={[]}
      showThinking={false}
      apiKeySwitchNotice={null}
      resumableRun={null}
      dismissedResumeRunId={null}
      formattedError={null}
      onCopy={onCopy}
      onStartEdit={callbacks.onStartEdit}
      onDraftChange={callbacks.onDraftChange}
      onSaveEdit={callbacks.onSaveEdit}
      onResendEdit={callbacks.onResendEdit}
      onCancelEdit={callbacks.onCancelEdit}
      onDelete={callbacks.onDelete}
      onFork={callbacks.onFork}
      onRegenerate={callbacks.onRegenerate}
      onToolApproval={callbacks.onToolApproval}
      onModeSwitchApproval={callbacks.onModeSwitchApproval}
      onResumeRun={callbacks.onResumeRun}
      onDismissResume={callbacks.onDismissResume}
      onSubmit={callbacks.onSubmit}
      onSetMode={callbacks.onSetMode}
    />
  );
}

beforeEach(() => {
  mergeRunWorktreeMock.mockReset();
  discardRunWorktreeMock.mockReset();
  fetchWithAuthMock.mockReset();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
  // jsdom lacks ResizeObserver — Radix tooltip content (the Hint-wrapped
  // Open-folder button) needs it once mounted.
  if (typeof window.ResizeObserver === "undefined") {
    class ResizeObserverStub {
      observe() { return undefined; }
      unobserve() { return undefined; }
      disconnect() { return undefined; }
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: ResizeObserverStub
    });
  }
});

describe("WorktreeBanner", () => {
  it("renders for the newest message with worktree metadata", () => {
    render(<Harness withWorktree />);
    expect(screen.getByTestId("worktree-banner")).toBeInTheDocument();
    expect(screen.getByText("rapa/run-abc12345")).toBeInTheDocument();
    expect(screen.getByTestId("worktree-merge")).toBeInTheDocument();
    expect(screen.getByTestId("worktree-discard")).toBeInTheDocument();
    // workspaceId present → reveal-based Open folder button.
    expect(screen.getByTestId("worktree-open")).toBeInTheDocument();
  });

  it("does not render without worktree metadata", () => {
    render(<Harness withWorktree={false} />);
    expect(screen.queryByTestId("worktree-banner")).not.toBeInTheDocument();
  });

  it("merge success toasts, reports, and dismisses the banner", async () => {
    const user = userEvent.setup();
    mergeRunWorktreeMock.mockResolvedValue({ ok: true, message: "Merged rapa/run-abc12345 into the workspace" });

    render(<Harness withWorktree />);
    await user.click(screen.getByTestId("worktree-merge"));

    await waitFor(() => {
      expect(mergeRunWorktreeMock).toHaveBeenCalledWith("run-xyz");
    });
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith("Merged rapa/run-abc12345 into the workspace");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("worktree-banner")).not.toBeInTheDocument();
    });
  });

  it("merge refusal toasts the server message and keeps the banner", async () => {
    const user = userEvent.setup();
    mergeRunWorktreeMock.mockResolvedValue({ ok: false, message: "original checkout has uncommitted changes — commit or stash first" });

    render(<Harness withWorktree />);
    await user.click(screen.getByTestId("worktree-merge"));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("original checkout has uncommitted changes — commit or stash first");
    });
    expect(screen.getByTestId("worktree-banner")).toBeInTheDocument();
  });

  it("discard confirms, calls the endpoint, and dismisses", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    discardRunWorktreeMock.mockResolvedValue({ ok: true, message: "Discarded worktree rapa/run-abc12345" });

    render(<Harness withWorktree />);
    await user.click(screen.getByTestId("worktree-discard"));

    await waitFor(() => {
      expect(discardRunWorktreeMock).toHaveBeenCalledWith("run-xyz");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("worktree-banner")).not.toBeInTheDocument();
    });
    confirmSpy.mockRestore();
  });

  it("discard cancelled by the user never calls the endpoint", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<Harness withWorktree />);
    await user.click(screen.getByTestId("worktree-discard"));

    expect(discardRunWorktreeMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("worktree-banner")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("open folder reveals the worktree path relative to the workspace", async () => {
    const user = userEvent.setup();
    fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });

    render(<Harness withWorktree />);
    await user.click(screen.getByTestId("worktree-open"));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        "/workspaces/ws-1/reveal",
        expect.objectContaining({ method: "POST" })
      );
    });
    const body = JSON.parse((fetchWithAuthMock.mock.calls[0][1] as { body: string }).body);
    expect(body.path).toBe(".rapa/worktrees/run-abc12345");
  });
});
