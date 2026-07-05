import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense, type ReactNode } from "react";
import { ArrowDown } from "lucide-react";
import { useLocation, useNavigate, Navigate, Outlet } from "react-router";

import { Sidebar } from "./components/sidebar";
import { TopBar } from "./components/top-bar";
import { ChatInput } from "./components/chat-input";
import { MessageList } from "./components/chat/message-list";
import { ConversationSearch } from "./components/conversation-search";
import { RightSidebar } from "./components/right-sidebar";
import { AgentRunComparison } from "./components/agent-run-comparison";
import { TerminalDialog } from "./components/terminal-dialog";
import { GoToFileDialog, FindInFilesDialog } from "./components/command-palette";
import { getConversationMessages, type ChatAttachment, type ReasoningEffort } from "../lib/api";
import { listAgentRuns, type AgentRunSummary } from "../lib/agent-api";
import { useAgentSettings } from "../lib/agent-settings";
import { useKeyboardShortcuts } from "./hooks/use-keyboard-shortcuts";
import { useChatStream } from "./hooks/use-chat-stream";
import { getActiveWorkspace, type Workspace } from "../lib/workspace-api";
import { AuthProvider, useAuth } from "./hooks/use-auth";

import type { ChatMode, ChatMessage, ApiKeySwitchNotice } from "./types/chat";
import { RESUMABLE_RUN_STATUSES, } from "./types/chat";
import { getInputDockShellClass } from "./utils/layout";
import { formatErrorState, mapConversationToMessages, estimateTokens } from "./utils/chat-utils";

/* ---- Lazy-loaded pages ---- */

const LoginPage = lazy(() => import("./components/login-page").then(m => ({ default: m.LoginPage })));
const SettingsPage = lazy(() => import("./components/settings-page").then(m => ({ default: m.SettingsPage })));
const AddCustomProvider = lazy(() => import("./components/add-custom-provider").then(m => ({ default: m.AddCustomProvider })));
const UsageAnalyticsPage = lazy(() => import("./components/usage-analytics-page").then(m => ({ default: m.UsageAnalyticsPage })));
const AgentSpecialistsPage = lazy(() => import("./components/agent-specialists-page").then(m => ({ default: m.AgentSpecialistsPage })));
const AgentSettingsPage = lazy(() => import("./components/agent-settings-page").then(m => ({ default: m.AgentSettingsPage })));
const ServiceKeysSettings = lazy(() => import("./components/service-keys-settings").then(m => ({ default: m.ServiceKeysSettings })));
const AppearancePage = lazy(() => import("./components/appearance-page").then(m => ({ default: m.AppearancePage })));

/* ------------------------------------------------------------------ */
/*  Layout                                                             */
/* ------------------------------------------------------------------ */

type RightSidebarTab = "tools" | "files" | "todos";

type LayoutProps = {
  children: ReactNode;
  hideModelSelector?: boolean;
  mode?: ChatMode;
  onModeChange?: (mode: ChatMode) => void;
  onExport?: () => void;
  onNewChat?: () => void;
  conversationWorkspace?: { id: string; name: string; path: string } | null;
  onSearchOpen?: () => void;
  // Tier 4 — Go-to-file and Find-in-files openers, controlled by
  // the parent (Home). Layout's keyboard shortcuts call these so
  // Ctrl+P / Ctrl+Shift+F open the dialogs. Mirrors onSearchOpen.
  onOpenGoToFile?: () => void;
  onOpenFindInFiles?: () => void;
  onOpenTerminal?: () => void;
  rightTab?: RightSidebarTab | null;
  onRightTabChange?: (tab: RightSidebarTab) => void;
  onRightClose?: () => void;
  rightSidebarMessages?: ChatMessage[];
  rightSidebarWorkspaceId?: string | null;
  rightSidebarWorkspaceName?: string;
};

const Layout = ({ children, hideModelSelector = false, mode = "chat", onModeChange, onExport, onNewChat, conversationWorkspace, onSearchOpen, onOpenGoToFile, onOpenFindInFiles, onOpenTerminal, rightTab, onRightTabChange, onRightClose, rightSidebarMessages, rightSidebarWorkspaceId, rightSidebarWorkspaceName }: LayoutProps) => {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const navigate = useNavigate();

  useKeyboardShortcuts([
    {
      key: "\\",
      ctrlOrCmd: true,
      action: () => setIsSidebarCollapsed((prev) => !prev)
    },
    {
      key: "n",
      ctrlOrCmd: true,
      action: () => {
        if (onNewChat) {
          onNewChat();
        } else {
          navigate("/");
        }
      }
    },
    {
      key: "k",
      ctrlOrCmd: true,
      action: () => onSearchOpen?.()
    },
    // Tier 4 — Go-to-file (Ctrl+P) and Find-in-files (Ctrl+Shift+F).
    // These also flip the right sidebar to the Files tab so the user
    // can see the tree as context while navigating.
    {
      key: "p",
      ctrlOrCmd: true,
      action: () => {
        onOpenGoToFile?.();
        onRightTabChange?.("files");
      }
    },
    {
      key: "f",
      ctrlOrCmd: true,
      shift: true,
      action: () => {
        onOpenFindInFiles?.();
        onRightTabChange?.("files");
      }
    }
  ]);

  return (
    <div className="flex w-full h-screen bg-background text-foreground overflow-hidden">
      <aside className="h-full p-2 pr-0" aria-label="Sidebar">
        <Sidebar
          collapsed={isSidebarCollapsed}
          onToggleCollapse={() => setIsSidebarCollapsed((prev) => !prev)}
          onNewChat={onNewChat}
        />
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar hideModelSelector={hideModelSelector} mode={mode} onModeChange={onModeChange} onExport={onExport} conversationWorkspace={conversationWorkspace} onSearchOpen={onSearchOpen} onOpenTerminal={onOpenTerminal} />
        <main className="flex-1 flex flex-col min-h-0">{children}</main>
      </div>
      {rightTab && onRightTabChange && onRightClose && (
        <aside className="h-full p-2 pl-0" aria-label="Right sidebar">
          <RightSidebar
            activeTab={rightTab}
            onTabChange={onRightTabChange}
            onClose={onRightClose}
            messages={rightSidebarMessages ?? []}
            workspaceId={rightSidebarWorkspaceId ?? null}
            workspaceName={rightSidebarWorkspaceName}
          />
        </aside>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Home                                                               */
/* ------------------------------------------------------------------ */

const Home = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "Hello! I am Rapa, your AI assistant from SideQuest Team. How can I help you today?"
    }
  ]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [selectedProvider, setSelectedProvider] = useState("gemini");
  const [selectedModel, setSelectedModel] = useState("gemini-3.1-flash-lite-preview");
  // Reasoning / thinking-mode effort. "off" means "don't add any
  // reasoning parameter — let the provider default" (the safest choice
  // for a fresh conversation). Persisted per-conversation via the
  // `Message.reasoningEffort` column restored on reopen.
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<ReasoningEffort>("off");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [mode, setMode] = useState<ChatMode>("chat");
  const [approvalBusyIds, setApprovalBusyIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [apiKeySwitchNotice, setApiKeySwitchNotice] = useState<ApiKeySwitchNotice | null>(null);
  const [resumableRun, setResumableRun] = useState<AgentRunSummary | null>(null);
  const [dismissedResumeRunId, setDismissedResumeRunId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [inputDockHeight, setInputDockHeight] = useState(176);
  const [activeWorkspace, setActiveWorkspace] = useState<Workspace | null>(null);
  const [conversationWorkspace, setConversationWorkspace] = useState<{
    id: string;
    name: string;
    path: string;
  } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // Tier 4 — Go-to-file (Ctrl+P) and Find-in-files (Ctrl+Shift+F).
  // Both dialogs dispatch a `workspace:open-file` event with the
  // selected path; the file tree listens for it and opens the file
  // in its viewer.
  const [goToFileOpen, setGoToFileOpen] = useState(false);
  const [findInFilesOpen, setFindInFilesOpen] = useState(false);
  const [rightTab, setRightTab] = useState<RightSidebarTab | null>("files");
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [comparisonRunIds, _setComparisonRunIds] = useState<[string | null, string | null]>([null, null]);
  // Terminal dialog — opens a real PTY-backed terminal scoped to the
  // active workspace's cwd and the current conversation's session id,
  // so closing and re-opening the dialog reuses the same shell (history
  // is preserved) while switching conversations starts a fresh one.
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalMinimized, setTerminalMinimized] = useState(false);
  // When the user right-clicks a folder in the file tree and picks
  // "Open in terminal", we stash the workspace-relative path here so
  // TerminalDialog can pre-pin a new tab to that directory. Cleared
  // after the dialog consumes it.
  const [pendingTerminalCwd, setPendingTerminalCwd] = useState<string | null>(null);

  const { settings: agentSettings } = useAgentSettings();
  const { showThinking } = agentSettings;
  const formattedError = error ? formatErrorState(error) : null;

  /* --- Active workspace tracking --- */

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const ws = await getActiveWorkspace();
        if (!cancelled) setActiveWorkspace(ws);
      } catch {
        if (!cancelled) setActiveWorkspace(null);
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

  const location = useLocation();
  const navigate = useNavigate();
  const selectedConversationId = new URLSearchParams(location.search).get("c") ?? undefined;
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const inputDockRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const isSwitchScrollingRef = useRef(false);
  const switchScrollRafRef = useRef<number | null>(null);
  const isNewConversationView = !selectedConversationId && messages.length === 0;
  const messageFadeGap = isNewConversationView ? 0 : 56;

  /* --- Streaming hook (all stream/approval/regenerate/fork logic) --- */
  const {
    pending,
    reconnecting,
    isStreamingRef,
    submitPrompt,
    handleStopGeneration,
    handleAgentToolApproval,
    handleModeSwitchApproval,
    handleRegenerate,
    handleResumeRun,
    handleFork,
    resetStreamState,
  } = useChatStream({
    conversationId,
    selectedConversationId,
    selectedProvider,
    selectedModel,
    selectedReasoningEffort,
    mode,
    workspaceId: conversationWorkspace?.id ?? activeWorkspace?.id,
    messages,
    setMessages,
    setConversationId,
    setSelectedProvider,
    setSelectedModel,
    setError,
    setApiKeySwitchNotice,
    setMode,
    setApprovalBusyIds,
  });

  /* --- Scroll helpers --- */

  const scrollToContainerEnd = (behavior: ScrollBehavior = "smooth") => {
    const node = scrollContainerRef.current;
    if (!node) {
      bottomRef.current?.scrollIntoView({ behavior, block: "end" });
      return;
    }
    const targetTop = Math.max(0, node.scrollHeight - node.clientHeight);
    node.scrollTo({ top: targetTop, behavior });
  };

  const smoothScrollToContainerEnd = (durationMs = 700) => {
    const node = scrollContainerRef.current;
    if (!node) {
      scrollToContainerEnd("smooth");
      isSwitchScrollingRef.current = false;
      return;
    }
    if (switchScrollRafRef.current !== null) {
      cancelAnimationFrame(switchScrollRafRef.current);
      switchScrollRafRef.current = null;
    }
    const startTop = node.scrollTop;
    const targetTop = Math.max(0, node.scrollHeight - node.clientHeight);
    if (Math.abs(targetTop - startTop) < 1) {
      scrollToContainerEnd("auto");
      isSwitchScrollingRef.current = false;
      return;
    }
    const startTime = performance.now();
    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const step = (now: number) => {
      const progress = Math.min(1, (now - startTime) / durationMs);
      const eased = easeInOutCubic(progress);
      node.scrollTop = startTop + (targetTop - startTop) * eased;
      if (progress < 1) {
        switchScrollRafRef.current = requestAnimationFrame(step);
        return;
      }
      switchScrollRafRef.current = null;
      scrollToContainerEnd("auto");
      isSwitchScrollingRef.current = false;
    };
    switchScrollRafRef.current = requestAnimationFrame(step);
  };

  /* --- Auto-scroll effect --- */

  useEffect(() => {
    if (!shouldAutoScrollRef.current || isSwitchScrollingRef.current) return;
    const behavior: ScrollBehavior = pending ? "smooth" : "auto";
    scrollToContainerEnd(behavior);
    requestAnimationFrame(() => scrollToContainerEnd("auto"));
    window.setTimeout(() => scrollToContainerEnd("auto"), 120);
  }, [messages, pending, inputDockHeight]);

  useEffect(() => {
    return () => {
      if (switchScrollRafRef.current !== null) cancelAnimationFrame(switchScrollRafRef.current);
    };
  }, []);

  /* --- Input dock resize observer --- */

  useEffect(() => {
    const node = inputDockRef.current;
    if (!node) return;
    const update = () => setInputDockHeight(node.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [isNewConversationView]);

  /* --- Load conversation on URL change --- */

  useEffect(() => {
    let mounted = true;

    const loadConversation = async () => {
      if (isStreamingRef.current) return;

      setError(null);
      setApiKeySwitchNotice(null);
      setResumableRun(null);
      setDismissedResumeRunId(null);
      setApprovalBusyIds([]);

      if (!selectedConversationId) {
        isSwitchScrollingRef.current = false;
        if (switchScrollRafRef.current !== null) {
          cancelAnimationFrame(switchScrollRafRef.current);
          switchScrollRafRef.current = null;
        }
        shouldAutoScrollRef.current = true;
        setShowScrollToBottom(false);
        setConversationId(undefined);
        setConversationWorkspace(null);
        setMessages([]);
        return;
      }

      try {
        const data = await getConversationMessages(selectedConversationId);
        if (!mounted) return;

        isSwitchScrollingRef.current = true;
        shouldAutoScrollRef.current = true;
        setShowScrollToBottom(false);
        setConversationId(selectedConversationId);
        setMessages(mapConversationToMessages(data.messages));

        // Restore the workspace context bound to this conversation
        if (data.workspaceId && data.workspace) {
          setConversationWorkspace({
            id: data.workspaceId,
            name: data.workspace.name,
            path: data.workspace.path,
          });
        } else {
          setConversationWorkspace(null);
        }

        const node = scrollContainerRef.current;
        node?.scrollTo({ top: 0, behavior: "auto" });
        requestAnimationFrame(() => smoothScrollToContainerEnd(720));
        window.setTimeout(() => {
          scrollToContainerEnd("auto");
          isSwitchScrollingRef.current = false;
        }, 860);

        const latestPersistedMessage = [...data.messages].reverse().find((row) => row.role === "user" || row.role === "assistant");
        if (latestPersistedMessage?.model) setSelectedModel(latestPersistedMessage.model);
        if (latestPersistedMessage?.provider) setSelectedProvider(latestPersistedMessage.provider);
        // Restore the reasoning effort the user had on the most recent
        // turn. Older messages (before this column existed) have null
        // — fall back to "off" (provider default) so the user's last
        // explicit choice isn't silently overridden.
        if (latestPersistedMessage?.reasoningEffort) {
          setSelectedReasoningEffort(latestPersistedMessage.reasoningEffort);
        }
      } catch {
        if (!mounted) return;
        setError("Failed to load conversation messages");
      }
    };

    void loadConversation();
    return () => { mounted = false; };
  }, [selectedConversationId]);

  /* --- Resumable run detection --- */

  useEffect(() => {
    setDismissedResumeRunId(null);
    if (!conversationId) setResumableRun(null);
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;
    if (!conversationId || pending) {
      if (!conversationId) setResumableRun(null);
      return () => { cancelled = true; };
    }
    listAgentRuns({ conversationId, limit: 5 })
      .then(({ runs }) => {
        if (cancelled) return;
        const latestRun = runs[0];
        const nextRun = latestRun && RESUMABLE_RUN_STATUSES.has(latestRun.status) ? latestRun : null;
        setResumableRun(nextRun);
      })
      .catch(() => {
        if (!cancelled) setResumableRun(null);
      });
    return () => { cancelled = true; };
  }, [conversationId, pending]);

  /* --- Scroll event handler --- */

  const handleScroll = () => {
    const node = scrollContainerRef.current;
    if (!node) return;
    const dockOffset = isNewConversationView ? 0 : inputDockHeight;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    const nearBottom = distanceFromBottom <= dockOffset + 40;
    shouldAutoScrollRef.current = nearBottom;
    setShowScrollToBottom(!nearBottom);
  };

  const scrollToBottom = () => {
    shouldAutoScrollRef.current = true;
    scrollToContainerEnd("smooth");
    window.setTimeout(() => scrollToContainerEnd("auto"), 520);
    setShowScrollToBottom(false);
  };

  /* --- Message edit handlers --- */

  const handleEdit = useCallback((messageId: string, currentContent: string) => {
    setEditingMessageId(messageId);
    setEditDraft(currentContent);
  }, []);

  const handleDraftChange = useCallback((content: string) => {
    setEditDraft(content);
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (!editingMessageId) return;
    const nextContent = editDraft.trim();
    if (!nextContent) return;
    setMessages((prev) =>
      prev.map((message) => {
        if (message.id !== editingMessageId) return message;
        if (message.role === "assistant") {
          return {
            ...message,
            content: nextContent,
            stats: {
              tokensPerSec: message.stats?.tokensPerSec ?? 0,
              totalTokens: estimateTokens(nextContent)
            }
          };
        }
        return { ...message, content: nextContent };
      })
    );
    setEditingMessageId(null);
    setEditDraft("");
  }, [editDraft, editingMessageId]);

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setEditDraft("");
  }, []);

  const handleDelete = useCallback((messageId: string) => {
    setMessages((prev) => prev.filter((message) => message.id !== messageId));
    if (editingMessageId === messageId) {
      setEditingMessageId(null);
      setEditDraft("");
    }
  }, [editingMessageId]);

  const handleCopy = useCallback(async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      setError("Failed to copy message");
    }
  }, []);

  const handleSearchNavigate = useCallback((messageId: string) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    // Find the message element by data attribute
    const el = container.querySelector(`[data-message-id="${messageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Flash highlight
      (el as HTMLElement).classList.add("ring-1", "ring-accent-blue/50");
      setTimeout(() => {
        (el as HTMLElement).classList.remove("ring-1", "ring-accent-blue/50");
      }, 2000);
    }
  }, []);

  /* --- Submit / Export / New Chat --- */

  const handleSubmit = useCallback(async (prompt: string, attachments: ChatAttachment[] = []) => {
    await submitPrompt(prompt, attachments);
  }, [submitPrompt]);

  const handleMessageReplySubmit = useCallback((prompt: string) => {
    void handleSubmit(prompt);
  }, [handleSubmit]);

  const handleResumeActiveRun = useCallback(() => {
    void handleResumeRun(resumableRun);
  }, [handleResumeRun, resumableRun]);

  const handleDismissResume = useCallback((runId: string) => {
    setDismissedResumeRunId(runId);
  }, []);

  const handleExport = () => {
    if (messages.length === 0) return;

    const projectName = conversationWorkspace?.name || "workspace";
    const lines: string[] = [
      `# ${projectName.toUpperCase().replace(/[^A-Z0-9]/g, "-")}`,
      ``,
      `**Exported:** ${new Date().toISOString()}`,
      ``,
      `**Project:** ${projectName}`,
      ``,
      `---`,
      ``,
      `## ${projectName.toUpperCase().replace(/[^A-Z0-9]/g, "-")}`,
      ``
    ];

    for (const m of messages) {
      if (m.role === "user") {
        lines.push(`### **You**`, ``, m.content, ``);
      } else {
        lines.push(`### **Assistant**`, ``);

        // Walk through agent steps chronologically: thinking → tool calls
        if (m.agentSteps) {
          for (const step of m.agentSteps) {
            // Thinking/reasoning for this iteration
            if (step.reasoning) {
              lines.push(`#### Thinking`, ``, step.reasoning, ``);
            }

            // Tool calls for this iteration
            for (let i = 0; i < step.toolCalls.length; i++) {
              const call = step.toolCalls[i];
              const result = step.toolResults[i];
              lines.push(`#### Tool: ${call.name}`, ``);

              // Input
              lines.push(`**Input:**`, ``, "```json", JSON.stringify(call.parameters, null, 2), "```", ``);

              // Output
              if (result) {
                const outputParts: string[] = [];
                if (result.output) outputParts.push(result.output);
                if (result.error) outputParts.push(`Error: ${result.error}`);
                if (result.data && !result.output && !result.error) {
                  outputParts.push(typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2));
                }
                const outputText = outputParts.join("\n") || (result.success ? "Success" : "Failed");
                const truncated = outputText.length > 2000
                  ? `${outputText.slice(0, 2000)}\n... [truncated ${outputText.length - 2000} chars]`
                  : outputText;
                lines.push(`**Output:**`, ``, "```json", truncated, "```", ``);
              }
            }

            // Step response (if different from final content and not empty)
            if (step.response && step.response !== m.content && step.response.trim()) {
              lines.push(`#### Response`, ``, step.response, ``);
            }
          }
        }

        // Live reasoning if no agent steps captured it
        if (!m.agentSteps?.length && m.liveReasoning) {
          lines.push(`#### Thinking`, ``, m.liveReasoning, ``);
        }

        // Final assistant response (the main content)
        let displayContent = m.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        if (!displayContent && m.agentSteps?.length) {
          const lastStep = m.agentSteps[m.agentSteps.length - 1];
          if (lastStep?.response) displayContent = lastStep.response;
        }
        if (displayContent) {
          lines.push(displayContent, ``);
        }
      }

      lines.push(`---`, ``);
    }

    const md = lines.join("\n");
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${projectName.toUpperCase().replace(/[^A-Z0-9]/g, "-")}_${new Date().toISOString().slice(0, 16).replace(":", "-")}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleOpenTerminal = useCallback(() => {
    setTerminalOpen(true);
    setTerminalMinimized(false);
  }, []);
  const handleCloseTerminal = useCallback(() => {
    setTerminalOpen(false);
    setTerminalMinimized(false);
  }, []);

  // Cross-component bridge: the file tree (and any future surface) can
  // request that the terminal panel open by dispatching
  //   window.dispatchEvent(new CustomEvent("workspace:open-terminal", { detail: { cwd } }))
  // The `cwd` is the workspace-relative directory to spawn the shell in
  // (or undefined for the workspace root). We use the same
  // handleOpenTerminal as the top-bar button, so the terminal always
  // opens in the same state (un-minimized, focused).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { cwd?: string } | undefined;
      setPendingTerminalCwd(detail?.cwd ?? null);
      handleOpenTerminal();
    };
    window.addEventListener("workspace:open-terminal", handler);
    return () => {
      window.removeEventListener("workspace:open-terminal", handler);
    };
  }, [handleOpenTerminal]);

  const handleNewChat = () => {
    resetStreamState();
    setMessages([]);
    setConversationId(undefined);
    setConversationWorkspace(null);
    setError(null);
    setApiKeySwitchNotice(null);
    setResumableRun(null);
    setDismissedResumeRunId(null);
    setApprovalBusyIds([]);
    isSwitchScrollingRef.current = false;
    if (switchScrollRafRef.current !== null) {
      cancelAnimationFrame(switchScrollRafRef.current);
      switchScrollRafRef.current = null;
    }
    shouldAutoScrollRef.current = true;
    setShowScrollToBottom(false);
    if (location.pathname !== "/" || location.search) {
      navigate("/", { replace: true });
    }
  };

  /* --- JSX --- */

  return (
    <Layout
      mode={mode}
      onModeChange={setMode}
      onExport={handleExport}
      onNewChat={handleNewChat}
      conversationWorkspace={conversationWorkspace}
      onSearchOpen={() => setSearchOpen(true)}
      onOpenGoToFile={() => setGoToFileOpen(true)}
      onOpenFindInFiles={() => setFindInFilesOpen(true)}
      onOpenTerminal={handleOpenTerminal}
      rightTab={rightTab}
      onRightTabChange={(tab) => setRightTab(tab)}
      onRightClose={() => setRightTab(null)}
      rightSidebarMessages={messages}
      rightSidebarWorkspaceId={conversationWorkspace?.id ?? activeWorkspace?.id ?? null}
      rightSidebarWorkspaceName={conversationWorkspace?.name ?? activeWorkspace?.name}
    >
      <div className="flex-1 flex flex-col min-h-0 relative bg-app">
        <div className="flex h-full min-h-0 flex-col">
          <section className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={scrollContainerRef}
              onScroll={handleScroll}
              role="log"
              aria-label="Chat messages"
              aria-live="polite"
              aria-atomic="false"
              className="flex-1 overflow-y-auto px-5 pt-5 [scrollbar-width:thin] [scrollbar-color:hsl(var(--muted))_transparent] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:bg-muted [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent relative"
              style={{ paddingBottom: isNewConversationView ? 24 : 0, marginBottom: isNewConversationView ? 0 : inputDockHeight + (terminalOpen && terminalMinimized ? 10 : 0) }}
            >
              {!isNewConversationView && (
                <div
                  className="sticky top-[-20px] z-10 w-full h-12 pointer-events-none bg-gradient-to-b to-transparent"
                  style={{ backgroundImage: "linear-gradient(to bottom, var(--fade-tint-strong), transparent)" }}
                />
              )}

              <MessageList
                messages={messages}
                pending={pending}
                reconnecting={reconnecting}
                mode={mode}
                editingMessageId={editingMessageId}
                editDraft={editDraft}
                approvalBusyIds={approvalBusyIds}
                showThinking={showThinking}
                workspaceName={conversationWorkspace?.name ?? activeWorkspace?.name}
                workspacePath={conversationWorkspace?.path ?? activeWorkspace?.path}
                apiKeySwitchNotice={apiKeySwitchNotice}
                resumableRun={resumableRun}
                dismissedResumeRunId={dismissedResumeRunId}
                formattedError={formattedError}
                bottomGap={messageFadeGap}
                onCopy={handleCopy}
                onStartEdit={handleEdit}
                onDraftChange={handleDraftChange}
                onSaveEdit={handleSaveEdit}
                onCancelEdit={handleCancelEdit}
                onDelete={handleDelete}
                onFork={handleFork}
                onRegenerate={handleRegenerate}
                onToolApproval={handleAgentToolApproval}
                onModeSwitchApproval={handleModeSwitchApproval}
                onResumeRun={handleResumeActiveRun}
                onDismissResume={handleDismissResume}
                onSubmit={handleMessageReplySubmit}
                onSetMode={setMode}
              />

              {!isNewConversationView && (
                <div className="sticky bottom-0 z-10 w-full h-0 pointer-events-none">
                  <div
                    className="absolute bottom-0 w-full h-12 to-transparent"
                    style={{ backgroundImage: "linear-gradient(to top, var(--fade-tint-strong), transparent)" }}
                  />
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {showScrollToBottom && !isNewConversationView ? (
              <div className="absolute inset-x-0 bottom-[220px] z-20">
                <div className="mx-auto flex w-full max-w-[800px] justify-center">
                  <button
                    onClick={scrollToBottom}
                    className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-border bg-card/95 text-muted-foreground shadow-elevated transition-colors hover:bg-accent hover:text-foreground"
                    title="Scroll to bottom"
                    type="button"
                  >
                    <ArrowDown size={16} />
                  </button>
                </div>
              </div>
            ) : null}

            <div
              ref={inputDockRef}
              role="region"
              aria-label="Message input"
              className={`absolute inset-x-0 z-20 transition-all duration-500 ease-in-out ${isNewConversationView ? "top-1/2 -translate-y-1/2" : "bottom-0 translate-y-0"}`}
              style={(!isNewConversationView && terminalOpen && terminalMinimized) ? { bottom: 10 } : undefined}
            >
              <div className={getInputDockShellClass(isNewConversationView)}>
                <div className="mx-auto w-full max-w-[720px]">
                  {isNewConversationView ? (
                    <h2 className="mb-5 text-center text-[32px] font-semibold tracking-tight text-foreground">
                      How can I help you today?
                    </h2>
                  ) : null}
                  <ChatInput
                    onSubmit={handleSubmit}
                    onStop={handleStopGeneration}
                    pending={pending}
                    selectedProvider={selectedProvider}
                    selectedModel={selectedModel}
                    onSelectProvider={setSelectedProvider}
                    onSelectModel={setSelectedModel}
                    selectedReasoningEffort={selectedReasoningEffort}
                    onSelectReasoningEffort={setSelectedReasoningEffort}
                  />
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* Overlays */}
      <ConversationSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        messages={messages}
        onNavigate={handleSearchNavigate}
      />
      {/* Tier 4 — Go-to-file (Ctrl+P) and Find-in-files (Ctrl+Shift+F).
          Both dialogs take the active workspace id; the file tree
          listens for `workspace:open-file` events to actually open
          the requested file in its viewer. */}
      <GoToFileDialog
        workspaceId={conversationWorkspace?.id ?? activeWorkspace?.id ?? null}
        open={goToFileOpen}
        onOpenChange={setGoToFileOpen}
        onFileOpen={(relativePath) => {
          window.dispatchEvent(
            new CustomEvent("workspace:open-file", { detail: { path: relativePath } })
          );
        }}
      />
      <FindInFilesDialog
        workspaceId={conversationWorkspace?.id ?? activeWorkspace?.id ?? null}
        open={findInFilesOpen}
        onOpenChange={setFindInFilesOpen}
        onFileOpen={(relativePath) => {
          window.dispatchEvent(
            new CustomEvent("workspace:open-file", { detail: { path: relativePath } })
          );
        }}
      />
      <AgentRunComparison
        open={comparisonOpen}
        onClose={() => setComparisonOpen(false)}
        leftRunId={comparisonRunIds[0]}
        rightRunId={comparisonRunIds[1]}
      />
      <TerminalDialog
        open={terminalOpen}
        minimized={terminalMinimized}
        onMinimize={() => setTerminalMinimized(true)}
        onRestore={() => setTerminalMinimized(false)}
        conversationId={conversationId}
        workspace={conversationWorkspace ?? activeWorkspace}
        pendingCwd={pendingTerminalCwd}
        onPendingCwdConsumed={() => setPendingTerminalCwd(null)}
      />
    </Layout>
  );
};

/* ------------------------------------------------------------------ */
/*  Settings                                                           */
/* ------------------------------------------------------------------ */

const Settings = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const settingsTab = useMemo<string>(() => {
    const tab = new URLSearchParams(location.search).get("tab");
    return tab || "usage";
  }, [location.search]);

  const handleProviderAdded = () => {
    navigate("/settings?tab=gemini");
    window.location.reload();
  };

  return (
    <Layout hideModelSelector>
      <div className="flex-1 min-w-0 min-h-0 flex bg-app overflow-hidden">
        <Suspense fallback={<div className="flex-1 flex items-center justify-center"><div className="animate-pulse text-muted">Loading...</div></div>}>
          {settingsTab === "usage" ? (
            <UsageAnalyticsPage />
          ) : settingsTab === "agent" ? (
            <AgentSettingsPage />
          ) : settingsTab === "skills" ? (
            <AgentSpecialistsPage />
          ) : settingsTab === "search" ? (
            <ServiceKeysSettings />
          ) : settingsTab === "appearance" ? (
            <AppearancePage />
          ) : settingsTab === "add-provider" ? (
            <AddCustomProvider onSuccess={handleProviderAdded} />
          ) : (
            <SettingsPage provider={settingsTab} />
          )}
        </Suspense>
      </div>
    </Layout>
  );
};

/* ------------------------------------------------------------------ */
/*  Auth guard                                                         */
/* ------------------------------------------------------------------ */

const AuthGuard = () => {
  const { token, isLoading } = useAuth();

  if (isLoading) {
    return <div className="flex h-screen w-full items-center justify-center bg-app text-white">Loading...</div>;
  }

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
};

const LoginRoute = () => (
  <AuthProvider>
    <LoginPage />
  </AuthProvider>
);

const ProtectedAuthGuard = () => (
  <AuthProvider>
    <AuthGuard />
  </AuthProvider>
);

export { Home, Settings, AuthGuard, LoginRoute, ProtectedAuthGuard };
