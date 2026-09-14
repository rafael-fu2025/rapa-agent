import { useEffect, useMemo, useState } from "react";
import { PanelRight, Wrench, FolderTree, ListTodo, Activity } from "lucide-react";
import { cn } from "../../lib/utils";
import { Hint } from "./ui/tooltip";
import { ToolHistoryContent } from "./tool-history-drawer";
import { WorkspaceFileTreeContent } from "./workspace-file-tree";
import { TaskList, extractTasks } from "./task-list";
import { RunsPanelContent } from "./runs-panel";
import type { ChatMessage } from "../types/chat";

export type RightSidebarTab = "tools" | "files" | "todos" | "runs";

type RightSidebarProps = {
  activeTab: RightSidebarTab;
  onTabChange: (tab: RightSidebarTab) => void;
  onClose: () => void;
  messages: ChatMessage[];
  workspaceId: string | null;
  workspaceName?: string;
  conversationId?: string;
  /** Opens the A/B comparison dialog for two selected runs. */
  onCompareRuns: (leftRunId: string, rightRunId: string) => void;
};

export function RightSidebar({
  activeTab,
  onTabChange,
  onClose,
  messages,
  workspaceId,
  workspaceName,
  conversationId,
  onCompareRuns,
}: RightSidebarProps) {
  // Collapsed state persists across reloads (audit M3).
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("rapa.rightSidebarCollapsed") === "1"; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem("rapa.rightSidebarCollapsed", collapsed ? "1" : "0"); } catch { /* ignore */ }
  }, [collapsed]);

  // Files opened via the palette (Ctrl+P / Find-in-Files) dispatch
  // `workspace:open-file`, whose only listener lives in the file tree
  // inside this panel — un-collapse so the event actually lands
  // somewhere visible (audit M3).
  useEffect(() => {
    const handler = () => setCollapsed(false);
    window.addEventListener("workspace:open-file", handler);
    return () => window.removeEventListener("workspace:open-file", handler);
  }, []);

  // Close on escape (skip if another overlay already handled it)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Extract tasks from the last assistant message with agent steps
  const { steps, liveToolCalls, isAgentActive, hasTasks } = useMemo(() => {
    let lastAssistant: ChatMessage | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && (messages[i].agentSteps?.length || messages[i].liveToolCalls?.length)) {
        lastAssistant = messages[i];
        break;
      }
    }
    const s = lastAssistant?.agentSteps ?? [];
    const ltc = lastAssistant?.liveToolCalls ?? [];
    const active = (lastAssistant?.liveToolCalls?.length ?? 0) > 0;
    const tasks = extractTasks(s, ltc);
    return { steps: s, liveToolCalls: ltc, isAgentActive: active, hasTasks: tasks.length > 0 };
  }, [messages]);

  // Auto-switch to todos tab when active tasks appear during agent execution
  useEffect(() => {
    if (hasTasks && isAgentActive && activeTab !== "todos") {
      onTabChange("todos");
    }
  // Only react to agent becoming active with tasks, not tab changes
  }, [hasTasks, isAgentActive]);

  const sectionTitle =
    activeTab === "tools" ? "Tool History"
    : activeTab === "files" ? "Workspace Files"
    : activeTab === "runs" ? "Agent Runs"
    : "Agent Plan";

  return (
    <div
      className={cn(
        "sidebar-panel h-full rounded-lg flex flex-col transition-[width] duration-200",
        collapsed ? "w-[72px]" : "w-[280px]"
      )}
    >
      {collapsed ? (
        <>
          {/* Collapsed: expand button + vertical tab icons */}
          <div className="flex items-center justify-center px-2 py-4">
            <Hint label="Expand sidebar">
              <button
                type="button"
                onClick={() => setCollapsed(false)}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <PanelRight size={18} className="rotate-180" />
              </button>
            </Hint>
          </div>

          <div className="px-2 space-y-0.5">
            {/* Tools icon */}
            <Hint label="Tool History">
              <button
                type="button"
                onClick={() => { onTabChange("tools"); setCollapsed(false); }}
                className={cn(
                  "flex w-full items-center justify-center rounded-lg px-2 py-2.5 transition-colors",
                  activeTab === "tools"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <Wrench size={18} />
              </button>
            </Hint>

            {/* Files icon */}
            <Hint label="Workspace Files">
              <button
                type="button"
                onClick={() => { onTabChange("files"); setCollapsed(false); }}
                className={cn(
                  "flex w-full items-center justify-center rounded-lg px-2 py-2.5 transition-colors",
                  activeTab === "files"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <FolderTree size={18} />
              </button>
            </Hint>

            {/* Todos icon */}
            <Hint label="Agent Plan">
              <button
                type="button"
                onClick={() => { onTabChange("todos"); setCollapsed(false); }}
                className={cn(
                  "relative flex w-full items-center justify-center rounded-lg px-2 py-2.5 transition-colors",
                  activeTab === "todos"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <ListTodo size={18} />
                {isAgentActive && hasTasks && (
                  <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-accent-blue animate-pulse" />
                )}
              </button>
            </Hint>

            {/* Runs icon */}
            <Hint label="Agent Runs">
              <button
                type="button"
                onClick={() => { onTabChange("runs"); setCollapsed(false); }}
                className={cn(
                  "flex w-full items-center justify-center rounded-lg px-2 py-2.5 transition-colors",
                  activeTab === "runs"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <Activity size={18} />
              </button>
            </Hint>
          </div>
        </>
      ) : (
        <>
          {/* Header */}
          <div className="px-3 pt-3 pb-2">
            {/* Tab row + collapse */}
            <div className="flex items-center justify-between px-1 pb-2">
              <div className="flex items-center gap-0">
                {/* Tools tab */}
                <Hint label="Tool History">
                  <button
                    type="button"
                    onClick={() => onTabChange("tools")}
                    className={cn(
                      "rounded-md p-2 transition-colors",
                      activeTab === "tools"
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
                    )}
                  >
                    <Wrench size={16} />
                  </button>
                </Hint>

                <span className="mx-1 h-5 w-px bg-card-hover" />

                {/* Files tab */}
                <Hint label="Workspace Files">
                  <button
                    type="button"
                    onClick={() => onTabChange("files")}
                    className={cn(
                      "rounded-md p-2 transition-colors",
                      activeTab === "files"
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
                    )}
                  >
                    <FolderTree size={16} />
                  </button>
                </Hint>

                <span className="mx-1 h-5 w-px bg-card-hover" />

                {/* Todos tab */}
                <Hint label="Agent Plan">
                  <button
                    type="button"
                    onClick={() => onTabChange("todos")}
                    className={cn(
                      "relative rounded-md p-2 transition-colors",
                      activeTab === "todos"
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
                    )}
                  >
                    <ListTodo size={16} />
                    {isAgentActive && hasTasks && (
                      <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-accent-blue animate-pulse" />
                    )}
                  </button>
                </Hint>

                <span className="mx-1 h-5 w-px bg-card-hover" />

                {/* Runs tab */}
                <Hint label="Agent Runs">
                  <button
                    type="button"
                    onClick={() => onTabChange("runs")}
                    className={cn(
                      "rounded-md p-2 transition-colors",
                      activeTab === "runs"
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
                    )}
                  >
                    <Activity size={16} />
                  </button>
                </Hint>
              </div>

              {/* Collapse button */}
              <Hint label="Collapse sidebar">
                <button
                  type="button"
                  onClick={() => setCollapsed(true)}
                  className="p-2 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <PanelRight size={16} />
                </button>
              </Hint>
            </div>

            {/* Section title */}
            <div className="px-1">
              <h2 className="font-mono-tech text-[11px] font-semibold text-foreground">
                {sectionTitle}
              </h2>
            </div>
          </div>

          {/* Content — render all three, hide inactive to preserve state */}
          <div className={cn("flex-1 min-h-0 flex flex-col", activeTab !== "tools" && "hidden")}>
            <ToolHistoryContent messages={messages} />
          </div>
          <div className={cn("flex-1 min-h-0 flex flex-col", activeTab !== "files" && "hidden")}>
            <WorkspaceFileTreeContent
              workspaceId={workspaceId}
              workspaceName={workspaceName}
            />
          </div>
          <div className={cn("flex-1 min-h-0 flex flex-col overflow-y-auto", activeTab !== "todos" && "hidden")}>
            <div className="p-2.5">
              <TaskList
                steps={steps}
                liveToolCalls={liveToolCalls}
                isAgentActive={isAgentActive}
                embedded
                showEmpty
              />
            </div>
          </div>
          <div className={cn("flex-1 min-h-0 flex flex-col", activeTab !== "runs" && "hidden")}>
            <RunsPanelContent conversationId={conversationId} onCompare={onCompareRuns} />
          </div>
        </>
      )}
    </div>
  );
}
