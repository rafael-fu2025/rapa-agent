// Tool registration and initialization
//
// Registers all native tools with the global tool registry. MCP tools
// (§3.1) are NOT registered here — they're added dynamically per-agent
// via `getAgentMcpToolsForUser()`. Plan mode + chat mode pick the right
// subset via `listForMode()`.

import { toolRegistry } from "../lib/tools.js";
import { AppendFileTool, EditFileTool, ReplaceInFileTool } from "./edit-file.js";
import {
  DeleteFileTool,
  ListDirectoryTool,
  MkdirTool,
  ReadFileTool,
  ReadImageTool,
  RenameFileTool,
  SearchContentTool,
  SearchFilesTool,
  WriteFileTool
} from "./filesystem.js";
import {
  ExecuteCommandTool,
  GetProcessOutputTool,
  ListProcessesTool,
  StartProcessTool,
  StopProcessTool
} from "./shell.js";
import { AddTaskTool, ListTasksTool, UpdateTaskTool } from "./tasks.js";
import { PlanTasksTool } from "./plan-tasks.js";
import { FetchUrlTool, WebSearchTool } from "./web.js";
import { ThinkTool, AskUserTool, SummarizeProgressTool, SummarizeConversationTool } from "./agent-tools.js";
import { ReadLintsTool, RunTestsTool } from "./diagnostics.js";
import {
  GitBranchTool,
  GitCommitTool,
  GitDiffTool,
  GitLogTool,
  GitStatusTool,
  ListChangedFilesTool
} from "./git.js";
import { DelegateTaskTool, SpawnAgentTool, SendMessageToAgentTool, CancelAgentTool, GetAgentStatusTool } from "./sub-agents.js";
import { UpdateWorkingMemoryTool } from "./working-memory.js";
import { SearchMemoryTool } from "./context-search.js";
import { PresentFileTool } from "./present-file.js";
import { ListNotificationChannelsTool, SendNotificationTool } from "./notifications.js";
import { CancelScheduledTaskTool, ListScheduledTasksTool, ScheduleTaskTool } from "./scheduler.js";
import { RenderWidgetTool } from "./widgets.js";
import { GenerateImageTool } from "./media.js";
import { CreateDocumentTool, ReadDocumentTool } from "./documents.js";
import {
  BrowserClickTool,
  BrowserEvaluateTool,
  BrowserNavigateTool,
  BrowserReadTool,
  BrowserTypeTool
} from "./browser.js";
import { SendEmailTool } from "./email.js";
import { McpCallTool, McpListServersTool } from "./mcp-passthrough.js";

let registered = false;

export function registerAllTools(): void {
  if (registered) return;

  // Filesystem tools
  toolRegistry.register(new ReadFileTool());
  toolRegistry.register(new ReadImageTool());
  toolRegistry.register(new WriteFileTool());
  toolRegistry.register(new ListDirectoryTool());
  toolRegistry.register(new SearchFilesTool());
  toolRegistry.register(new SearchContentTool());
  toolRegistry.register(new DeleteFileTool());
  toolRegistry.register(new RenameFileTool());
  toolRegistry.register(new MkdirTool());
  toolRegistry.register(new EditFileTool());
  toolRegistry.register(new ReplaceInFileTool());
  toolRegistry.register(new AppendFileTool());
  toolRegistry.register(new PresentFileTool());

  // Web tools
  toolRegistry.register(new FetchUrlTool());
  toolRegistry.register(new WebSearchTool());

  // Shell tools
  toolRegistry.register(new ExecuteCommandTool());
  toolRegistry.register(new StartProcessTool());
  toolRegistry.register(new StopProcessTool());
  toolRegistry.register(new ListProcessesTool());
  toolRegistry.register(new GetProcessOutputTool());

  // Execution task tools (§4.1: persistent via Prisma)
  toolRegistry.register(new AddTaskTool());
  toolRegistry.register(new UpdateTaskTool());
  toolRegistry.register(new ListTasksTool());
  toolRegistry.register(new PlanTasksTool());

  // Agent reasoning tools
  toolRegistry.register(new ThinkTool());
  toolRegistry.register(new AskUserTool());
  toolRegistry.register(new SummarizeProgressTool());
  toolRegistry.register(new SummarizeConversationTool());
  toolRegistry.register(new DelegateTaskTool());
  toolRegistry.register(new SpawnAgentTool());
  toolRegistry.register(new SendMessageToAgentTool());
  toolRegistry.register(new CancelAgentTool());
  toolRegistry.register(new GetAgentStatusTool());

  // Diagnostics tools (§4.3: configurable + sanitized env)
  toolRegistry.register(new ReadLintsTool());
  toolRegistry.register(new RunTestsTool());

  // Git tools (§4.4: added list_changed_files)
  toolRegistry.register(new GitStatusTool());
  toolRegistry.register(new GitDiffTool());
  toolRegistry.register(new GitLogTool());
  toolRegistry.register(new GitBranchTool());
  toolRegistry.register(new GitCommitTool());
  toolRegistry.register(new ListChangedFilesTool());

  // Context management tools
  toolRegistry.register(new UpdateWorkingMemoryTool());
  toolRegistry.register(new SearchMemoryTool());

  // §2.x — new tool categories
  // §2.5 widgets
  toolRegistry.register(new RenderWidgetTool());
  // §2.4 scheduler
  toolRegistry.register(new ScheduleTaskTool());
  toolRegistry.register(new ListScheduledTasksTool());
  toolRegistry.register(new CancelScheduledTaskTool());
  // §2.3 image generation
  toolRegistry.register(new GenerateImageTool());
  // §2.2 documents
  toolRegistry.register(new CreateDocumentTool());
  toolRegistry.register(new ReadDocumentTool());
  // §2.1 browser automation
  toolRegistry.register(new BrowserNavigateTool());
  toolRegistry.register(new BrowserReadTool());
  toolRegistry.register(new BrowserClickTool());
  toolRegistry.register(new BrowserTypeTool());
  toolRegistry.register(new BrowserEvaluateTool());

  // §3.x — platform integrations
  // §3.3 IM notifications
  toolRegistry.register(new SendNotificationTool());
  toolRegistry.register(new ListNotificationChannelsTool());
  // §3.2 email
  toolRegistry.register(new SendEmailTool());
  // §3.1 MCP
  toolRegistry.register(new McpListServersTool());
  toolRegistry.register(new McpCallTool());

  registered = true;
}

export { toolRegistry };
