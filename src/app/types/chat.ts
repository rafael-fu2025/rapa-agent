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
  stats?: {
    tokensPerSec: number;
    totalTokens: number;
    /** True when totalTokens is a chars/4 estimate (no provider usage). */
    tokensEstimated?: boolean;
    elapsedMs?: number;
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

export const RESUMABLE_RUN_STATUSES = new Set(["max_iterations", "failed", "interrupted", "aborted"]);
