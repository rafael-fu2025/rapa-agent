import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MermaidBlock } from "../mermaid-block";

// jsdom cannot run mermaid (no SVG geometry) — mock the library and drive
// the success / failure paths explicitly.
const mermaidState = vi.hoisted(() => ({
  renderImpl: vi.fn(async (_renderId: string, _code: string) => ({ svg: "<svg><text>ok</text></svg>" })),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: (id: string, code: string) => mermaidState.renderImpl(id, code),
  },
}));

describe("MermaidBlock", () => {
  beforeEach(() => {
    mermaidState.renderImpl.mockClear();
    mermaidState.renderImpl.mockImplementation(async () => ({ svg: "<svg><text>ok</text></svg>" }));
  });

  it("renders the svg produced by mermaid.render", async () => {
    render(<MermaidBlock code="graph TD; A-->B;" theme="dark" />);

    const diagram = await screen.findByTestId("mermaid-diagram");
    expect(diagram).toBeInTheDocument();
    expect(diagram.innerHTML).toContain("<svg");
    expect(screen.getByText("ok")).toBeInTheDocument();
    expect(screen.queryByTestId("mermaid-fallback")).not.toBeInTheDocument();
  });

  it("initializes mermaid lazily with the requested theme and strict security", async () => {
    const mermaid = (await import("mermaid")).default;

    render(<MermaidBlock code="graph TD; A-->B;" theme="light" />);

    await screen.findByTestId("mermaid-diagram");
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, theme: "default", securityLevel: "strict" })
    );
    expect(mermaidState.renderImpl).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-/), "graph TD; A-->B;");
  });

  it("falls back to the source view with a label when rendering fails", async () => {
    mermaidState.renderImpl.mockImplementation(async () => {
      throw new Error("parse error");
    });

    render(<MermaidBlock code="graph TD; broken -->;" theme="light" />);

    await waitFor(() => expect(screen.getByTestId("mermaid-fallback")).toBeInTheDocument());
    expect(screen.getByText("diagram failed to render")).toBeInTheDocument();
    expect(screen.getByText("graph TD; broken -->;")).toBeInTheDocument();
    expect(screen.queryByTestId("mermaid-diagram")).not.toBeInTheDocument();
  });
});
