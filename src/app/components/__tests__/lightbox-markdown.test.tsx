import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AssistantMarkdown } from "../assistant-markdown";
import { LightboxProvider } from "../lightbox";

const MD_IMAGE = "![a cat photo](https://example.com/cat.png)";

describe("AssistantMarkdown image override", () => {
  it("renders markdown images with the zoom-in cursor inside the lightbox provider", () => {
    render(
      <LightboxProvider>
        <AssistantMarkdown content={MD_IMAGE} />
      </LightboxProvider>
    );

    const img = screen.getByAltText("a cat photo");
    expect(img).toHaveAttribute("src", "https://example.com/cat.png");
    expect(img.className).toContain("cursor-zoom-in");
    expect(img.className).toContain("border-border/40");
  });

  it("opens the lightbox overlay on click and closes on Escape", () => {
    render(
      <LightboxProvider>
        <AssistantMarkdown content={MD_IMAGE} />
      </LightboxProvider>
    );

    fireEvent.click(screen.getByAltText("a cat photo"));

    const dialog = screen.getByRole("dialog", { name: "a cat photo" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // The portal re-renders the same alt — the overlay image is the last match.
    const imgs = screen.getAllByAltText("a cat photo");
    const fullscreen = imgs[imgs.length - 1] as HTMLImageElement;
    expect(fullscreen.className).toContain("object-contain");

    // Zoom toggle: contain ↔ cover.
    fireEvent.click(fullscreen);
    const zoomed = screen.getAllByAltText("a cat photo");
    expect((zoomed[zoomed.length - 1] as HTMLImageElement).className).toContain("object-cover");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on backdrop click", () => {
    render(
      <LightboxProvider>
        <AssistantMarkdown content={MD_IMAGE} />
      </LightboxProvider>
    );

    fireEvent.click(screen.getByAltText("a cat photo"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not crash without a provider — images keep default behavior", () => {
    render(<AssistantMarkdown content={MD_IMAGE} />);

    const img = screen.getByAltText("a cat photo");
    expect(img).toBeInTheDocument();
    fireEvent.click(img);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not render an img element when the markdown image has no src", () => {
    render(
      <LightboxProvider>
        <AssistantMarkdown content={"![broken]() after"} />
      </LightboxProvider>
    );

    expect(screen.queryByAltText("broken")).not.toBeInTheDocument();
    expect(screen.getByText("after")).toBeInTheDocument();
  });
});
