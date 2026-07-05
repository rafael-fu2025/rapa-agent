import { useEffect, useState, useCallback, useRef } from "react";
import { SquareTerminal, Loader2, FolderOpen, Plus, X, Minimize2 } from "lucide-react";
import { TerminalView } from "./terminal-view";
import { getActiveWorkspace, type Workspace } from "../../lib/workspace-api";
import { cn } from "../../lib/utils";

type TerminalDialogProps = {
  open: boolean;
  minimized: boolean;
  onMinimize: () => void;
  onRestore: () => void;
  conversationId?: string;
  /** Workspace from the parent — prefer this over resolving independently */
  workspace?: { id: string; name: string; path: string } | null;
  /**
   * Optional workspace-relative path to pre-pin a new tab to. When set
   * (non-null), a new tab is opened with its PTY spawned in that
   * directory. Set by the file tree's "Open in terminal" action.
   */
  pendingCwd?: string | null;
  /** Called after the dialog has consumed `pendingCwd` so the parent can clear it. */
  onPendingCwdConsumed?: () => void;
};

type TermTab = {
  id: string;
  label: string;
  /**
   * Workspace-relative directory this tab's PTY is pinned to. Empty
   * string means "workspace root" (the default). The frontend
   * converts this to a `cwd` query param on the WebSocket URL.
   */
  cwd: string;
};

let tabCounter = 0;

const MIN_TERMINAL_HEIGHT = 150;
const MAX_TERMINAL_HEIGHT = 0.9; // 90% of viewport height
const DEFAULT_TERMINAL_HEIGHT = Math.round(window.innerHeight * 0.7);

function nextTabId() {
  return `term-${++tabCounter}-${Date.now().toString(36)}`;
}

/**
 * Floating terminal panel with tabbed PTY sessions.
 *
 * Stays mounted as a fixed-position panel instead of a Radix Dialog so that
 * PTY sessions survive minimize/restore cycles. The minimize button shrinks
 * the panel to a thin bar; only closing a tab (×) terminates its PTY.
 */
export function TerminalDialog({ open, minimized, onMinimize, onRestore, conversationId, workspace: parentWorkspace, pendingCwd, onPendingCwdConsumed }: TerminalDialogProps) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tab state — persists across minimize/restore
  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const initializedRef = useRef(false);
  const closeHandlersRef = useRef<Map<string, () => void>>(new Map());

  // Resize state
  const [panelHeight, setPanelHeight] = useState(DEFAULT_TERMINAL_HEIGHT);
  const [isResizing, setIsResizing] = useState(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // Resolve the active workspace when the panel opens or conversation/workspace changes.
  // Prefers the parent-provided workspace (conversation-pinned) over getActiveWorkspace()
  // to avoid mismatches when the global active workspace differs from the conversation's.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        if (parentWorkspace) {
          // Use the conversation-pinned workspace directly
          setWorkspace({
            id: parentWorkspace.id,
            name: parentWorkspace.name,
            path: parentWorkspace.path,
            isActive: true,
            createdAt: "",
            updatedAt: "",
            userId: "",
          } as Workspace);
        } else {
          // Fall back to the globally active workspace
          const ws = await getActiveWorkspace();
          if (cancelled) return;
          if (!ws) {
            setError("No active workspace. Please open a workspace first.");
            setWorkspace(null);
          } else {
            setWorkspace(ws);
          }
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to resolve workspace");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, conversationId, parentWorkspace]);

  // Initialize with one tab on first open
  useEffect(() => {
    if (open && tabs.length === 0 && !initializedRef.current) {
      initializedRef.current = true;
      const baseSessionId = conversationId ? `chat-${conversationId}` : "chat-terminal";
      const firstTab: TermTab = { id: baseSessionId, label: "Terminal 1", cwd: "" };
      setTabs([firstTab]);
      setActiveTabId(firstTab.id);
    }
  }, [open, conversationId]);

  // When the file tree (or any other surface) requests a terminal at a
  // specific sub-folder, open a fresh tab pre-pinned to that directory.
  // The tab id encodes the cwd so the WebSocket session is unique per
  // sub-folder (matches the server-side buildSessionId key).
  //
  // We dedupe: if a tab for the same cwd already exists, we just focus
  // it instead of creating a duplicate.
  useEffect(() => {
    if (!open || !pendingCwd) return;
    const targetCwd = pendingCwd === "." ? "" : pendingCwd;
    const targetId = targetCwd ? `cwd-${targetCwd}` : "chat-terminal";
    setTabs((prev) => {
      const existing = prev.find((t) => t.id === targetId);
      if (existing) return prev;
      // Build a friendly label from the path. Use the basename if it's
      // a sub-folder, otherwise fall back to the full path.
      const parts = pendingCwd.split(/[\\/]+/).filter(Boolean);
      const last = parts[parts.length - 1] ?? "Terminal";
      const label = pendingCwd === "." || pendingCwd === "" ? "Terminal" : `${last}`;
      return [...prev, { id: targetId, label, cwd: targetCwd }];
    });
    setActiveTabId(targetId);
    onPendingCwdConsumed?.();
  }, [open, pendingCwd, onPendingCwdConsumed]);

  // Resize drag handlers
  useEffect(() => {
    const maxH = Math.round(window.innerHeight * MAX_TERMINAL_HEIGHT);

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        // Panel is anchored to the bottom, so dragging up increases height
        const delta = startYRef.current - e.clientY;
        const newHeight = Math.max(MIN_TERMINAL_HEIGHT, Math.min(maxH, startHeightRef.current + delta));
        setPanelHeight(newHeight);
      });
    };

    const handleMouseUp = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove, { passive: true });
      document.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isResizing]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    startYRef.current = e.clientY;
    startHeightRef.current = panelHeight;
  }, [panelHeight]);

  // Ctrl+` to minimize/restore
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "`" && e.ctrlKey) {
      e.preventDefault();
      if (open) {
        minimized ? onRestore() : onMinimize();
      }
    }
  }, [open, minimized, onMinimize, onRestore]);

  useEffect(() => {
    if (open) {
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, [open, handleKeyDown]);

  const addTab = () => {
    const id = nextTabId();
    const label = `Terminal ${tabs.length + 1}`;
    setTabs((prev) => [...prev, { id, label, cwd: "" }]);
    setActiveTabId(id);
  };

  const closeTab = (tabId: string) => {
    // Terminate the PTY session
    const closeFn = closeHandlersRef.current.get(tabId);
    if (closeFn) {
      closeFn();
      closeHandlersRef.current.delete(tabId);
    }

    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (tabId === activeTabId && next.length > 0) {
        setActiveTabId(next[next.length - 1].id);
      } else if (next.length === 0) {
        setActiveTabId(null);
      }
      return next;
    });
  };

  const workspacePath = workspace?.path ?? "";
  const workspaceName = workspace?.name ?? "Workspace";

  // Panel is visible only when open and not minimized.
  // IMPORTANT: The panel stays in the DOM when hidden so that TerminalView
  // components remain mounted and their WebSocket/PTY connections survive.
  const panelVisible = open && !minimized;

  return (
    <>
      {/* ── Minimized bar (only when minimized) ── */}
      {minimized && open && (
        <div
          className="sidebar-panel fixed bottom-3 left-1/2 z-50 flex w-full max-w-[800px] -translate-x-1/2 items-center gap-3 rounded-lg px-4 py-2.5 cursor-pointer select-none"
          onClick={onRestore}
        >
          <div className="flex h-5 w-5 items-center justify-center rounded bg-accent-cyan/10 border border-accent-cyan/20">
            <SquareTerminal className="h-2.5 w-2.5 text-accent-cyan" />
          </div>
          <span className="font-mono-tech text-[10px] font-medium text-foreground">Terminal</span>
          {tabs.length > 0 && (
            <span className="rounded border border-border/30 bg-card-3 px-1.5 py-px font-mono-tech text-[8px] uppercase tracking-[0.1em] text-muted-foreground/60">
              {tabs.length} session{tabs.length > 1 ? "s" : ""}
            </span>
          )}
          <span className="font-mono-tech text-[9px] text-muted-foreground/40 ml-auto">
            click to restore
          </span>
        </div>
      )}

      {/* ── Main panel — always mounted once tabs exist, hidden via display:none ── */}
      <div
        className={cn(
          "sidebar-panel fixed bottom-0 left-1/2 z-50 flex w-full max-w-[800px] -translate-x-1/2 flex-col rounded-t-lg",
          isResizing && "cursor-ns-resize select-none"
        )}
        style={{ height: panelHeight, display: panelVisible ? undefined : "none" }}
      >
        {/* Resize handle — drag to resize */}
        <div
          className="h-3 cursor-ns-resize z-10 flex items-center justify-center transition-colors flex-shrink-0 group/resize"
          onMouseDown={handleResizeStart}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Drag to resize terminal"
          aria-valuenow={panelHeight}
          aria-valuemin={MIN_TERMINAL_HEIGHT}
          aria-valuemax={Math.round(window.innerHeight * MAX_TERMINAL_HEIGHT)}
          title="Drag to resize"
        >
          <div className={cn(
            "h-1.5 rounded-full transition-all duration-150 ease-out",
            isResizing
              ? "w-20 bg-accent-orange shadow-[0_0_8px_-2px] shadow-accent-orange/60"
              : "w-14 bg-muted-foreground/40 group-hover/resize:w-16 group-hover/resize:bg-muted-foreground/70"
          )} />
        </div>

        {/* Blueprint header */}
        <div className="flex flex-row items-center justify-between border-b border-border/30 px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-accent-cyan/10 border border-accent-cyan/20">
              <SquareTerminal className="h-3 w-3 text-accent-cyan" />
            </div>
            <div className="flex flex-col">
              <span className="font-mono-tech text-[11px] font-semibold normal-case tracking-normal text-foreground leading-none">
                Terminal
                {workspace && (
                  <span className="ml-1.5 font-normal text-muted-foreground/70">
                    {workspaceName}
                  </span>
                )}
              </span>
              <span className="mt-1 flex items-center gap-2 font-mono-tech text-[9px] uppercase tracking-[0.1em] text-muted-foreground/60 leading-none">
                {loading ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span>Resolving workspace</span>
                  </>
                ) : error ? (
                  <span className="text-accent-red/80">{error}</span>
                ) : workspace ? (
                  <>
                    <span className="rounded border border-border/30 bg-card-3 px-1 py-px text-[8px]">
                      pty
                    </span>
                    <span className="truncate max-w-[300px]" title={workspacePath}>
                      {workspacePath}
                    </span>
                  </>
                ) : (
                  <span>No workspace</span>
                )}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onMinimize}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:text-foreground hover:bg-accent/20"
              title="Minimize"
            >
              <Minimize2 className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* 2-column body: terminal left, tab rail right */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Terminal area */}
          <div className="flex-1 min-w-0 bg-[#0a0a0a]">
            {error || !workspace ? (
              <div className="flex h-full items-center justify-center">
                <div className="flex flex-col items-center gap-3 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-border/20 bg-card-3/30">
                    <FolderOpen className="h-5 w-5 text-muted-foreground/30" />
                  </div>
                  <div className="space-y-1">
                    <p className="font-mono-tech text-[11px] text-muted-foreground/70">
                      {error ?? "No active workspace."}
                    </p>
                    <p className="font-mono-tech text-[9px] uppercase tracking-[0.12em] text-muted-foreground/40">
                      Open a workspace to start a terminal session
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={cn("h-full w-full", tab.id !== activeTabId && "hidden")}
                >
                  <TerminalView
                    workspaceId={workspace.id}
                    conversationId={conversationId}
                    sessionId={tab.id}
                    cwd={tab.cwd || undefined}
                    autoConnect
                    active={tab.id === activeTabId}
                    visible={panelVisible}
                    embedded
                    className="h-full w-full"
                    onRegisterClose={(closeFn) => {
                      closeHandlersRef.current.set(tab.id, closeFn);
                    }}
                  />
                </div>
              ))
            )}
          </div>

          {/* Vertical tab rail */}
          {tabs.length > 0 && (
            <div className="flex w-10 flex-col items-center border-l border-border/30 bg-card-3/30 py-1.5 gap-1">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  onClick={() => setActiveTabId(tab.id)}
                  title={tab.label}
                  className={cn(
                    "group relative flex h-8 w-8 items-center justify-center rounded cursor-pointer transition-colors select-none",
                    tab.id === activeTabId
                      ? "bg-accent/50 border border-border/40 text-foreground"
                      : "text-muted-foreground/50 hover:text-foreground hover:bg-accent/20"
                  )}
                >
                  <SquareTerminal className="h-3.5 w-3.5" />
                  {tabs.length > 1 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(tab.id);
                      }}
                      className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded bg-card border border-border/40 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent-red/60 hover:text-background"
                    >
                      <X className="h-2 w-2" />
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={addTab}
                className="mt-1 flex h-8 w-8 items-center justify-center rounded text-muted-foreground/40 transition-colors hover:text-foreground hover:bg-accent/20"
                title="New terminal"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
