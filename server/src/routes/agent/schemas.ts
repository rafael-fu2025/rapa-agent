// Zod schemas and constants for agent route validation.
// Extracted from routes/agent.ts to keep the main route file focused on
// handler logic.

import { z } from "zod";

export const attachmentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["image", "file"]),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  dataUrl: z.string().optional(),
  textContent: z.string().optional()
});

export const agentRequestSchema = z.object({
  prompt: z.string().min(1),
  provider: z.string().default("gemini"),
  model: z.string().optional(),
  mode: z.enum(["agent", "plan"]).default("agent"),
  conversationId: z.string().optional(),
  workspaceId: z.string().optional(),
  maxIterations: z.number().min(1).max(80).default(60),
  autoApproveTools: z.array(z.string()).default([]),
  // Shell-command sandbox strategy. "native" enforces the privilege-escalation
  // blocklist on the host; "docker" additionally runs commands inside an
  // ephemeral network-disabled container (lib/sandbox/); "off" disables both.
  // Threaded to tools via ToolExecutionContext.sandboxMode.
  sandboxMode: z.enum(["native", "docker", "off"]).optional(),
  // Composer permission ladder (ZCode/Claude-Code style). "autonomous"
  // auto-approves project-file categories; "full" approves every tool via
  // the "*" wildcard. Both keep the dangerous-command severity overlay and
  // the destructive/irreversible gate non-bypassable server-side.
  permissionMode: z.enum(["ask", "autonomous", "full"]).optional(),
  // LLM auto-approve classifier (lib/auto-approve-classifier.ts): when
  // enabled, shell approval requests are classified approve/deny/unsure
  // before pattern matching. Omit to rely on the
  // RAPA_AUTO_APPROVE_CLASSIFIER_MODEL env var.
  autoApproveClassifier: z.object({
    enabled: z.boolean().optional(),
    provider: z.string().optional(),
    model: z.string().optional()
  }).optional(),
  attachments: z.array(attachmentSchema).optional(),
  // Worktree-per-run isolation (Item 3). When true AND the resolved
  // workspace is a git repository, the run executes inside a dedicated
  // worktree (.rapa/worktrees/run-<short8>) on branch rapa/run-<short8>;
  // afterwards the user merges or discards it from the run banner.
  // Creation failure never fails the run — it falls back to the
  // original checkout.
  worktree: z.boolean().optional(),
  // Per-request reasoning depth. Translated to the provider's native
  // field shape by `server/src/lib/agent/reasoning-translator.ts`:
  //   - "off"    → don't add any reasoning parameter (provider default)
  //   - "low"    → light thinking, fastest + cheapest
  //   - "medium" → balanced (typical default for OpenAI o-series)
  //   - "high"   → deep thinking, slower, better for complex agentic work
  //   - "max"    → maximum effort (DeepSeek, Claude 4.7+ `max` maps to
  //                `high` because Anthropic only accepts low/medium/high)
  // Omit to let the provider default. This is the actual lever for
  // "thinking too much".
  reasoningEffort: z.enum(["off", "low", "medium", "high", "xhigh", "max", "ultra", "on"]).optional()
});

export const executeCommandSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().min(1000).max(300000).optional(),
  workspaceId: z.string().optional(),
  conversationId: z.string().optional(),
  sessionId: z.string().optional(),
  closeSession: z.boolean().optional()
});

export const validateToolSchema = z.object({
  name: z.string().min(1),
  parameters: z.record(z.unknown()).default({}),
  mode: z.enum(["chat", "agent", "plan"]).optional()
});

export const diagnosticsSchema = z.object({
  workspaceId: z.string().optional(),
  workdir: z.string().optional(),
  timeout: z.number().min(1000).max(600000).optional()
});

export const upsertAgentRuleSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  content: z.string().min(1),
  scope: z.enum(["global", "workspace", "conversation"]).default("workspace"),
  priority: z.number().int().min(0).max(100).default(50),
  enabled: z.boolean().default(true),
  workspaceId: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional()
});

export const upsertAgentSkillSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  source: z.string().optional(),
  version: z.string().optional(),
  enabled: z.boolean().default(true),
  config: z.record(z.unknown()).optional()
});

export const upsertMcpServerSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  endpoint: z.string().min(1),
  transport: z.enum(["sse", "ws", "http"]).default("http"),
  enabled: z.boolean().default(true),
  authType: z.enum(["none", "bearer", "basic", "apiKey"]).default("none"),
  config: z.record(z.unknown()).optional()
});

export const upsertAgentIntegrationSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  provider: z.string().min(1),
  type: z.enum(["deploy", "database"]).default("database"),
  enabled: z.boolean().default(true),
  status: z.enum(["disconnected", "connected", "error"]).default("disconnected"),
  metadata: z.record(z.unknown()).optional()
});

// Item 5 — lifecycle hooks. `event` mirrors the agent event-bus kinds the
// hook layer supports; `matchTool` narrows tools/tool/* hooks to one tool.
export const AGENT_HOOK_EVENTS = [
  "tools/tool/call",
  "tools/tool/result",
  "agent/turn/end"
] as const;

export const upsertAgentHookSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  event: z.enum(AGENT_HOOK_EVENTS),
  matchTool: z.string().optional(),
  action: z.enum(["shell", "http"]),
  target: z.string().min(1).max(2000),
  timeoutMs: z.number().int().min(1000).max(30000).default(5000),
  enabled: z.boolean().default(true)
});

export const hookParamsSchema = z.object({
  id: z.string().min(1)
});

export const approvalDecisionSchema = z.object({
  approvalId: z.string().min(1),
  approved: z.boolean(),
  message: z.string().optional()
});

export const agentRunsQuerySchema = z.object({
  conversationId: z.string().optional(),
  workspaceId: z.string().optional(),
  // `?includeCompleted=false` (default) hides terminal-status runs from the
  // workspace registry view. `?includeCompleted=true` returns the full
  // history (used by the dedicated runs view).
  includeCompleted: z.coerce.boolean().optional().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

export const agentRunParamsSchema = z.object({
  id: z.string().min(1)
});

// Item 3 — POST /agent/runs/:id/worktree/{merge,discard}
export const worktreeActionParamsSchema = z.object({
  id: z.string().min(1)
});

export const checkpointParamsSchema = z.object({
  id: z.string().min(1)
});

export const checkpointListSchema = z.object({
  workspaceId: z.string().optional(),
  runId: z.string().optional(),
  status: z.enum(["created", "restored", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0)
});

// "Alive" agent run statuses — anything in this set is considered
// in-flight and contributes to the per-workspace running count.
// Persisted by `persistAgentRun` in `lib/agent-run-store.ts`.
/** Tool categories auto-approved in "autonomous" permission mode — project
 *  file work without arbitrary-command risk. Shell, web, browser, media,
 *  email and MCP still require confirmation, and the dangerous-command
 *  severity overlay stays non-bypassable in every mode. */
export const AUTONOMOUS_AUTO_APPROVE_CATEGORIES = ["filesystem", "code", "document"] as const;

export const ACTIVE_RUN_STATUSES = ["pending", "resumed", "in_progress", "running"] as const;

export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const RESUMABLE_RUN_STATUSES = ["max_iterations", "failed", "interrupted"] as const;
export const AUTO_RESUME_PROMPT_PATTERN = /\b(continue|resume|proceed|keep going|go on|carry on|finish|pick up where you left off|where you left off|continue from|resume from|what remains|next step|keep working)\b/i;

export type AgentRequestPayload = z.infer<typeof agentRequestSchema>;

export type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};
