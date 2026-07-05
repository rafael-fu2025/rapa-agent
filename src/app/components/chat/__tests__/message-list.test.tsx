import { useCallback, useMemo, useState } from "react";
import { render, screen } from "@testing-library/react";
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

vi.mock("../../agent-steps-viewer", () => ({
  AgentStepsViewer: () => null,
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
  });

  it("renders a trailing spacer when a bottom gap is requested", () => {
    render(
      <MessageList
        messages={MESSAGES}
        pending={false}
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
