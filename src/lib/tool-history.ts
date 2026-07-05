// Tool execution history management utilities

export type ToolCategory = "filesystem" | "shell" | "web" | "system" | "code" | "agent";

export type ToolExecutionStatus = "success" | "error" | "pending";

export type ToolExecution = {
  id: string;
  toolName: string;
  category: ToolCategory;
  timestamp: Date;
  status: ToolExecutionStatus;
  params: Record<string, unknown>;
  result?: unknown;
  undoable: boolean;
  undone?: boolean;
  previousContent?: string; // For file operations
};

// Tools that can be undone
const UNDOABLE_TOOLS: Record<string, ToolCategory> = {
  write_file: "filesystem",
  create_file: "filesystem",
  create_directory: "filesystem",
  delete_file: "filesystem",
  replace_in_file: "filesystem"
};

// Tool category mappings
const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  // Filesystem tools
  write_file: "filesystem",
  create_file: "filesystem",
  read_file: "filesystem",
  read_image: "filesystem",
  delete_file: "filesystem",
  list_dir: "filesystem",
  list_directory: "filesystem",
  create_directory: "filesystem",
  mkdir: "filesystem",
  replace_in_file: "filesystem",
  edit_file: "filesystem",
  append_file: "filesystem",
  rename_file: "filesystem",
  search_files: "filesystem",
  search_content: "filesystem",
  
  // Shell tools
  execute_command: "shell",
  run_command: "shell",
  start_process: "shell",
  stop_process: "shell",
  list_processes: "shell",
  get_process_output: "shell",
  
  // Web tools
  fetch_url: "web",
  web_search: "web",
  http_request: "web",
  
  // System tools
  get_workspace: "system",
  select_workspace: "system",
  think: "system",
  ask_user: "system",
  summarize_progress: "system",
  summarize_conversation: "system",
  read_lints: "system",
  run_tests: "system",
  
  // Code tools
  analyze_code: "code",
  format_code: "code",
  delegate_task: "code",
  
  // Agent tools (sub-agent spawning)
  spawn_agent: "agent",
  send_message_to_agent: "agent",
  cancel_agent: "agent",
  get_agent_status: "agent",

  // Git tools
  git_status: "code",
  git_diff: "code",
  git_log: "code",
  git_branch: "code",
  git_commit: "code"
};

/**
 * Generate a unique ID for a tool execution
 */
function generateId(): string {
  return `exec-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get the category for a tool
 */
export function getToolCategory(toolName: string): ToolCategory {
  return TOOL_CATEGORIES[toolName] ?? "system";
}

/**
 * Check if a tool can be undone
 */
export function canUndoTool(toolName: string): boolean {
  return toolName in UNDOABLE_TOOLS;
}

/**
 * Get list of all undoable tool names
 */
export function getUndoableTools(): string[] {
  return Object.keys(UNDOABLE_TOOLS);
}

/**
 * Create a new tool execution record
 */
export function createToolExecution(
  toolName: string,
  category: ToolCategory | string,
  params: Record<string, unknown>,
  previousContent?: string
): ToolExecution {
  const resolvedCategory = (
    category in ["filesystem", "shell", "web", "system", "code", "agent"]
      ? category
      : getToolCategory(toolName)
  ) as ToolCategory;

  return {
    id: generateId(),
    toolName,
    category: resolvedCategory,
    timestamp: new Date(),
    status: "pending",
    params,
    undoable: canUndoTool(toolName),
    previousContent
  };
}

/**
 * Update an existing tool execution record
 * Returns a new object with the updates applied
 */
export function updateToolExecution(
  execution: ToolExecution,
  updates: Partial<ToolExecution>
): ToolExecution {
  return {
    ...execution,
    ...updates
  };
}

/**
 * Format a relative timestamp (e.g., "2 min ago")
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 5) {
    return "just now";
  }
  if (diffSec < 60) {
    return `${diffSec} sec ago`;
  }
  if (diffMin < 60) {
    return `${diffMin} min ago`;
  }
  if (diffHour < 24) {
    return `${diffHour} hour${diffHour > 1 ? "s" : ""} ago`;
  }
  return `${diffDay} day${diffDay > 1 ? "s" : ""} ago`;
}

/**
 * Get icon name for a tool category
 */
export function getCategoryIcon(category: ToolCategory): string {
  switch (category) {
    case "filesystem":
      return "FolderOpen";
    case "shell":
      return "Terminal";
    case "web":
      return "Globe";
    case "system":
      return "Settings";
    case "code":
      return "Code";
    case "agent":
      return "Bot";
    default:
      return "Wrench";
  }
}

/**
 * Filter executions by category
 */
export function filterExecutionsByCategory(
  executions: ToolExecution[],
  category: ToolCategory | "all"
): ToolExecution[] {
  if (category === "all") {
    return executions;
  }
  return executions.filter((exec) => exec.category === category);
}

/**
 * Sort executions by timestamp (newest first)
 */
export function sortExecutionsByTime(executions: ToolExecution[]): ToolExecution[] {
  return [...executions].sort(
    (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
  );
}
