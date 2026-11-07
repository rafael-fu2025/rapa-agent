// Agent Settings — Item 3 isolation sections (sandbox / classifier /
// worktree) persist through the localStorage-backed agent-settings store.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSettingsPage } from "../agent-settings-page";
import { readAgentSettings } from "../../../lib/agent-settings";

// The existing panels hit the network (auto-approve patterns) and cover
// their own behavior elsewhere — stub them to isolate the new sections.
vi.mock("../agent-settings-panel", () => ({
  AgentSettingsPanel: () => <div data-testid="agent-settings-panel-stub" />,
}));
vi.mock("../auto-approve-patterns-section", () => ({
  AutoApprovePatternsSection: () => <div data-testid="auto-approve-stub" />,
}));

function localStorageKey(key: string): string | null {
  return window.localStorage.getItem(key);
}

/**
 * This environment's Node flag (--localstorage-file) leaves jsdom's
 * window.localStorage as a method-less stub — swap in a minimal in-memory
 * Storage so the persistence assertions can run.
 */
function installLocalStorageStub() {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      return {
        getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
        setItem: (key: string, value: string) => { store.set(key, String(value)); },
        removeItem: (key: string) => { store.delete(key); },
        clear: () => store.clear(),
        key: (index: number) => Array.from(store.keys())[index] ?? null,
        get length() { return store.size; }
      };
    }
  });
  return {
    seed(key: string, value: string) { store.set(key, value); }
  };
}

const AGENT_SETTING_KEYS = [
  "rapa.agent.maxIterations",
  "rapa.agent.autoApproveCategories",
  "rapa.agent.showThinking",
  "rapa.agent.sandbox",
  "rapa.agent.classifier",
  "rapa.agent.worktree",
];

let storage: ReturnType<typeof installLocalStorageStub>;

beforeEach(() => {
  storage = installLocalStorageStub();
  // jsdom's localStorage here lacks clear(); remove the known keys instead.
  for (const key of AGENT_SETTING_KEYS) {
    window.localStorage.removeItem(key);
  }
});

describe("AgentSettingsPage — isolation sections (Item 3)", () => {
  it("renders the three isolation sections", () => {
    render(<AgentSettingsPage />);
    expect(screen.getByText("Command Sandbox")).toBeInTheDocument();
    expect(screen.getByText("Auto-Approve Classifier")).toBeInTheDocument();
    expect(screen.getByText("Isolate Runs in a Git Worktree")).toBeInTheDocument();
  });

  it("persists the sandbox radio choice to rapa.agent.sandbox", async () => {
    const user = userEvent.setup();
    render(<AgentSettingsPage />);

    await user.click(screen.getByRole("radio", { name: /docker/i }));

    await waitFor(() => {
      expect(localStorageKey("rapa.agent.sandbox")).toBe("docker");
    });
    expect(readAgentSettings().sandboxMode).toBe("docker");
  });

  it("persists the worktree toggle to rapa.agent.worktree", async () => {
    const user = userEvent.setup();
    render(<AgentSettingsPage />);

    await user.click(screen.getByTestId("worktree-toggle"));

    await waitFor(() => {
      expect(localStorageKey("rapa.agent.worktree")).toBe("true");
    });
    expect(readAgentSettings().worktree).toBe(true);

    // And back off.
    await user.click(screen.getByTestId("worktree-toggle"));
    await waitFor(() => {
      expect(localStorageKey("rapa.agent.worktree")).toBe("false");
    });
  });

  it("persists the classifier toggle and free-text provider/model", async () => {
    const user = userEvent.setup();
    render(<AgentSettingsPage />);

    await user.click(screen.getByTestId("classifier-toggle"));
    await waitFor(() => {
      expect(JSON.parse(localStorageKey("rapa.agent.classifier") ?? "{}")).toMatchObject({ enabled: true });
    });

    // Enabling reveals the optional provider/model inputs.
    const providerInput = screen.getByTestId("classifier-provider");
    await user.type(providerInput, "openai");
    const modelInput = screen.getByTestId("classifier-model");
    await user.type(modelInput, "gpt-5-mini");

    await waitFor(() => {
      expect(readAgentSettings().autoApproveClassifier).toEqual({
        enabled: true,
        provider: "openai",
        model: "gpt-5-mini",
      });
    });
  });

  it("clears classifier provider/model when the text is emptied", async () => {
    storage.seed(
      "rapa.agent.classifier",
      JSON.stringify({ enabled: true, provider: "openai", model: "gpt-5-mini" })
    );
    const user = userEvent.setup();
    render(<AgentSettingsPage />);

    const modelInput = screen.getByTestId("classifier-model") as HTMLInputElement;
    expect(modelInput.value).toBe("gpt-5-mini");
    await user.clear(modelInput);

    await waitFor(() => {
      const stored = readAgentSettings().autoApproveClassifier;
      expect(stored.enabled).toBe(true);
      expect(stored.model).toBeUndefined();
    });
  });
});
