// Runs panel — needs-input chip (registry parity) + the sidebar badge
// broadcast via the `rapa:runs-needs-input` CustomEvent.

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { RunsPanelContent } from "../runs-panel";
import type { AgentRunSummary } from "../../../lib/agent-api";

const listAgentRunsMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/agent-api", () => ({
  listAgentRuns: (...args: unknown[]) => listAgentRunsMock(...args),
}));

vi.mock("../agent-run-panel", () => ({
  AgentRunPanel: () => null,
}));

function makeRun(overrides: Partial<AgentRunSummary>): AgentRunSummary {
  return {
    id: "run-1",
    conversationId: "conv-1",
    status: "running",
    iterationCount: 3,
    startedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  listAgentRunsMock.mockReset();
  listAgentRunsMock.mockResolvedValue({ runs: [] });
});

describe("RunsPanelContent — needs-input chip", () => {
  it("shows the yellow input chip only on runs waiting for approval", async () => {
    listAgentRunsMock.mockResolvedValue({
      runs: [
        makeRun({ id: "run-blocked", status: "running", needsInput: true }),
        makeRun({ id: "run-free", status: "running", needsInput: false }),
      ],
    });

    render(<RunsPanelContent conversationId="conv-1" onCompare={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("run-needs-input")).toHaveLength(1);
    });
  });

  it("hides the chip when no run needs input", async () => {
    listAgentRunsMock.mockResolvedValue({
      runs: [makeRun({ id: "run-free", status: "completed", needsInput: false })],
    });

    render(<RunsPanelContent conversationId="conv-1" onCompare={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("completed")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("run-needs-input")).not.toBeInTheDocument();
  });

  it("broadcasts the needs-input count for the sidebar badge", async () => {
    const dispatched: number[] = [];
    const handler = (event: Event) => {
      dispatched.push((event as CustomEvent).detail?.count ?? -1);
    };
    window.addEventListener("rapa:runs-needs-input", handler);

    try {
      listAgentRunsMock.mockResolvedValue({
        runs: [
          makeRun({ id: "a", needsInput: true }),
          makeRun({ id: "b", needsInput: true }),
          makeRun({ id: "c", needsInput: false }),
        ],
      });
      render(<RunsPanelContent conversationId="conv-1" onCompare={vi.fn()} />);

      await waitFor(() => {
        expect(dispatched.some((count) => count === 2)).toBe(true);
      });
    } finally {
      window.removeEventListener("rapa:runs-needs-input", handler);
    }
  });
});
