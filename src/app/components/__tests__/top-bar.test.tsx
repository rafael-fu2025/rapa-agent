import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TopBar } from "../top-bar";

vi.mock("../../../lib/workspace-api", () => ({
  listWorkspaces: vi.fn(async () => []),
  getActiveWorkspace: vi.fn(async () => null),
}));

describe("TopBar", () => {
  it("uses the app surface so the header matches the chat background", () => {
    const { container } = render(<TopBar />);

    expect(container.firstElementChild).toHaveClass("bg-app");
  });
});
