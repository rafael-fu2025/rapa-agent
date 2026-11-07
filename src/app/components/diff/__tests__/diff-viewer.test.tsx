import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiffViewer } from "../diff-viewer";
import type { DiffEntry } from "../diff-hunks";

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

const STORAGE_KEY = "rapa.diffViewerTest";

// Two changes far apart in the same file → 2 hunks.
const TWO_HUNK_BEFORE = `${Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n")}\n`;
const twoHunkAfter = (() => {
  const lines = TWO_HUNK_BEFORE.trimEnd().split("\n");
  lines[3] = "CHANGED-EARLY";
  lines[20] = "CHANGED-LATE";
  return `${lines.join("\n")}\n`;
})();

const entries: DiffEntry[] = [
  { id: "1", path: "src/a.ts", before: "a\nb\nc\n", after: "a\nX\nc\n" },
  { id: "2", path: "src/b.ts", before: "one\ntwo\n", after: "one\ntwo\nthree\n" }
];

function seenCheckbox(path: string) {
  return screen.getByRole("checkbox", { name: `Mark ${path} seen` });
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { value: makeLocalStorage(), configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(window, "localStorage");
});

describe("DiffViewer", () => {
  it("shows the friendly empty state when there are no entries", () => {
    render(<DiffViewer entries={[]} storageKey={STORAGE_KEY} />);
    expect(screen.getByText("No file changes in this run")).toBeInTheDocument();
  });

  it("renders the file list with stats and switches files on click", () => {
    render(<DiffViewer entries={entries} storageKey={STORAGE_KEY} />);

    // File list with per-file +/- stats (first file: 1 add, 1 del).
    expect(screen.getByRole("button", { name: "Select src/a.ts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select src/b.ts" })).toBeInTheDocument();
    expect(screen.getByText("+1 −1")).toBeInTheDocument();
    expect(screen.getByText("+1 −0")).toBeInTheDocument();

    // Right pane starts on the first file; clicking the second switches.
    expect(screen.queryByText("three")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select src/b.ts" }));
    expect(screen.getByText("three")).toBeInTheDocument();
  });

  it("navigates hunks with prev/next buttons and a counter", () => {
    render(
      <DiffViewer
        entries={[{ id: "1", path: "big.ts", before: TWO_HUNK_BEFORE, after: twoHunkAfter }]}
        storageKey={STORAGE_KEY}
      />
    );

    expect(screen.getByText("1/2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next hunk" }));
    expect(screen.getByText("2/2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next hunk" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous hunk" }));
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("persists seen state and un-seens a file whose content changed", () => {
    const { rerender } = render(<DiffViewer entries={entries} storageKey={STORAGE_KEY} />);

    expect(seenCheckbox("src/a.ts")).toHaveAttribute("aria-checked", "false");
    fireEvent.click(seenCheckbox("src/a.ts"));
    expect(seenCheckbox("src/a.ts")).toHaveAttribute("aria-checked", "true");

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, string>;
    expect(Object.keys(stored)).toContain("src/a.ts");
    const seenHash = stored["src/a.ts"];
    expect(seenHash).toBeTruthy();

    // Same content on rerender → still seen.
    rerender(<DiffViewer entries={entries} storageKey={STORAGE_KEY} />);
    expect(seenCheckbox("src/a.ts")).toHaveAttribute("aria-checked", "true");

    // Content changed → stored hash no longer matches → un-seen.
    const changed: DiffEntry[] = [{ ...entries[0], after: "a\nY\nc\n" }, entries[1]];
    rerender(<DiffViewer entries={changed} storageKey={STORAGE_KEY} />);
    expect(seenCheckbox("src/a.ts")).toHaveAttribute("aria-checked", "false");

    // Re-checking stores the new hash.
    fireEvent.click(seenCheckbox("src/a.ts"));
    const storedAfter = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, string>;
    expect(storedAfter["src/a.ts"]).not.toBe(seenHash);
  });

  it("offers mark-all-seen when more than one file is present", () => {
    render(<DiffViewer entries={entries} storageKey={STORAGE_KEY} />);

    fireEvent.click(screen.getByRole("button", { name: "Mark all seen" }));
    expect(seenCheckbox("src/a.ts")).toHaveAttribute("aria-checked", "true");
    expect(seenCheckbox("src/b.ts")).toHaveAttribute("aria-checked", "true");

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, string>;
    expect(Object.keys(stored)).toHaveLength(2);
  });

  it("renders the raw preview fallback instead of fabricating hunks", () => {
    render(
      <DiffViewer
        entries={[{ id: "cp", path: "src/a.ts", before: "", after: "", rawPreview: "diff --git a/src/a.ts" }]}
        storageKey={STORAGE_KEY}
      />
    );

    expect(screen.getByText("raw preview")).toBeInTheDocument();
    expect(screen.getByText(/diff --git a\/src\/a\.ts/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next hunk" })).not.toBeInTheDocument();
  });

  it("supports the color tone (green/red tints) for dialog usage", () => {
    render(<DiffViewer entries={[entries[0]]} storageKey={STORAGE_KEY} tone="color" />);

    const addedRow = screen.getByText("X").closest("div");
    expect(addedRow?.className).toContain("text-accent-green");
    const removedRow = screen.getByText("b").closest("div");
    expect(removedRow?.className).toContain("text-accent-red");
  });
});
