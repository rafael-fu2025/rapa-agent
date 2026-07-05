// Theme management (light / dark / system).
//
// The theme is applied to <html> via the `.dark` class so that the
// existing Tailwind v4 dark variant (`@custom-variant dark (&:is(.dark *))`)
// in styles/theme.css takes over automatically.
//
// Persistence: localStorage key `rapa_theme` with values `light` | `dark`
// | `system`. The inline script in index.html also reads the same key on
// first paint to prevent a flash of the wrong theme.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemeMode = "light" | "dark" | "system";

export type ResolvedTheme = "light" | "dark";

export type ThemeContextValue = {
  /** The user's explicit preference. */
  mode: ThemeMode;
  /** The actual theme being shown right now (after resolving "system"). */
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
};

const STORAGE_KEY = "rapa_theme";
const DARK_CLASS = "dark";

function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // localStorage may be unavailable (private mode, etc.) — fall through.
  }
  return "dark";
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveMode(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (resolved === "dark") {
    root.classList.add(DARK_CLASS);
  } else {
    root.classList.remove(DARK_CLASS);
  }
  // Sync the meta theme-color so the browser chrome (mobile, PWA install)
  // matches. Light = a soft off-white, dark = the existing near-black.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", resolved === "dark" ? "#0C0C0C" : "#FAFAFA");
  }
  root.style.colorScheme = resolved;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Initial state reads from the DOM, which the inline index.html script
  // has already populated, so SSR/CSR mismatch is impossible.
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (typeof document === "undefined") return "dark";
    return document.documentElement.classList.contains(DARK_CLASS) ? "dark" : "light";
  });
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());

  const resolved: ResolvedTheme = useMemo(() => {
    if (mode === "system") return systemDark ? "dark" : "light";
    return mode;
  }, [mode, systemDark]);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    // `addEventListener` is the modern API; Safari < 14 needs `addListener`.
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else mq.addListener(handler as unknown as (this: MediaQueryList, ev: MediaQueryListEvent) => void);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handler);
      else mq.removeListener(handler as unknown as (this: MediaQueryList, ev: MediaQueryListEvent) => void);
    };
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore quota / private-mode errors
    }
  }, []);

  const toggle = useCallback(() => {
    setMode(resolved === "dark" ? "light" : "dark");
  }, [resolved, setMode]);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode, toggle }),
    [mode, resolved, setMode, toggle]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Fall back to a sensible default if the provider is missing (e.g. in
    // tests or Storybook). Better than throwing on every consumer render.
    return {
      mode: "dark",
      resolved: "dark",
      setMode: () => undefined,
      toggle: () => undefined
    };
  }
  return ctx;
}

/** Imperative helper for the inline boot script in index.html. */
export const __themeBootHelpers = {
  STORAGE_KEY,
  DARK_CLASS,
  resolveMode,
  applyTheme
};
