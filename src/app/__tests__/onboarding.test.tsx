import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Home } from "../routes";

// Sidebar pulls the auth context and conversation fetches that are
// irrelevant here — stub it so Home renders in isolation.
vi.mock("../components/sidebar", () => ({
  Sidebar: () => <aside data-testid="sidebar-stub" />
}));

// This jsdom setup does not expose a working localStorage global (same
// workaround as src/lib/__tests__/http.test.ts) — replace it on the
// jsdom window itself, which is where the app reads it.
function makeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    }
  };
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Home />
    </MemoryRouter>
  );
}

beforeEach(() => {
  // Cover both resolution paths: bare `localStorage` refs (globalThis)
  // and `window.localStorage` refs (jsdom window object).
  const impl = makeLocalStorage();
  vi.stubGlobal("localStorage", impl);
  Object.defineProperty(window, "localStorage", { value: impl, configurable: true });
  // Home's auto-scroll and input-dock effects use browser APIs that
  // jsdom does not implement.
  Element.prototype.scrollTo = () => undefined;
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("empty-state onboarding", () => {
  it("shows the welcome panel with the three modes when rapa.onboarded is absent", async () => {
    renderHome();

    const header = await screen.findByText(/welcome to rapa/i);
    expect(header).toBeInTheDocument();
    expect(screen.getByText("How can I help you today?")).toBeInTheDocument();

    // Scope to the onboarding card — the top bar renders its own mode labels.
    const card = header.parentElement?.parentElement as HTMLElement;
    const scoped = within(card);
    expect(scoped.getByText("CHAT")).toBeInTheDocument();
    expect(scoped.getByText("AGENT")).toBeInTheDocument();
    expect(scoped.getByText("PLAN")).toBeInTheDocument();
    expect(scoped.getByText("direct LLM conversation")).toBeInTheDocument();
    expect(scoped.getByText("tool-using runs with approvals")).toBeInTheDocument();
    expect(scoped.getByText("read-only planning")).toBeInTheDocument();
  });

  it("hides the panel and persists the flag after clicking Got it", { timeout: 20000 }, async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /got it/i }));

    expect(screen.queryByText(/welcome to rapa/i)).not.toBeInTheDocument();
    expect(window.localStorage.getItem("rapa.onboarded")).toBe("1");
  });

  it("stays hidden once rapa.onboarded is set", async () => {
    window.localStorage.setItem("rapa.onboarded", "1");

    renderHome();

    expect(await screen.findByText("How can I help you today?")).toBeInTheDocument();
    expect(screen.queryByText(/welcome to rapa/i)).not.toBeInTheDocument();
  });
});
