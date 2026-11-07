import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AssistantMarkdown } from "../assistant-markdown";

// Stub the lazily-loaded MermaidBlock so the routing test does not pull
// the real mermaid library into jsdom.
vi.mock("../markdown/mermaid-block", () => ({
  MermaidBlock: ({ code, theme }: { code: string; theme: string }) => (
    <div data-testid="mermaid-block-stub" data-theme={theme}>
      {code}
    </div>
  ),
}));

describe("AssistantMarkdown mermaid routing", () => {
  it("routes fenced mermaid blocks to the lazy MermaidBlock with the resolved theme", async () => {
    render(<AssistantMarkdown content={"```mermaid\ngraph TD; A-->B;\n```"} />);

    const stub = await screen.findByTestId("mermaid-block-stub");
    expect(stub).toHaveTextContent("graph TD; A-->B;");
    // useTheme falls back to "dark" without a provider.
    expect(stub).toHaveAttribute("data-theme", "dark");
  });

  it("routes other fenced code to the regular code block, not MermaidBlock", () => {
    render(<AssistantMarkdown content={"```ts\nconst x = 1;\n```"} />);

    expect(screen.queryByTestId("mermaid-block-stub")).not.toBeInTheDocument();
    expect(screen.getByText(/const x = 1;/)).toBeInTheDocument();
  });
});
