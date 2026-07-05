import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Sidebar } from "../sidebar";

vi.mock("react-router", () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: () => ({
    pathname: "/",
    search: "",
  }),
  useNavigate: () => vi.fn(),
}));

vi.mock("../../hooks/use-auth", () => ({
  useAuth: () => ({
    logout: vi.fn(),
  }),
}));

vi.mock("../../hooks/use-theme", () => ({
  useTheme: () => ({
    resolved: "dark",
    toggle: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../../../lib/api", () => ({
  getConversations: vi.fn(async () => ({
    items: [
      {
        id: "conv-1",
        title: "Example conversation",
        updatedAt: "2026-06-17T00:00:00.000Z",
        workspaceId: null,
        workspace: null,
        _count: {
          messages: 3,
        },
      },
    ],
    nextCursor: undefined,
  })),
  getProviders: vi.fn(async () => ({ providers: [] })),
  deleteConversation: vi.fn(async () => ({ ok: true })),
  deleteAllConversations: vi.fn(async () => ({ ok: true })),
  renameConversation: vi.fn(async () => ({ ok: true, title: "Renamed" })),
}));

vi.mock("../../../lib/workspace-api", () => ({
  listWorkspaces: vi.fn(async () => []),
  setActiveWorkspace: vi.fn(async () => undefined),
  createWorkspace: vi.fn(async () => undefined),
  pickWorkspaceFolder: vi.fn(async () => ({ path: null, name: null, cancelled: true })),
  deleteWorkspace: vi.fn(async () => undefined),
  getWorkspaceRegistry: vi.fn(async () => ({
    items: [],
    totals: {
      workspaces: 0,
      runningAgents: 0,
      pendingApprovals: 0,
    },
    staleRunThresholdMs: 0,
  })),
}));

describe("Sidebar", () => {
  it("renders the conversation list inside the shared custom scroll area", async () => {
    render(<Sidebar />);

    const historyHeading = screen.getByText("History");
    const scrollHost = historyHeading.parentElement?.nextElementSibling;

    await waitFor(() => {
      expect(scrollHost).toHaveClass("sidebar-scroll");
      expect(scrollHost).toHaveClass("flex-1");
      expect(scrollHost).toHaveClass("min-h-0");
    });
  });

  it("reserves room for the thicker scrollbar so conversation actions stay visible", async () => {
    render(<Sidebar />);

    const historyHeading = screen.getByText("History");
    const scrollHost = historyHeading.parentElement?.nextElementSibling;
    const conversationLink = await screen.findByRole("link", { name: /example conversation/i });
    const title = screen.getByText("Example conversation");
    const actionButton = screen.getByLabelText("Actions for Example conversation");
    const contentWrapper = conversationLink.closest(".pl-2");

    expect(scrollHost).toHaveClass("sidebar-scroll");
    expect(scrollHost).toHaveClass("overflow-y-auto");
    expect(title).toHaveClass("min-w-0");
    expect(title).toHaveClass("flex-1");
    expect(title).toHaveClass("truncate");
    expect(actionButton).toHaveClass("shrink-0");
    expect(actionButton).not.toHaveClass("absolute");
  });
});
