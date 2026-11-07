import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AgentStepsViewer, ApprovalCard } from "../agent-steps-viewer";
import type { AgentLiveToolCall } from "../../../lib/agent-api";

function approvalCall(
  id: string,
  approvalId: string,
  risk?: { severity: string; summary: string[] }
): AgentLiveToolCall {
  return {
    iteration: 1,
    status: "requires_approval",
    call: { id, name: "execute_command", parameters: { command: "rm -rf build" } },
    result: {
      success: false,
      data: {
        requiresApproval: true,
        approvalId,
        ...(risk ? { risk } : {}),
      },
    },
  };
}

describe("AgentStepsViewer approval UX", () => {
  it("shows a sticky stacked-approval chip when 2+ approvals are pending", () => {
    const onToolApproval = vi.fn();
    render(
      <AgentStepsViewer
        steps={[]}
        liveToolCalls={[
          approvalCall("c1", "appr-1"),
          approvalCall("c2", "appr-2"),
        ]}
        isAgentActive={true}
        onToolApproval={onToolApproval}
      />
    );

    const chip = screen.getByText("2 awaiting approval");
    expect(chip).toBeInTheDocument();
    expect(chip.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
  });

  it("does not show the stacked chip for a single pending approval", () => {
    render(
      <AgentStepsViewer
        steps={[]}
        liveToolCalls={[approvalCall("c1", "appr-1")]}
        isAgentActive={true}
        onToolApproval={vi.fn()}
      />
    );

    expect(screen.queryByText(/awaiting approval/)).not.toBeInTheDocument();
    // The shared approval card rendered with its decision buttons.
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("renders the risk severity badge and summary lines on the approval card", () => {
    render(
      <AgentStepsViewer
        steps={[]}
        liveToolCalls={[
          approvalCall("c1", "appr-1", { severity: "high", summary: ["matches pattern: rm -rf", "destructive deletion"] }),
        ]}
        isAgentActive={true}
        onToolApproval={vi.fn()}
      />
    );

    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("matches pattern: rm -rf")).toBeInTheDocument();
    expect(screen.getByText("destructive deletion")).toBeInTheDocument();
    expect(screen.getByText(/^always allow this command \(prefix match\)$/i)).toBeInTheDocument();
  });

  it("submits approve/reject decisions through the shared approval card", async () => {
    const user = userEvent.setup();
    const onToolApproval = vi.fn();
    render(
      <AgentStepsViewer
        steps={[]}
        liveToolCalls={[approvalCall("c1", "appr-1")]}
        isAgentActive={true}
        onToolApproval={onToolApproval}
      />
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(onToolApproval).toHaveBeenCalledWith("appr-1", true);

    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(onToolApproval).toHaveBeenCalledWith("appr-1", false);
  });
});

describe("ApprovalCard (standalone anatomy used by PendingApprovalsCard)", () => {
  it("renders command preview and forwards the decision", async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    render(
      <ApprovalCard
        toolName="execute_command"
        command="npm run build"
        approvalId="appr-9"
        risk={{ severity: "medium", summary: ["build command"] }}
        onDecision={onDecision}
      />
    );

    expect(screen.getByText("execute_command")).toBeInTheDocument();
    expect(screen.getByText("npm run build")).toBeInTheDocument();
    expect(screen.getByText("medium")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(onDecision).toHaveBeenCalledWith("appr-9", true);
  });
});
