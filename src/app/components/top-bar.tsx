import { useEffect, useState } from "react";
import { MessageSquare, FileEdit, Route, Download, FolderOpen, ChevronDown, Search, SquareTerminal } from "lucide-react";
import { cn } from "../../lib/utils";
import { listWorkspaces, getActiveWorkspace, type Workspace } from "../../lib/workspace-api";

type ChatMode = "chat" | "agent" | "plan";

type TopBarProps = {
  hideModelSelector?: boolean;
  mode?: ChatMode;
  onModeChange?: (mode: ChatMode) => void;
  onExport?: () => void;
  conversationWorkspace?: { id: string; name: string; path: string } | null;
  onSearchOpen?: () => void;
  onOpenTerminal?: () => void;
};

export const TopBar = ({ hideModelSelector = false, mode = "chat", onModeChange, onExport, conversationWorkspace, onSearchOpen, onOpenTerminal }: TopBarProps) => {
  // Tracks whether at least one workspace exists, so we can gate the Agent /
  // Plan mode toggles behind a "create a workspace first" dialog.
  const [hasWorkspaces, setHasWorkspaces] = useState(false);
  const [activeWorkspace, setActiveWorkspace] = useState<Workspace | null>(null);

  // Keep hasWorkspaces and activeWorkspace in sync with the sidebar (and the
  // API) — both sides dispatch `workspace:changed` after every mutation.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const [data, active] = await Promise.all([
          listWorkspaces(),
          getActiveWorkspace(),
        ]);
        if (!cancelled) {
          setHasWorkspaces(data.length > 0);
          setActiveWorkspace(active);
        }
      } catch {
        if (!cancelled) {
          setHasWorkspaces(false);
          setActiveWorkspace(null);
        }
      }
    };
    void refresh();
    const handler = () => { void refresh(); };
    window.addEventListener("workspace:changed", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("workspace:changed", handler);
    };
  }, []);

  // When the sidebar finishes creating a workspace (after a mode was pending),
  // it dispatches `workspace:mode-ready` with the requested mode. Apply it.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ mode?: ChatMode }>).detail;
      if (detail?.mode) {
        onModeChange?.(detail.mode);
      }
    };
    window.addEventListener("workspace:mode-ready", handler);
    return () => {
      window.removeEventListener("workspace:mode-ready", handler);
    };
  }, [onModeChange]);

  // Mode toggle handler. Chat always switches directly. Agent / Plan require
  // at least one workspace — otherwise we open the new-workspace dialog (handled
  // by the sidebar) and remember which mode the user wanted so we can apply
  // it after they finish creating.
  const handleModeToggle = (next: ChatMode) => {
    if (next === "chat" || hasWorkspaces) {
      onModeChange?.(next);
      return;
    }
    window.dispatchEvent(
      new CustomEvent("workspace:create-requested", { detail: { mode: next } })
    );
  };

  return (
    <div className="relative flex h-[48px] items-center justify-between bg-app px-4">
      <div className="flex items-center gap-2">
        {hideModelSelector ? (
          <span className="font-mono-tech text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Settings</span>
        ) : null}
        {!hideModelSelector && (conversationWorkspace ?? activeWorkspace) ? (
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("workspace:open-modal"))}
            className="workspace-chip flex items-center gap-1.5 rounded-lg px-2.5 h-7 transition-colors hover:bg-accent"
            title={(conversationWorkspace ?? activeWorkspace)!.path}
            type="button"
          >
            <FolderOpen size={12} className="shrink-0 text-muted-foreground" />
            <span className="max-w-[140px] truncate text-foreground">{(conversationWorkspace ?? activeWorkspace)!.name}</span>
            <ChevronDown size={10} className="shrink-0 text-muted-foreground" />
          </button>
        ) : !hideModelSelector ? (
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("workspace:open-modal"))}
            className="workspace-chip flex items-center gap-1.5 rounded-lg px-2.5 h-7 transition-colors hover:bg-accent text-muted-foreground"
            title="Select a workspace"
            type="button"
          >
            <FolderOpen size={12} className="shrink-0" />
            <span className="text-foreground/70">Select Workspace</span>
            <ChevronDown size={10} className="shrink-0" />
          </button>
        ) : null}
      </div>

      {!hideModelSelector ? (
        <div className="mode-toggle-panel absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-0.5 rounded-lg p-0.5">
          <button
            onClick={() => handleModeToggle("chat")}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-all",
              mode === "chat"
                ? "bg-accent/50 text-foreground border border-border/40"
                : "text-muted-foreground hover:text-foreground hover:bg-accent"
            )}
          >
            <MessageSquare size={12} />
            <span>Chat</span>
          </button>
          <button
            onClick={() => handleModeToggle("agent")}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-all",
              mode === "agent"
                ? "bg-accent/50 text-foreground border border-border/40"
                : "text-muted-foreground hover:text-foreground hover:bg-accent"
            )}
          >
            <FileEdit size={12} />
            <span>Agent</span>
          </button>
          <button
            onClick={() => handleModeToggle("plan")}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-all",
              mode === "plan"
                ? "bg-accent/50 text-foreground border border-border/40"
                : "text-muted-foreground hover:text-foreground hover:bg-accent"
            )}
          >
            <Route size={12} />
            <span>Plan</span>
          </button>
        </div>
      ) : null}

      <div className="flex items-center gap-1.5 pr-1">
        {!hideModelSelector && onSearchOpen ? (
          <button
            onClick={onSearchOpen}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-card hover:text-primary"
            title="Search conversation (Ctrl+K)"
            type="button"
          >
            <Search size={13} strokeWidth={2} />
          </button>
        ) : null}
        {!hideModelSelector && onExport ? (
          <button
            onClick={onExport}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-card hover:text-primary"
            title="Export Conversation"
            type="button"
          >
            <Download size={14} strokeWidth={2} />
          </button>
        ) : null}
        {!hideModelSelector && onOpenTerminal ? (
          <button
            onClick={onOpenTerminal}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-card hover:text-primary"
            title="Open Terminal"
            type="button"
          >
            <SquareTerminal size={14} strokeWidth={2} />
          </button>
        ) : null}
      </div>
    </div>
  );
};
