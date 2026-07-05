import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  FolderPlus,
  Folder,
  Lock,
  MessageSquarePlus,
  Settings,
  PanelLeft,
  MoreHorizontal,
  Pencil,
  Trash2,
  History,
  Plus,
  Power,
  Search,
  Sun,
  Moon
} from "lucide-react";
import { useAuth } from "../hooks/use-auth";
import { useTheme } from "../hooks/use-theme";
import { cn } from "../../lib/utils";
import { getProviderIcon } from "../../lib/provider-icons";
import { toast } from "sonner";
import {
  deleteConversation,
  deleteAllConversations,
  getConversations,
  getProviders,
  renameConversation,
  type ConversationListItem,
  type Provider
} from "../../lib/api";
import { listWorkspaces, setActiveWorkspace, createWorkspace, pickWorkspaceFolder, deleteWorkspace, getWorkspaceRegistry, type Workspace, type WorkspaceRegistry } from "../../lib/workspace-api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";

interface SidebarItemProps {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  active?: boolean;
  to?: string;
  collapsed?: boolean;
  /**
   * Click handler that runs in addition to (or instead of) the navigation.
   * Use this for actions that need to reset state before navigating
   * (e.g. "New Chat" which should always start fresh, even when the user
   * is already on the home route — a Link to="/" is a no-op there).
   */
  onClick?: (event: React.MouseEvent) => void;
}

interface SidebarProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /**
   * Called when the user clicks the "New Chat" item. If not provided, the
   * item falls back to navigating to "/" — but that is a no-op when the
   * user is already on "/", so callers should usually pass an explicit
   * handler that resets state before navigating.
   */
  onNewChat?: () => void;
}

const SidebarItem = ({ icon, label, shortcut, active, to, collapsed = false, onClick }: SidebarItemProps) => {
  const content = (
    <>
      <div className={cn("flex items-center", collapsed ? "justify-center w-full" : "gap-3")}>
        <div className="w-5 h-5 flex items-center justify-center">{icon}</div>
        {!collapsed && <span className="text-[11px] font-medium leading-none font-mono-tech">{label}</span>}
      </div>
      {!collapsed && shortcut && (
        <span className="text-[10px] text-muted-foreground group-hover:text-foreground font-medium">{shortcut}</span>
      )}
    </>
  );

  const className = cn(
    "flex items-center rounded-lg cursor-pointer transition-colors group",
    collapsed ? "justify-center px-2 py-2.5" : "justify-between px-3 py-2",
    active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"
  );

  if (to) {
    return (
      <Link
        to={to}
        className={className}
        title={collapsed ? label : undefined}
        onClick={onClick}
      >
        {content}
      </Link>
    );
  }

  return (
    <div
      className={className}
      title={collapsed ? label : undefined}
      onClick={onClick}
    >
      {content}
    </div>
  );
};

const LogoutConfirmDialog = ({ children, onConfirm }: { children: React.ReactNode, onConfirm: () => void }) => (
  <AlertDialog>
    <AlertDialogTrigger asChild>
      {children}
    </AlertDialogTrigger>
    <AlertDialogContent className="dialog-panel rounded-lg text-foreground">
      <AlertDialogHeader>
        <AlertDialogTitle className="text-[11px] font-semibold uppercase tracking-[0.1em]">Log out of Rapa?</AlertDialogTitle>
        <AlertDialogDescription className="text-[10px] text-muted-foreground">
          You will need to log in again to access your workspaces and conversations.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel className="bg-transparent border-border/50 text-[10px] font-semibold uppercase tracking-[0.06em] text-foreground hover:bg-accent">
          Cancel
        </AlertDialogCancel>
        <AlertDialogAction
          onClick={onConfirm}
          className="bg-accent-red text-[10px] font-semibold uppercase tracking-[0.06em] text-background hover:bg-accent-red/80"
        >
          Log out
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

/**
 * One-click theme toggle button used in the sidebar header. Cycles
 * light → dark → light. For the full system-preference option, see
 * Settings → Appearance.
 */
const ThemeQuickToggle = () => {
  const { resolved, toggle } = useTheme();
  const isDark = resolved === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      aria-label="Toggle color theme"
      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {isDark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
};

export const Sidebar = ({ collapsed = false, onToggleCollapse, onNewChat }: SidebarProps) => {
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const selectedConversationId = searchParams.get("c");
  const isSettingsRoute = location.pathname === "/settings";
  const settingsTabParam = searchParams.get("tab");
  const settingsTab = settingsTabParam || "usage";

  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [renameTarget, setRenameTarget] = useState<ConversationListItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ConversationListItem | null>(null);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const { logout } = useAuth();

  // Workspaces (now managed via a modal opened from the workspace icon in the icons tab)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // Registry snapshot — gives us per-workspace running-agent counts and
  // pending-approval counts so the modal can show "3 agents running in
  // Workspace A" badges without making a second request. Refreshed when
  // the modal opens, and again whenever `workspace:changed` fires.
  const [registry, setRegistry] = useState<WorkspaceRegistry | null>(null);
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const [showWorkspacesModal, setShowWorkspacesModal] = useState(false);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [newWorkspace, setNewWorkspace] = useState({ name: "", path: "" });
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [browsingFolder, setBrowsingFolder] = useState(false);
  // Mode that triggered the create-workspace dialog (agent | plan). When the user
  // creates a workspace, we dispatch `workspace:mode-ready` with this so the top
  // bar can apply the mode change.
  const [pendingMode, setPendingMode] = useState<"agent" | "plan" | null>(null);
  // Workspace delete confirmation flow
  const [workspaceToDelete, setWorkspaceToDelete] = useState<Workspace | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState(false);

  const loadWorkspaces = async () => {
    try {
      const data = await listWorkspaces();
      setWorkspaces(data);
    } catch {
      setWorkspaces([]);
    }
  };

  const loadRegistry = async () => {
    try {
      const data = await getWorkspaceRegistry();
      setRegistry(data);
    } catch {
      setRegistry(null);
    }
  };

  // Multi-workspace behavior: clicking a workspace only updates the
  // UI focus hint (`isActive`). It does NOT touch any in-flight agent
  // in any other workspace — those keep running on their own. The
  // `workspace:changed` event is still dispatched so other UI surfaces
  // (top bar) can refresh their focus indicator.
  //
  // Per-conversation workspace binding: switching is blocked while viewing
  // an existing conversation because the conversation's workspace is
  // immutable once assigned. The user must start a new chat first.
  const handleSelectWorkspace = async (workspace: Workspace): Promise<boolean> => {
    if (selectedConversationId) {
      toast.info(
        "Can't switch workspace while viewing a conversation. Start a new chat to change workspace.",
        { duration: 4000 }
      );
      return false;
    }
    try {
      if (!workspace.isActive) {
        await setActiveWorkspace(workspace.id);
        window.dispatchEvent(new CustomEvent("workspace:changed"));
        void loadWorkspaces();
        void loadRegistry();
      }
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to switch workspace");
      return false;
    }
  };

  const handleConfirmDeleteWorkspace = async () => {
    if (!workspaceToDelete) return;
    setDeletingWorkspace(true);
    try {
      await deleteWorkspace(workspaceToDelete.id);
      window.dispatchEvent(new CustomEvent("workspace:changed"));
      toast.success(`Removed workspace "${workspaceToDelete.name}"`);
      setWorkspaceToDelete(null);
      void loadWorkspaces();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove workspace");
    } finally {
      setDeletingWorkspace(false);
    }
  };

  const handleBrowseFolder = async () => {
    setBrowsingFolder(true);
    try {
      const result = await pickWorkspaceFolder();
      if (result.path && result.name) {
        setNewWorkspace((prev) => ({ ...prev, path: result.path ?? "", name: prev.name || result.name }));
      } else if (result.path) {
        setNewWorkspace((prev) => ({ ...prev, path: result.path ?? "" }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not open folder picker";
      toast.error(message);
    } finally {
      setBrowsingFolder(false);
    }
  };

  const handleCreateWorkspace = async () => {
    if (!newWorkspace.name.trim() || !newWorkspace.path.trim()) {
      toast.error("Please provide both a name and a folder path");
      return;
    }
    setCreatingWorkspace(true);
    try {
      await createWorkspace({
        name: newWorkspace.name.trim(),
        path: newWorkspace.path.trim()
      });
      window.dispatchEvent(new CustomEvent("workspace:changed"));
      setShowCreateWorkspace(false);
      setNewWorkspace({ name: "", path: "" });
      void loadWorkspaces();
      toast.success("Workspace created");
      // If a mode (agent | plan) was waiting for a workspace, apply it now.
      if (pendingMode) {
        window.dispatchEvent(
          new CustomEvent("workspace:mode-ready", { detail: { mode: pendingMode } })
        );
        setPendingMode(null);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create workspace");
    } finally {
      setCreatingWorkspace(false);
    }
  };

  const filteredWorkspaces = useMemo(() => {
    const query = workspaceSearch.trim().toLowerCase();
    if (!query) return workspaces;
    return workspaces.filter(
      (w) => w.name.toLowerCase().includes(query) || w.path.toLowerCase().includes(query)
    );
  }, [workspaces, workspaceSearch]);

  // Build a workspaceId -> registry-item lookup so the row render can
  // pull running-agent counts in O(1) without scanning the whole array
  // on every render. The registry may be null briefly while the first
  // request is in flight; we fall back to zeros in that case.
  const registryById = useMemo(() => {
    const map = new Map<string, WorkspaceRegistry["items"][number]>();
    if (registry) {
      for (const item of registry.items) {
        map.set(item.id, item);
      }
    }
    return map;
  }, [registry]);

  // Flat Set of conversation IDs that have at least one live agent run
  // anywhere across the user's workspaces. Used by the history list to
  // show a pulsing "running" dot per row so the user can see at a glance
  // which threads are still in flight — including in workspaces that
  // are not currently focused.
  //
  // Built from the registry because that endpoint is already capped at
  // ~5 running agents per workspace. If the user has more than that
  // running in workspaces not shown by the modal, those badges will be
  // slightly stale until they next open the workspaces modal or the
  // 5s registry poll fires. Good enough for the current scale.
  const runningConversationIds = useMemo(() => {
    const set = new Set<string>();
    if (registry) {
      for (const item of registry.items) {
        for (const run of item.runningAgents) {
          set.add(run.conversationId);
        }
      }
    }
    return set;
  }, [registry]);

  const loadConversations = async (cursor?: string) => {
    try {
      const data = await getConversations(cursor);
      if (cursor) {
        setConversations(prev => [...prev, ...data.items]);
      } else {
        setConversations(data.items);
      }
      setNextCursor(data.nextCursor);
    } catch {
      if (!cursor) setConversations([]);
    }
  };

  const loadProviders = async () => {
    try {
      const data = await getProviders();
      setProviders(data.providers);
    } catch {
      setProviders([]);
    }
  };

  useEffect(() => {
    let mounted = true;

    const loadInitial = async () => {
      if (!mounted) return;
      await loadConversations();
      await loadProviders();
      await loadWorkspaces();
    };

    void loadInitial();

    const conversationsInterval = window.setInterval(() => {
      if (!nextCursor) { // only auto-refresh if we're on the first page
        void loadConversations();
      }
    }, 5000);

    // Polls the registry at the same cadence as the conversation list
    // so the "running" pill in the history list and the badges in the
    // workspaces modal stay reasonably fresh without us having to wire
    // an SSE channel. Skipped on /settings because the workspace UI is
    // hidden there and the workspaces modal isn't open.
    const registryInterval = window.setInterval(() => {
      if (location.pathname !== "/settings") {
        void loadRegistry();
      }
    }, 5000);

    const handleWorkspaceChanged = () => {
      void loadWorkspaces();
      void loadRegistry();
    };
    window.addEventListener("workspace:changed", handleWorkspaceChanged);

    // Also refresh the registry when the user opens the workspaces modal,
    // even if no workspace mutation happened. Cheap; the registry endpoint
    // is a single SQL query.
    const handleRegistryRefresh = () => { void loadRegistry(); };
    window.addEventListener("registry:refresh", handleRegistryRefresh);

    return () => {
      mounted = false;
      window.clearInterval(conversationsInterval);
      window.clearInterval(registryInterval);
      window.removeEventListener("workspace:changed", handleWorkspaceChanged);
      window.removeEventListener("registry:refresh", handleRegistryRefresh);
    };
  }, [nextCursor]);

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    await loadConversations(nextCursor);
    setLoadingMore(false);
  };

  const filteredConversations = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return conversations;
    return conversations.filter((chat) => (chat.title || "Untitled").toLowerCase().includes(query));
  }, [conversations, searchQuery]);

  const handleSelectHistory = () => {
    if (location.pathname === "/settings") {
      navigate("/");
    }
  };

  // Listen for "create a workspace" requests coming from the top bar when the
  // user clicks Agent or Plan with no workspaces set up yet.
  useEffect(() => {
    const handleCreateRequested = (event: Event) => {
      const detail = (event as CustomEvent<{ mode?: "agent" | "plan" }>).detail;
      setPendingMode(detail?.mode ?? null);
      setShowCreateWorkspace(true);
    };
    window.addEventListener("workspace:create-requested", handleCreateRequested);
    return () => {
      window.removeEventListener("workspace:create-requested", handleCreateRequested);
    };
  }, []);

  // Listen for "open workspaces modal" requests from the top bar workspace button.
  useEffect(() => {
    const handleOpenModal = () => {
      void loadWorkspaces();
      void loadRegistry();
      setShowWorkspacesModal(true);
      if (location.pathname === "/settings") {
        navigate("/");
      }
    };
    window.addEventListener("workspace:open-modal", handleOpenModal);
    return () => {
      window.removeEventListener("workspace:open-modal", handleOpenModal);
    };
  }, [location.pathname, navigate]);

  const handleSelectSettingsTab = (tab: string) => {
    navigate(`/settings?tab=${tab}`);
  };

  const handleOpenRename = (chat: ConversationListItem) => {
    setRenameTarget(chat);
    setRenameValue(chat.title || "");
  };

  const handleConfirmRename = async () => {
    if (!renameTarget) return;
    const nextTitle = renameValue.trim();
    if (!nextTitle) return;

    setBusy(true);
    try {
      await renameConversation(renameTarget.id, nextTitle);
      await loadConversations();
      setRenameTarget(null);
      setRenameValue("");
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;

    setBusy(true);
    try {
      await deleteConversation(deleteTarget.id);
      if (selectedConversationId === deleteTarget.id) {
        navigate("/");
      }
      await loadConversations();
      setDeleteTarget(null);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteAll = async () => {
    setBusy(true);
    try {
      await deleteAllConversations();
      
      // Navigate to home if we were viewing a conversation
      if (selectedConversationId) {
        navigate("/");
      }
      
      await loadConversations();
      setShowDeleteAllConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        className={cn(
          "sidebar-panel h-full rounded-lg flex flex-col transition-[width] duration-200",
          collapsed ? "w-[72px]" : "w-[260px]"
        )}
      >
        {collapsed ? (
          <>
            <div className="flex items-center justify-center px-2 py-4 gap-1">
              <button
                onClick={onToggleCollapse}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title="Expand sidebar"
                type="button"
              >
                <PanelLeft size={18} className="rotate-180" />
              </button>
              <ThemeQuickToggle />
            </div>

            <div className="px-2 space-y-0.5">
              <SidebarItem
                icon={<MessageSquarePlus size={18} />}
                label="New Chat"
                to="/"
                active={location.pathname === "/" && !selectedConversationId}
                collapsed={collapsed}
                onClick={onNewChat}
              />
              <SidebarItem
                icon={<Settings size={18} />}
                label="Settings"
                to="/settings?tab=usage"
                active={location.pathname === "/settings"}
                collapsed={collapsed}
              />
              <LogoutConfirmDialog onConfirm={logout}>
                <button
                  className="flex w-full items-center justify-center rounded-lg px-2 py-2.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                  title="Log out"
                  type="button"
                >
                  <Power size={18} />
                </button>
              </LogoutConfirmDialog>
            </div>
          </>
        ) : (
          <>
            <div className="px-3 pt-3 pb-3">
              <div className="flex items-center justify-between px-1 pb-3">
                <h1 className="text-[14px] font-semibold tracking-[0.02em] text-foreground font-mono-tech">Rapa</h1>
                <div className="flex items-center gap-1">
                  <ThemeQuickToggle />
                  <button
                    onClick={onToggleCollapse}
                    className="p-2 text-muted-foreground transition-colors hover:text-foreground"
                    title="Collapse sidebar"
                    type="button"
                  >
                    <PanelLeft size={16} />
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-center px-1">
                <button
                  onClick={handleSelectHistory}
                  className={cn(
                    "rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    !isSettingsRoute && "bg-accent text-foreground"
                  )}
                  title="History"
                  type="button"
                >
                  <History size={16} />
                </button>
                <span className="mx-1 h-5 w-px bg-card-hover" />
                <Link
                  to={`/settings?tab=${settingsTab}`}
                  className={cn(
                    "rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    location.pathname === "/settings" && "bg-accent text-foreground"
                  )}
                  title="Settings"
                >
                  <Settings size={16} />
                </Link>
                <span className="mx-1 h-5 w-px bg-card-hover" />
                <LogoutConfirmDialog onConfirm={logout}>
                  <button
                    className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                    title="Log out"
                    type="button"
                  >
                    <Power size={16} />
                  </button>
                </LogoutConfirmDialog>
              </div>

              {!isSettingsRoute ? (
                <div className="mt-3 flex items-center gap-2">
                  <div className="flex-1 relative">
                    <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <input
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="Search conversations..."
                      className="h-8 w-full rounded-md border border-border bg-app pl-8 pr-3 text-[12px] text-foreground placeholder-muted-foreground focus:border-ring focus:outline-none"
                    />
                  </div>
                  <Link
                    to="/"
                    onClick={(event) => {
                      handleSelectHistory();
                      onNewChat?.(event);
                    }}
                    className="rounded-xl p-2.5 text-muted-foreground transition-colors hover:bg-card-2 hover:text-foreground"
                    title="New chat"
                  >
                    <MessageSquarePlus size={17} />
                  </Link>
                </div>
              ) : null}
            </div>

            {/* History header — pinned outside scroll area */}
            {!isSettingsRoute && (
              <div className="px-3 pb-2 flex items-center justify-between">
                <h2 className="text-[11px] font-semibold text-muted-foreground font-mono-tech uppercase tracking-[0.08em]">History</h2>
                {conversations.length > 0 && (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" type="button">
                        <MoreHorizontal size={14} />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        className="dropdown-panel z-50 min-w-[160px] rounded-lg p-1.5 text-card-foreground animate-in fade-in-80 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 shadow-2xl"
                        side="bottom"
                        align="end"
                        sideOffset={4}
                      >
                        <DropdownMenu.Item
                          onSelect={() => setShowDeleteAllConfirm(true)}
                          className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-[11px] font-mono-tech text-accent-red outline-none transition-colors hover:bg-accent-red/10"
                        >
                          <Trash2 size={14} />
                          <span className="font-medium">Delete All</span>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                )}
              </div>
            )}

            <div
              className={cn(
                "sidebar-scroll min-h-0 flex-1 w-full overflow-y-auto",
                isSettingsRoute && "mt-4"
              )}
            >
              <div className="w-full pl-2 pr-4">
              {isSettingsRoute ? (
                <div className="space-y-4 px-3 pb-3">
                  <div className="space-y-1">
                    <h2 className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">Analytics</h2>
                    <button
                      type="button"
                      onClick={() => handleSelectSettingsTab("usage")}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-3 py-1.5 text-left font-mono-tech text-[10px] transition-colors",
                        settingsTab === "usage"
                          ? "bg-accent/15 border border-accent/30 text-foreground"
                          : "bg-transparent text-muted-foreground hover:bg-accent/10 hover:text-foreground border border-transparent"
                      )}
                    >
                      <span>Usage Analytics</span>
                    </button>
                  </div>

                  <div className="space-y-1">
                    <h2 className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">Agent</h2>
                    <button
                      type="button"
                      onClick={() => handleSelectSettingsTab("agent")}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-3 py-1.5 text-left font-mono-tech text-[10px] transition-colors",
                        settingsTab === "agent"
                          ? "bg-accent/15 border border-accent/30 text-foreground"
                          : "bg-transparent text-muted-foreground hover:bg-accent/10 hover:text-foreground border border-transparent"
                      )}
                    >
                      <span>Agent Settings</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSelectSettingsTab("skills")}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-3 py-1.5 text-left font-mono-tech text-[10px] transition-colors",
                        settingsTab === "skills"
                          ? "bg-accent/15 border border-accent/30 text-foreground"
                          : "bg-transparent text-muted-foreground hover:bg-accent/10 hover:text-foreground border border-transparent"
                      )}
                    >
                      <span>Specialists</span>
                    </button>
                  </div>

                  <div className="space-y-1">
                    <h2 className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">Integrations</h2>
                    <button
                      type="button"
                      onClick={() => handleSelectSettingsTab("search")}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-3 py-1.5 text-left font-mono-tech text-[10px] transition-colors",
                        settingsTab === "search"
                          ? "bg-accent/15 border border-accent/30 text-foreground"
                          : "bg-transparent text-muted-foreground hover:bg-accent/10 hover:text-foreground border border-transparent"
                      )}
                    >
                      <span>Web Search</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSelectSettingsTab("appearance")}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-3 py-1.5 text-left font-mono-tech text-[10px] transition-colors",
                        settingsTab === "appearance"
                          ? "bg-accent/15 border border-accent/30 text-foreground"
                          : "bg-transparent text-muted-foreground hover:bg-accent/10 hover:text-foreground border border-transparent"
                      )}
                    >
                      <span>Appearance</span>
                    </button>
                  </div>

                  <div>
                    <h2 className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">Model Providers</h2>
                  </div>

                  <div>
                    <div className="space-y-1">
                      {providers.map((provider) => {
                        const isActive = settingsTab === provider.provider;
                        const logo = getProviderIcon(provider.provider);

                        return (
                          <button
                            key={provider.provider}
                            type="button"
                            onClick={() => handleSelectSettingsTab(provider.provider)}
                            className={cn(
                              "flex w-full items-center gap-2 rounded px-3 py-1.5 text-left font-mono-tech text-[10px] transition-colors",
                              isActive
                                ? "bg-accent/15 border border-accent/30 text-foreground"
                                : "bg-transparent text-muted-foreground hover:bg-accent/10 hover:text-foreground border border-transparent"
                            )}
                          >
                            {logo ? (
                              <img src={logo} alt={provider.displayName} className="h-3.5 w-3.5" />
                            ) : (
                              <div className="h-3.5 w-3.5 rounded-sm bg-card-hover flex items-center justify-center text-[9px] font-bold text-muted">
                                {provider.displayName.charAt(0).toUpperCase()}
                              </div>
                            )}
                            <span>{provider.displayName}</span>
                          </button>
                        );
                      })}

                      <button
                        type="button"
                        onClick={() => handleSelectSettingsTab("add-provider")}
                        className={cn(
                          "flex w-full items-center gap-2 rounded px-3 py-1.5 text-left font-mono-tech text-[10px] transition-colors",
                          settingsTab === "add-provider"
                            ? "bg-accent/15 border border-accent/30 text-foreground"
                            : "bg-transparent text-muted-foreground hover:bg-accent/10 hover:text-foreground border border-transparent"
                        )}
                      >
                        <Plus size={12} />
                        <span>Add Custom Provider</span>
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-0.5 pb-3">
                    {filteredConversations.length === 0 ? (
                      <div className="px-3 py-2 text-[11px] text-disabled font-mono-tech">
                        {searchQuery.trim() ? "No matching conversations" : "No conversations yet"}
                      </div>
                    ) : (
                      filteredConversations.map((chat) => {
                        const isActiveConversation = selectedConversationId === chat.id;
                        const isRunning = runningConversationIds.has(chat.id);

                        return (
                          <div
                            key={chat.id}
                            className={cn(
                              "group flex w-full min-w-0 items-center gap-1.5 rounded-lg px-3 py-1 transition-colors",
                              isActiveConversation
                                ? "bg-accent text-foreground"
                                : "bg-transparent text-foreground hover:bg-muted"
                            )}
                            title={
                              isRunning
                                ? `${chat._count.messages} messages — agent is currently running`
                                : `${chat._count.messages} messages`
                            }
                          >
                            <Link to={`/?c=${encodeURIComponent(chat.id)}`} className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                              {isRunning ? (
                                <span
                                  className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary"
                                  aria-hidden
                                />
                              ) : null}
                              <span className="min-w-0 flex-1 truncate text-[11px] font-normal font-mono-tech">{chat.title || "Untitled"}</span>
                              {isRunning ? (
                                <span
                                  className="shrink-0 rounded-full bg-accent/40 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-primary"
                                  title="Agent is currently running in this conversation"
                                >
                                  running
                                </span>
                              ) : null}
                            </Link>

                            <DropdownMenu.Root>
                              <DropdownMenu.Trigger asChild>
                                <button
                                  className="shrink-0 rounded-md p-1 text-muted-foreground outline-none opacity-0 group-hover:opacity-100 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
                                  type="button"
                                  aria-label={`Actions for ${chat.title || "Untitled"}`}
                                >
                                  <MoreHorizontal size={14} />
                                </button>
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Portal>
                                <DropdownMenu.Content
                                  className="dropdown-panel z-50 min-w-[190px] rounded-lg p-1.5 text-card-foreground animate-in fade-in-80 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 shadow-2xl"
                                  side="bottom"
                                  align="start"
                                  alignOffset={-10}
                                  sideOffset={4}
                                >
                                  <DropdownMenu.Item
                                    onSelect={() => handleOpenRename(chat)}
                                    className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-[11px] font-mono-tech outline-none transition-colors hover:bg-accent hover:text-foreground"
                                  >
                                    <Pencil size={14} />
                                    <span className="font-medium">Rename</span>
                                  </DropdownMenu.Item>

                                  <DropdownMenu.Separator className="mx-1 my-1 h-px bg-card-hover" />

                                  <DropdownMenu.Item
                                    onSelect={() => setDeleteTarget(chat)}
                                    className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-[11px] font-mono-tech text-accent-red outline-none transition-colors hover:bg-accent-red/10"
                                  >
                                    <Trash2 size={14} />
                                    <span className="font-medium">Delete</span>
                                  </DropdownMenu.Item>
                                </DropdownMenu.Content>
                              </DropdownMenu.Portal>
                            </DropdownMenu.Root>
                          </div>
                        );
                      })
                    )}
                    {nextCursor && !searchQuery.trim() && (
                      <div className="px-3 py-2">
                        <button
                          type="button"
                          onClick={handleLoadMore}
                          disabled={loadingMore}
                          className="w-full rounded-md bg-muted py-1.5 text-[11px] font-medium font-mono-tech text-muted transition-colors hover:bg-card-5 hover:text-white disabled:opacity-50"
                        >
                          {loadingMore ? "Loading..." : "Load More"}
                        </button>
                      </div>
                    )}
                </div>
              )}
              </div>
            </div>
          </>
        )}
      </div>

      {renameTarget && (
        <AlertDialog open={!!renameTarget} onOpenChange={(open) => {
          if (!open) {
            setRenameTarget(null);
            setRenameValue("");
          }
        }}>
          <AlertDialogContent className="dialog-panel rounded-lg text-foreground">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-[11px] font-semibold uppercase tracking-[0.1em]">Thread Title</AlertDialogTitle>
            </AlertDialogHeader>
            <input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="Thread Title"
              className="w-full rounded-md border border-border/50 bg-card-2/50 px-3 py-2 text-[11px] text-foreground placeholder-muted-foreground focus:border-border focus:outline-none"
            />
            <AlertDialogFooter>
              <AlertDialogCancel
                className="bg-transparent border-border/50 text-[10px] font-semibold uppercase tracking-[0.06em] text-foreground hover:bg-accent"
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={handleConfirmRename}
                disabled={busy || !renameValue.trim()}
                className="bg-accent-green text-[10px] font-semibold uppercase tracking-[0.06em] text-background hover:bg-accent-green/80 disabled:opacity-50"
              >
                Rename
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {deleteTarget && (
        <AlertDialog open={!!deleteTarget} onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}>
          <AlertDialogContent className="dialog-panel rounded-lg text-foreground">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-[11px] font-semibold uppercase tracking-[0.1em]">Delete Thread</AlertDialogTitle>
              <AlertDialogDescription className="text-[10px] text-muted-foreground">
                Are you sure you want to delete this thread? This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                className="bg-transparent border-border/50 text-[10px] font-semibold uppercase tracking-[0.06em] text-foreground hover:bg-accent"
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={handleConfirmDelete}
                disabled={busy}
                className="bg-accent-red text-[10px] font-semibold uppercase tracking-[0.06em] text-background hover:bg-accent-red/80 disabled:opacity-50"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {showDeleteAllConfirm && (
        <AlertDialog open={showDeleteAllConfirm} onOpenChange={(open) => {
          if (!open) {
            setShowDeleteAllConfirm(false);
          }
        }}>
          <AlertDialogContent className="dialog-panel rounded-lg text-foreground">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-[11px] font-semibold uppercase tracking-[0.1em]">Delete All Threads</AlertDialogTitle>
              <AlertDialogDescription className="text-[10px] text-muted-foreground">
                Are you sure you want to delete all {conversations.length} conversation{conversations.length === 1 ? '' : 's'}? This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                className="bg-transparent border-border/50 text-[10px] font-semibold uppercase tracking-[0.06em] text-foreground hover:bg-accent"
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDeleteAll}
                disabled={busy}
                className="bg-accent-red text-[10px] font-semibold uppercase tracking-[0.06em] text-background hover:bg-accent-red/80 disabled:opacity-50"
              >
                Delete All
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Workspaces modal — opened by the workspace folder icon in the icons tab */}
      <Dialog open={showWorkspacesModal} onOpenChange={(open) => {
        if (!open) {
          setShowWorkspacesModal(false);
          setWorkspaceSearch("");
        }
      }}>
        <DialogContent className="dialog-panel rounded-lg text-foreground sm:max-w-[28rem]">
          <DialogHeader>
            <DialogTitle className="text-[11px] font-semibold uppercase tracking-[0.1em] text-foreground">Workspaces</DialogTitle>
            <DialogDescription className="text-[10px] text-muted-foreground">
              Add and switch between workspaces. Each keeps its own threads and running agents.
            </DialogDescription>
            {selectedConversationId ? (
              <div className="flex items-center gap-2 rounded-md border border-border/40 bg-accent/20 px-3 py-2 text-[10px] text-muted-foreground">
                <Lock size={11} className="shrink-0" />
                <span>Workspace switching is locked while viewing a conversation. Start a new chat to switch.</span>
              </div>
            ) : null}
          </DialogHeader>

          <div className="flex items-center gap-2">
            <div className="flex-1 relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={workspaceSearch}
                onChange={(event) => setWorkspaceSearch(event.target.value)}
                placeholder="Search workspaces..."
                className="h-8 w-full rounded-md border border-border/50 bg-card-2/50 pl-7 pr-3 text-[11px] text-foreground placeholder-muted-foreground focus:border-border focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                setShowWorkspacesModal(false);
                setShowCreateWorkspace(true);
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/50 bg-transparent px-2.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-foreground transition-colors hover:bg-accent"
              title="New workspace"
            >
              <FolderPlus size={12} />
              <span>New</span>
            </button>
          </div>

          <div className="max-h-[60vh] overflow-y-auto rounded-md border border-border/40 bg-card-2/30 [scrollbar-width:thin] [scrollbar-color:transparent_transparent] hover:[scrollbar-color:hsl(var(--muted)/0.4)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-button]:hidden [&::-webkit-scrollbar-button]:h-0 [&::-webkit-scrollbar-button]:w-0 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted/40 hover:[&::-webkit-scrollbar-thumb]:bg-muted/60">
            {filteredWorkspaces.length === 0 ? (
              <div className="px-3 py-6 text-center text-[10px] text-muted-foreground">
                {workspaceSearch.trim()
                  ? "No matching workspaces"
                  : "No workspaces yet — create one to use Agent or Plan mode."}
              </div>
            ) : (
              <div className="divide-y divide-border/30">
                {filteredWorkspaces.map((ws) => {
                  const reg = registryById.get(ws.id);
                  const runningCount = reg?.runningAgentCount ?? 0;
                  const pendingCount = reg?.pendingApprovalCount ?? 0;
                  return (
                    <div
                      key={ws.id}
                      className={cn(
                        "group flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
                        ws.isActive
                          ? "bg-accent/50 text-foreground"
                          : "text-foreground hover:bg-accent/20",
                        selectedConversationId && !ws.isActive && "opacity-40 hover:opacity-60"
                      )}
                      title={selectedConversationId ? "Locked — start a new chat to switch workspace" : ws.path}
                    >
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await handleSelectWorkspace(ws);
                          if (ok) {
                            setShowWorkspacesModal(false);
                            setWorkspaceSearch("");
                          }
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                        title={ws.path}
                      >
                        {ws.isActive ? (
                          <Folder size={13} className="shrink-0 text-accent-orange" />
                        ) : (
                          <Folder size={13} className="shrink-0 text-muted-foreground" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-[11px] font-medium text-foreground">{ws.name}</span>
                            {runningCount > 0 ? (
                              <span
                                className="shrink-0 inline-flex items-center gap-1 rounded-full bg-accent/30 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.04em] text-foreground"
                                title={`${runningCount} agent${runningCount === 1 ? "" : "s"} running in this workspace`}
                              >
                                <span
                                  className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent-green"
                                  aria-hidden
                                />
                                {runningCount} running
                              </span>
                            ) : null}
                            {pendingCount > 0 ? (
                              <span
                                className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.04em] text-amber-500"
                                title={`${pendingCount} tool approval${pendingCount === 1 ? "" : "s"} waiting in this workspace`}
                              >
                                {pendingCount} pending
                              </span>
                            ) : null}
                          </div>
                          <div className="truncate text-[9px] text-muted-foreground">{ws.path}</div>
                        </div>
                        {ws.isActive ? (
                          <span className="shrink-0 rounded-full bg-accent-orange/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.04em] text-accent-orange">
                            Active
                          </span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setWorkspaceToDelete(ws);
                        }}
                        className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-all hover:bg-accent-red/15 hover:text-accent-red group-hover:opacity-100 focus:opacity-100"
                        title="Remove workspace"
                        aria-label={`Remove workspace ${ws.name}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Remove workspace confirmation dialog */}
      <AlertDialog open={!!workspaceToDelete} onOpenChange={(open) => {
        if (!open) {
          setWorkspaceToDelete(null);
        }
      }}>
        <AlertDialogContent className="dialog-panel rounded-lg text-foreground">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[11px] font-semibold uppercase tracking-[0.1em]">Remove workspace?</AlertDialogTitle>
            <AlertDialogDescription className="text-[10px] text-muted-foreground">
              {workspaceToDelete?.isActive
                ? `"${workspaceToDelete.name}" is currently active. Removing it will leave the app with no active workspace. This action cannot be undone.`
                : `This will remove "${workspaceToDelete?.name ?? ""}" from Rapa. This action cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className="bg-transparent border-border/50 text-[10px] font-semibold uppercase tracking-[0.06em] text-foreground hover:bg-accent"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleConfirmDeleteWorkspace()}
              disabled={deletingWorkspace}
              className="bg-accent-red text-[10px] font-semibold uppercase tracking-[0.06em] text-background hover:bg-accent-red/80 disabled:opacity-50"
            >
              {deletingWorkspace ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create workspace dialog (replaces the removed WorkspaceSelector container) */}
      <Dialog open={showCreateWorkspace} onOpenChange={(open) => {
        if (!open) {
          setShowCreateWorkspace(false);
          setNewWorkspace({ name: "", path: "" });
          setPendingMode(null);
        }
      }}>
        <DialogContent className="dialog-panel rounded-lg text-foreground">
          <DialogHeader>
            <DialogTitle className="text-[11px] font-semibold uppercase tracking-[0.1em]">
              {pendingMode === "agent"
                ? "Create workspace for Agent mode"
                : pendingMode === "plan"
                ? "Create workspace for Plan mode"
                : "New Workspace"}
            </DialogTitle>
            <DialogDescription className="text-[10px] text-muted-foreground">
              {pendingMode === "agent"
                ? "Agent mode reads files and applies edits inside a workspace directory."
                : pendingMode === "plan"
                ? "Plan mode inspects your workspace context to draft a multi-step plan."
                : "Give the workspace a name and pick a folder on disk. Threads will be scoped to it."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Name</label>
              <input
                value={newWorkspace.name}
                onChange={(e) => setNewWorkspace((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="My project"
                className="h-8 w-full rounded-md border border-border/50 bg-card-2/50 px-3 text-[11px] text-foreground placeholder-muted-foreground focus:border-border focus:outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Folder path</label>
              <div className="flex gap-2">
                <input
                  value={newWorkspace.path}
                  onChange={(e) => setNewWorkspace((prev) => ({ ...prev, path: e.target.value }))}
                  placeholder="C:\Users\you\Projects\my-project"
                  className="h-8 flex-1 rounded-md border border-border/50 bg-card-2/50 px-3 text-[11px] text-foreground placeholder-muted-foreground focus:border-border focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handleBrowseFolder()}
                  disabled={browsingFolder}
                  className="rounded-md border border-border/50 bg-transparent px-3 text-[10px] font-semibold uppercase tracking-[0.06em] text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                >
                  {browsingFolder ? "..." : "Browse"}
                </button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => {
                setShowCreateWorkspace(false);
                setNewWorkspace({ name: "", path: "" });
                setPendingMode(null);
              }}
              className="rounded-md border border-border/50 bg-transparent px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-foreground transition-colors hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleCreateWorkspace()}
              disabled={creatingWorkspace}
              className="rounded-md bg-accent-green px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-background transition-colors hover:bg-accent-green/80 disabled:opacity-50"
            >
              {creatingWorkspace
                ? "Creating..."
                : pendingMode
                ? `Create & Enter ${pendingMode === "agent" ? "Agent" : "Plan"}`
                : "Create Workspace"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
