// Tests for the plan→agent handoff button on completed Plan-mode messages.

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageList } from "../chat/message-list";
import type { ChatMessage } from "../../types/chat";

// Heavy children are irrelevant to this test — stub them out.
vi.mock("../agent-steps-viewer", () => ({
  AgentStepsViewer: () => null
}));
vi.mock("../assistant-markdown", () => ({
  AssistantMarkdown: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>
}));
vi.mock("../interactive-options", () => ({
  InteractiveOptions: () => null
}));
vi.mock("../mode-switch-prompt", () => ({
  ModeSwitchPrompt: () => null
}));

const planMessage: ChatMessage = {
  id: "m1",
  role: "assistant",
  mode: "plan",
  content: "# Implementation Plan\n\n1. Create the module\n2. Add tests"
};

function renderList(messages: ChatMessage[], pending = false) {
  const onSetMode = vi.fn();
  const onSubmit = vi.fn();
  render(
    <MessageList
      messages={messages}
      pending={pending}
      reconnecting={null}
      mode="plan"
      editingMessageId={null}
      editDraft=""
      approvalBusyIds={[]}
      showThinking={false}
      workspaceName="ws"
      workspacePath="/ws"
      apiKeySwitchNotice={null}
      resumableRun={null}
      dismissedResumeRunId={null}
      formattedError={null}
      bottomGap={0}
      onCopy={vi.fn()}
      onStartEdit={vi.fn()}
      onDraftChange={vi.fn()}
      onSaveEdit={vi.fn()}
      onResendEdit={vi.fn()}
      onCancelEdit={vi.fn()}
      onDelete={vi.fn()}
      onFork={vi.fn()}
      onRegenerate={vi.fn()}
      onToolApproval={vi.fn()}
      onModeSwitchApproval={vi.fn()}
      onResumeRun={vi.fn()}
      onDismissResume={vi.fn()}
      onSubmit={onSubmit}
      onSetMode={onSetMode}
    />
  );
  return { onSetMode, onSubmit };
}

describe("plan→agent handoff button", () => {
  it("renders on the latest completed plan message and submits the plan on click", () => {
    const { onSetMode, onSubmit } = renderList([planMessage]);

    const button = screen.getByRole("button", { name: /execute plan in agent mode/i });
    expect(button).toBeDefined();

    fireEvent.click(button);
    expect(onSetMode).toHaveBeenCalledWith("agent");
    expect(onSubmit).toHaveBeenCalledWith(
      expect.stringContaining("Execute the following plan from the previous Plan-mode run")
    );
    expect(onSubmit).toHaveBeenCalledWith(expect.stringContaining("# Implementation Plan"));
  });

  it("does not render on agent-mode messages or while a run is active", () => {
    const { rerender } = { rerender: null };
    void rerender;

    renderList([{ ...planMessage, mode: "agent" }]);
    expect(screen.queryByRole("button", { name: /execute plan in agent mode/i })).toBeNull();
  });

  it("does not render while the agent is active (pending)", () => {
    renderList([planMessage], true);
    expect(screen.queryByRole("button", { name: /execute plan in agent mode/i })).toBeNull();
  });

  it("does not render on older plan messages when a newer one exists", () => {
    renderList([
      planMessage,
      { id: "m2", role: "user", content: "thanks" }
    ]);
    // m1 is no longer the last message in the list.
    expect(screen.queryByRole("button", { name: /execute plan in agent mode/i })).toBeNull();
  });
});
