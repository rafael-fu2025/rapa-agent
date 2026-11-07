import type { AgentLiveToolCall, AgentStep } from "../../lib/agent-api";
import type { ReasoningEffort } from "../../lib/api";

export type ChatMode = "chat" | "agent" | "plan";

export type ChatMessage = {
  id: string;
  conversationId?: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: Date;
  model?: string;
  provider?: string;
  mode?: ChatMode;
  /// Reasoning / thinking-mode effort used to generate this message.
  /// Persisted to the `Message.reasoningEffort` column on the backend
  /// and restored when reopening the conversation so the same setting
  /// is reused on subsequent turns and on regenerate.
  reasoningEffort?: ReasoningEffort;
  agentRunId?: string;
  agentSteps?: AgentStep[];

  liveToolCalls?: AgentLiveToolCall[];
  liveReasoning?: string;
  /** Worktree isolation (Item 3) — the run executed in its own git worktree. */
  worktree?: { branch: string; path: string; workspaceId?: string | null };
  stats?: {
    tokensPerSec: number;
    totalTokens: number;
    /** True when totalTokens is a chars/4 estimate (no provider usage). */
    tokensEstimated?: boolean;
    elapsedMs?: number;
    /** Best-effort USD cost of the run (agent mode, provider-reported usage). */
    costUsd?: number;
    /** Iterations the agent loop used (agent mode). */
    iterations?: number;
    /** Post-run verification gate outcome; null = verification did not run. */
    verification?: { testsPassed: boolean; typecheckPassed: boolean } | null;
    /** Final run status (completed | max_iterations | aborted | failed ...). */
    status?: string;
  };
  interactive?: (
    {
      type: "ask_user";
      questions: {
        question: string;
        header: string;
        options: { label: string; description?: string; preview?: string; defaultOption?: boolean }[];
        multiSelect: boolean;
      }[];
      /** True once the user submitted answers — persisted so a reloaded
       *  card renders as answered instead of re-asking (audit M3). */
      answered?: boolean;
    }
    | {
        type: "mode_switch";
        suggestedMode: "agent" | "plan";
        prompt: string;
        sourceConversationId?: string;
        approveLabel?: string;
        cancelLabel?: string;
      }
  );
};

export type ApiKeySwitchNotice = {
  provider: string;
  fromKeyName: string;
  toKeyName: string;
};

/**
 * Session-scoped context/cost meter, accumulated by use-chat-stream across
 * agent runs in the current conversation view. contextPercent is the last
 * run's context-window pressure (null until a server emits contextUsage).
 */
export type SessionUsage = {
  contextPercent: number | null;
  costUsd: number;
  lastTotalTokens: number | null;
};

export const RESUMABLE_RUN_STATUSES = new Set(["max_iterations", "failed", "interrupted", "aborted"]);

/**
 * Run statuses the server considers alive (mirrors server/routes/agent/schemas.ts
 * ACTIVE_RUN_STATUSES). A cold-entry conversation whose latest run has one of
 * these statuses is re-attached to via GET /agent/runs/:id/stream.
 */
export const ACTIVE_RUN_STATUSES = new Set(["pending", "resumed", "in_progress", "running"]);
