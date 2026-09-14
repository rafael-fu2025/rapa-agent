// Tests for the profile-driven reasoning-effort picker in ModelSelector:
// options come from the backend /settings/reasoning-profile response
// (binary / standard / extended / hidden), and switching to a model that
// doesn't support the current effort snaps it down.

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { ModelSelector, __clearReasoningProfileCacheForTests } from "../model-selector";
import type { ReasoningEffort, ReasoningProfile } from "../../../lib/api";

const getReasoningProfileMock = vi.fn();

vi.mock("../../../lib/api", () => ({
  getSettings: vi.fn(async () => ({ models: ["model-a", "model-b"] })),
  getProviders: vi.fn(async () => ({ providers: [] })),
  getReasoningProfile: (...args: unknown[]) => getReasoningProfileMock(...args)
}));

vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>
  },
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}));

function profile(style: ReasoningProfile["style"], levels: ReasoningEffort[]): ReasoningProfile {
  return {
    provider: "test",
    model: "model-a",
    style,
    levels,
    source: "model-pattern"
  };
}

function renderSelector(effort: ReasoningEffort = "off", profileResponse: ReasoningProfile = profile("standard", ["off", "low", "medium", "high"])) {
  const onSelectReasoningEffort = vi.fn();
  getReasoningProfileMock.mockResolvedValue(profileResponse);

  const result = render(
    <ModelSelector
      selectedProvider="test"
      selectedModel="model-a"
      selectedReasoningEffort={effort}
      onSelectReasoningEffort={onSelectReasoningEffort}
    />
  );

  // Open the dropdown so the effort section renders.
  fireEvent.click(screen.getByRole("button", { name: /model-a/i }));
  return { onSelectReasoningEffort, ...result };
}

beforeEach(() => {
  getReasoningProfileMock.mockReset();
  __clearReasoningProfileCacheForTests();
});

describe("reasoning-effort picker (profile-driven)", () => {
  it("renders exactly the profile's levels for a standard model", async () => {
    renderSelector("medium", profile("standard", ["off", "low", "medium", "high"]));
    const effortButton = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}$`, "i") });
    await waitFor(() => expect(effortButton("Low")).toBeDefined());
    expect(effortButton("Medium")).toBeDefined();
    expect(effortButton("High")).toBeDefined();
    expect(effortButton("Default")).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Max$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^XHigh$/i })).toBeNull();
  });

  it("renders extended tiers when the profile has them", async () => {
    renderSelector("high", profile("extended", ["off", "low", "medium", "high", "xhigh"]));
    await waitFor(() => expect(screen.getByRole("button", { name: /^XHigh$/i })).toBeDefined());
    expect(screen.queryByRole("button", { name: /^Ultra$/i })).toBeNull();
  });

  it("renders binary models as Default + On", async () => {
    renderSelector("on", profile("binary", ["off", "on"]));
    await waitFor(() => expect(screen.getByRole("button", { name: /^On$/i })).toBeDefined());
    expect(screen.getByRole("button", { name: /^Default$/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Low$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^High$/i })).toBeNull();
  });

  it("hides the section entirely for style none", async () => {
    renderSelector("off", profile("none", []));
    // Wait for the profile fetch to resolve; the section must not appear.
    await waitFor(() => expect(getReasoningProfileMock).toHaveBeenCalled());
    expect(screen.queryByText("reasoning effort")).toBeNull();
    expect(screen.queryByText("Low")).toBeNull();
  });

  it("snaps an unsupported effort down to the nearest supported level", async () => {
    const { onSelectReasoningEffort } = renderSelector(
      "ultra",
      profile("standard", ["off", "low", "medium", "high"])
    );
    await waitFor(() =>
      expect(onSelectReasoningEffort).toHaveBeenCalledWith("high")
    );
  });

  it("keeps a supported effort unchanged (no snap callback)", async () => {
    const { onSelectReasoningEffort } = renderSelector(
      "medium",
      profile("standard", ["off", "low", "medium", "high"])
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /^Medium$/i })).toBeDefined());
    expect(onSelectReasoningEffort).not.toHaveBeenCalled();
  });
});
