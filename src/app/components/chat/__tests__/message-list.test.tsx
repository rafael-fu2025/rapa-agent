import { useCallback, useMemo, useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MessageList } from "../message-list";
import type { ChatMessage } from "../../../types/chat";

const assistantMarkdownRenderSpy = vi.hoisted(() => vi.fn());

vi.mock("../../assistant-markdown", () => ({
  AssistantMarkdown: ({ content }: { content: string }) => {
    assistantMarkdownRenderSpy(content);
    return <div>{content}</div>;
  },
}));

vi.mock("../../interactive-options", () => ({
  InteractiveOptions: () => null,
}));

vi.mock("../../mode-switch-prompt", () => ({
  ModeSwitchPrompt: () => null,
}));

// The real ApprovalCard lives in agent-steps-viewer (lazily imported).
// The full anatomy is covered in agent-steps-viewer.test.tsx — here we
// only assert the reuse wiring inside PendingApprovalsCard.
vi.mock("../../agent-steps-viewer", () => ({
  AgentStepsViewer: () => null,
  ApprovalCard: (props: {
    toolName: string;
    approvalId: string;
    onDecision: (approvalId: string, approved: boolean) => void;
  }) => (
    <div data-testid="approval-card-stub" data-approval-id={props.approvalId}>
      <span>{props.toolName}</span>
      <button type="button" onClick={() => props.onDecision(props.approvalId, true)}>Approve</button>
      <button type="button" onClick={() => props.onDecision(props.approvalId, false)}>Reject</button>
    </div>
  ),
}));

vi.mock("../../agent-run-panel", () => ({
  AgentRunPanel: () => null,
}));

const MESSAGES: ChatMessage[] = [
  {
    id: "user-1",
    role: "user",
    content: "Summarize this conversation",
    mode: "chat",
  },
  {
    id: "assistant-1",
    role: "assistant",
    content: "Here is the summary.",
    mode: "chat",
    stats: {
      tokensPerSec: 42,
      totalTokens: 128,
    },
  },
];

function Harness() {
  const [counter, setCounter] = useState(0);

  const onCopy = useCallback(() => {}, []);
  const onStartEdit = useCallback(() => {}, []);
  const onDraftChange = useCallback(() => {}, []);
  const onSaveEdit = useCallback(() => {}, []);
  const onResendEdit = useCallback(() => {}, []);
  const onCancelEdit = useCallback(() => {}, []);
  const onDelete = useCallback(() => {}, []);
  const onFork = useCallback(() => {}, []);
  const onRegenerate = useCallback(() => {}, []);
  const onToolApproval = useCallback(() => {}, []);
  const onModeSwitchApproval = useCallback(() => {}, []);
  const onResumeRun = useCallback(() => {}, []);
  const onDismissResume = useCallback(() => {}, []);
  const onSubmit = useCallback(() => {}, []);
  const onSetMode = useCallback(() => {}, []);

  const messages = useMemo(() => MESSAGES, []);
  const approvalBusyIds = useMemo<string[]>(() => [], []);

  return (
    <div>
      <button type="button" onClick={() => setCounter((value) => value + 1)}>
        Tick {counter}
      </button>
      <MessageList
        messages={messages}
        pending={false}
        reconnecting={null}
        mode="chat"
        editingMessageId={null}
        editDraft=""
        approvalBusyIds={approvalBusyIds}
        showThinking={false}
        workspaceName={undefined}
        workspacePath={undefined}
        apiKeySwitchNotice={null}
        resumableRun={null}
        dismissedResumeRunId={null}
        formattedError={null}
        onCopy={onCopy}
        onStartEdit={onStartEdit}
        onDraftChange={onDraftChange}
        onSaveEdit={onSaveEdit}
        onResendEdit={onResendEdit}
        onCancelEdit={onCancelEdit}
        onDelete={onDelete}
        onFork={onFork}
        onRegenerate={onRegenerate}
        onToolApproval={onToolApproval}
        onModeSwitchApproval={onModeSwitchApproval}
        onResumeRun={onResumeRun}
        onDismissResume={onDismissResume}
        onSubmit={onSubmit}
        onSetMode={onSetMode}
      />
    </div>
  );
}

describe("MessageList", () => {
  it("does not rerender for unrelated parent updates when props stay the same", async () => {
    const user = userEvent.setup();
    assistantMarkdownRenderSpy.mockClear();

    render(<Harness />);

    expect(screen.getByText("Here is the summary.")).toBeInTheDocument();
    expect(assistantMarkdownRenderSpy).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /tick 0/i }));

    expect(assistantMarkdownRenderSpy).toHaveBeenCalledTimes(1);
  }, 20000);

  it("renders a trailing spacer when a bottom gap is requested", () => {
    render(
      <MessageList
        messages={MESSAGES}
        pending={false}
        reconnecting={null}
        mode="chat"
        editingMessageId={null}
        editDraft=""
        approvalBusyIds={[]}
        showThinking={false}
        workspaceName={undefined}
        workspacePath={undefined}
        apiKeySwitchNotice={null}
        resumableRun={null}
        dismissedResumeRunId={null}
        formattedError={null}
        bottomGap={72}
        onCopy={() => {}}
        onStartEdit={() => {}}
        onDraftChange={() => {}}
        onSaveEdit={() => {}}
        onResendEdit={() => {}}
        onCancelEdit={() => {}}
        onDelete={() => {}}
        onFork={() => {}}
        onRegenerate={() => {}}
        onToolApproval={() => {}}
        onModeSwitchApproval={() => {}}
        onResumeRun={() => {}}
        onDismissResume={() => {}}
        onSubmit={() => {}}
        onSetMode={() => {}}
      />
    );

    expect(screen.getByTestId("message-list-bottom-gap")).toHaveStyle({ height: "72px" });
  });
});

/* ---------- Helpers for the trust & transparency tests ---------- */

function renderList(messages: ChatMessage[], overrides: Partial<Parameters<typeof MessageList>[0]> = {}) {
  return render(
    <MessageList
      messages={messages}
      pending={false}
      reconnecting={null}
      mode="agent"
      editingMessageId={null}
      editDraft=""
      approvalBusyIds={[]}
      showThinking={false}
      workspaceName={undefined}
      workspacePath={undefined}
      apiKeySwitchNotice={null}
      resumableRun={null}
      dismissedResumeRunId={null}
      formattedError={null}
      onCopy={() => {}}
      onStartEdit={() => {}}
      onDraftChange={() => {}}
      onSaveEdit={() => {}}
      onResendEdit={() => {}}
      onCancelEdit={() => {}}
      onDelete={() => {}}
      onFork={() => {}}
      onRegenerate={() => {}}
      onToolApproval={() => {}}
      onModeSwitchApproval={() => {}}
      onResumeRun={() => {}}
      onDismissResume={() => {}}
      onSubmit={() => {}}
      onSetMode={() => {}}
      {...overrides}
    />
  );
}

describe("MessageList run receipt card", () => {
  it("renders run telemetry for agent messages that carry receipt stats", () => {
    renderList([
      { id: "u-1", role: "user", content: "build it", mode: "agent" },
      {
        id: "a-1",
        role: "assistant",
        content: "done",
        mode: "agent",
        stats: {
          tokensPerSec: 12.5,
          totalTokens: 320,
          elapsedMs: 65000,
          iterations: 3,
          costUsd: 0.05,
          status: "completed",
          verification: { testsPassed: true, typecheckPassed: false },
        },
      },
    ]);

    const receipt = screen.getByTestId("run-receipt-card");
    expect(receipt).toHaveTextContent("run receipt");
    expect(receipt).toHaveTextContent("completed");
    expect(receipt).toHaveTextContent("3 iterations");
    expect(receipt).toHaveTextContent("$0.050");
    expect(screen.getByTestId("receipt-tests")).toHaveTextContent("tests ✓");
    expect(screen.getByTestId("receipt-typecheck")).toHaveTextContent("typecheck ✗");
  });

  it("shows em-dash verification chips when the gate did not run", () => {
    renderList([
      { id: "u-1", role: "user", content: "build it", mode: "agent" },
      {
        id: "a-1",
        role: "assistant",
        content: "done",
        mode: "agent",
        stats: {
          tokensPerSec: 12.5,
          totalTokens: 320,
          iterations: 2,
          verification: null,
        },
      },
    ]);

    expect(screen.getByTestId("run-receipt-card")).toBeInTheDocument();
    expect(screen.getByTestId("receipt-tests")).toHaveTextContent("tests —");
    expect(screen.getByTestId("receipt-typecheck")).toHaveTextContent("typecheck —");
  });

  it("does not render a receipt for chat messages without run telemetry", () => {
    renderList(MESSAGES, { mode: "chat" });
    expect(screen.queryByTestId("run-receipt-card")).not.toBeInTheDocument();
  });
});

describe("MessageList queued prompt send-now", () => {
  it("renders a Send now button when the handler is provided", async () => {
    const user = userEvent.setup();
    const onSendQueuedNow = vi.fn();
    renderList(MESSAGES, { pending: true, queuedPrompt: "follow up", onSendQueuedNow });

    await user.click(screen.getByTestId("send-queued-now"));
    expect(onSendQueuedNow).toHaveBeenCalledTimes(1);
  });

  it("does not render the Send now button without the handler (routes wiring pending)", () => {
    renderList(MESSAGES, { pending: true, queuedPrompt: "follow up" });
    expect(screen.queryByTestId("send-queued-now")).not.toBeInTheDocument();
    expect(screen.getByText("follow up")).toBeInTheDocument();
  });
});

describe("MessageList pending approvals reuse", () => {
  it("renders rehydrated approvals through the shared ApprovalCard", async () => {
    const user = userEvent.setup();
    const onToolApproval = vi.fn();
    renderList(MESSAGES, {
      pendingApprovals: [
        { approvalId: "appr-1", conversationId: "c1", toolName: "execute_command", command: "npm test", createdAt: Date.now() },
      ],
      onToolApproval,
    });

    const card = await screen.findByTestId("approval-card-stub");
    expect(card).toHaveTextContent("execute_command");
    expect(card).toHaveAttribute("data-approval-id", "appr-1");
    await user.click(within(card).getByRole("button", { name: "Approve" }));
    expect(onToolApproval).toHaveBeenCalledWith("appr-1", true);
  });
});
