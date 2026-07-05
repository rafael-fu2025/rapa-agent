import { useCallback, useEffect, useState } from "react";

export const DEFAULT_MAX_AGENT_ITERATIONS = 60;
export const MAX_AGENT_ITERATIONS = 80;
export const DEFAULT_AUTO_APPROVE_TOOLS = [
  "read_file",
  "list_directory",
  "search_files",
  "search_content",
  "think",
  "add_task",
  "update_task",
  "summarize_progress",
  "edit_file",
  "replace_in_file",
  "append_file",
  "write_file",
  "mkdir",
  "git_status",
  "git_diff",
  "git_log",
  "git_branch"
] as const;

export const MAX_ITERATIONS_STORAGE_KEY = "rapa.agent.maxIterations";
export const AUTO_APPROVE_STORAGE_KEY = "rapa.agent.autoApproveCategories";
export const SHOW_THINKING_STORAGE_KEY = "rapa.agent.showThinking";
const AGENT_SETTINGS_UPDATED_EVENT = "rapa:agent-settings-updated";

export type AgentSettings = {
  maxIterations: number;
  autoApproveCategories: string[];
  showThinking: boolean;
};

function readStoredNumber(key: string, fallback: number) {
  if (typeof window === "undefined") return fallback;

  const rawValue = window.localStorage.getItem(key);
  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_AGENT_ITERATIONS, Math.max(1, parsed));
}

function readStoredStringArray(key: string, fallback: string[]) {
  if (typeof window === "undefined") return fallback;

  try {
    const rawValue = window.localStorage.getItem(key);
    if (!rawValue) return fallback;
    const parsed = JSON.parse(rawValue) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : fallback;
  } catch {
    return fallback;
  }
}

function readStoredBoolean(key: string, fallback: boolean) {
  if (typeof window === "undefined") return fallback;

  const rawValue = window.localStorage.getItem(key);
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  return fallback;
}

export function readAgentSettings(): AgentSettings {
  return {
    maxIterations: readStoredNumber(MAX_ITERATIONS_STORAGE_KEY, DEFAULT_MAX_AGENT_ITERATIONS),
    autoApproveCategories: readStoredStringArray(AUTO_APPROVE_STORAGE_KEY, []),
    showThinking: readStoredBoolean(SHOW_THINKING_STORAGE_KEY, true)
  };
}

function persistAgentSettings(settings: AgentSettings) {
  if (typeof window === "undefined") return;

  window.localStorage.setItem(MAX_ITERATIONS_STORAGE_KEY, String(settings.maxIterations));
  window.localStorage.setItem(AUTO_APPROVE_STORAGE_KEY, JSON.stringify(settings.autoApproveCategories));
  window.localStorage.setItem(SHOW_THINKING_STORAGE_KEY, String(settings.showThinking));
  window.dispatchEvent(new Event(AGENT_SETTINGS_UPDATED_EVENT));
}

export function useAgentSettings() {
  const [settings, setSettingsState] = useState<AgentSettings>(() => readAgentSettings());

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const syncSettings = () => {
      setSettingsState(readAgentSettings());
    };

    window.addEventListener("storage", syncSettings);
    window.addEventListener(AGENT_SETTINGS_UPDATED_EVENT, syncSettings);

    return () => {
      window.removeEventListener("storage", syncSettings);
      window.removeEventListener(AGENT_SETTINGS_UPDATED_EVENT, syncSettings);
    };
  }, []);

  const setSettings = useCallback((updater: AgentSettings | ((current: AgentSettings) => AgentSettings)) => {
    setSettingsState((current) => {
      const next = typeof updater === "function"
        ? (updater as (value: AgentSettings) => AgentSettings)(current)
        : updater;
      persistAgentSettings(next);
      return next;
    });
  }, []);

  const setMaxIterations = useCallback((value: number) => {
    const nextValue = Math.min(MAX_AGENT_ITERATIONS, Math.max(1, value));
    setSettings((current) => ({ ...current, maxIterations: nextValue }));
  }, [setSettings]);

  const setAutoApproveCategories = useCallback((categories: string[]) => {
    setSettings((current) => ({ ...current, autoApproveCategories: categories }));
  }, [setSettings]);

  const setShowThinking = useCallback((value: boolean) => {
    setSettings((current) => ({ ...current, showThinking: value }));
  }, [setSettings]);

  return {
    settings,
    setSettings,
    setMaxIterations,
    setAutoApproveCategories,
    setShowThinking
  };
}
