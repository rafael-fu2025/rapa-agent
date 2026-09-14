import { Suspense, lazy, memo, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Clock, Copy, FolderOpen, Gauge, GitBranch, KeyRound, Pencil, RotateCcw, Send, Trash2, X, FileEdit } from "lucide-react";
import { AssistantMarkdown } from "../assistant-markdown";
import { InteractiveOptions } from "../interactive-options";
import { ModeSwitchPrompt } from "../mode-switch-prompt";
import type { ChatMessage, ChatMode, ApiKeySwitchNotice } from "../../types/chat";
import type { AgentLiveToolCall, AgentRunSummary, PendingApprovalInfo } from "../../../lib/agent-api";
import { markInteractiveAnswered } from "../../../lib/api";
import { looksLikeChatModeRestriction, looksLikeWorkspaceRequest } from "../../utils/chat-utils";
import { cn } from "../../../lib/utils";
import { Hint } from "../ui/tooltip";

const AgentStepsViewer = lazy(() => import("../agent-steps-viewer").then(m => ({ default: m.AgentStepsViewer })));

type MessageListProps = {
  messages: ChatMessage[];
  pending: boolean;
  reconnecting: string | null;
  mode: ChatMode;
  editingMessageId: string | null;
  editDraft: string;
  approvalBusyIds: string[];
  showThinking: boolean;
  workspaceName?: string;
  workspacePath?: string;
  apiKeySwitchNotice: ApiKeySwitchNotice | null;
  resumableRun: AgentRunSummary | null;
  dismissedResumeRunId: string | null;
  formattedError: { summary: string; details?: string } | null;
  bottomGap?: number;
  /** Approvals the server is still holding (rehydrated after reload). */
  pendingApprovals?: PendingApprovalInfo[];
/** Exit-hatch controls for a live persisted agent run. */
  onPauseLiveRun?: () => void;
  onResumeLiveRun?: () => void;
/** Currently selected model — powers "regenerate with current model". */
  currentModel?: string;
  onRegenerateWithCurrent?: (messageId: string) => void;
  /** Prompt queued while a stream runs — rendered dimmed until it sends. */
  queuedPrompt?: string | null;
  onCopy: (content: string) => void;
  onStartEdit: (messageId: string, content: string) => void;
  onDraftChange: (content: string) => void;
  onSaveEdit: () => void;
  onResendEdit: () => void;
  onCancelEdit: () => void;
  onDelete: (messageId: string) => void;
  onFork: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
  onToolApproval: (approvalId: string, approved: boolean) => void;
  onModeSwitchApproval: (targetMode: "agent" | "plan", prompt: string, sourceConversationId?: string) => void;
  onResumeRun: () => void;
  onDismissResume: (runId: string) => void;
  /** Optional overrides forwarded to the streaming hook (e.g. an explicit
   *  mode for the plan→agent handoff, which must not race React state). */
  onSubmit: (prompt: string, overrides?: { mode?: ChatMode }) => void;
  onSetMode: (mode: ChatMode) => void;
};

function MessageListComponent({
  messages,
  pending,
  reconnecting,
  mode,
  editingMessageId,
  editDraft,
  approvalBusyIds,
  showThinking,
  workspaceName,
  workspacePath,
  apiKeySwitchNotice,
  resumableRun,
  dismissedResumeRunId,
  formattedError,
  bottomGap = 0,
  pendingApprovals,
  onPauseLiveRun,
  onResumeLiveRun,
  currentModel,
  onRegenerateWithCurrent,
  queuedPrompt,
  onCopy,
  onStartEdit,
  onDraftChange,
  onSaveEdit,
  onResendEdit,
  onCancelEdit,
  onDelete,
  onFork,
  onRegenerate,
  onToolApproval,
  onModeSwitchApproval,
  onResumeRun,
  onDismissResume,
  onSubmit,
  onSetMode,
}: MessageListProps) {
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [bannerClosing, setBannerClosing] = useState(false);

  useEffect(() => {
    setBannerDismissed(false);
    setBannerClosing(false);
  }, [mode]);

  const handleBannerClose = () => {
    setBannerClosing(true);
    setTimeout(() => setBannerDismissed(true), 300);
  };

  return (
    <div
      className="mx-auto flex w-full max-w-[720px] flex-col"
      style={{ rowGap: "var(--density-row-gap, 20px)" }}
    >
      {(mode === "agent" || mode === "plan") && !bannerDismissed && (
        <div className={cn(
          "space-y-3",
          bannerClosing
            ? "animate-out fade-out slide-out-to-top-2 duration-300"
            : "animate-in fade-in slide-in-from-top-2 duration-300"
        )}>
          <div className="analytics-panel rounded-lg px-3 py-2.5">
            <div className="flex items-center gap-2">
              <div className={`flex h-5 w-5 items-center justify-center rounded ${mode === "plan" ? "bg-accent-purple/15 text-accent-purple" : "bg-accent-blue/15 text-accent-blue"}`}>
                <FileEdit size={11} />
              </div>
              <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-foreground">
                {mode === "plan" ? "Plan mode active" : "Agent mode active"}
              </span>
              <Hint label="Dismiss">
                <button
                  onClick={handleBannerClose}
                  className="ml-auto rounded p-1 text-muted-foreground/50 hover:text-foreground hover:bg-card-hover/40 transition-colors"
                  type="button"
                >
                  <X size={12} />
                </button>
              </Hint>
            </div>
            {workspaceName && (
              <Hint label={workspacePath ?? workspaceName}>
                <div className="mt-1.5 flex items-center gap-1.5 font-mono-tech text-[10px] text-muted-foreground">
                  <FolderOpen size={10} className="shrink-0" />
                  <span className="truncate max-w-[280px] font-medium text-foreground">{workspaceName}</span>
                  {workspacePath && workspacePath !== workspaceName && (
                    <span className="truncate max-w-[200px] text-muted-foreground/60">{workspacePath}</span>
                  )}
                </div>
              </Hint>
            )}
            <p className="mt-1 font-mono-tech text-[10px] leading-4 text-muted-foreground">
              {mode === "plan"
                ? "Plan mode can inspect and reason with workspace context but blocks side-effectful tools."
                : "The agent can inspect workspace files and apply file edits inside the active workspace. Shell and destructive tools still require approval unless you enable auto-approve categories in Settings > Agent Settings."}
            </p>
          </div>
        </div>
      )}

      {messages.map((message, index) => {
        const isUser = message.role === "user";
        const isEditing = editingMessageId === message.id;
        const canRegenerate = !pending && !isEditing && index > 0 && messages[index - 1]?.role === "user";
        const isAgentActive = pending && index === messages.length - 1;
        const previousUserMessage =
          !isUser && index > 0 && messages[index - 1]?.role === "user" ? messages[index - 1] : undefined;
        const fallbackModeSwitchPrompt =
          !isUser &&
          !message.interactive &&
          message.mode === "chat" &&
          previousUserMessage &&
          looksLikeWorkspaceRequest(previousUserMessage.content) &&
          looksLikeChatModeRestriction(message.content)
            ? previousUserMessage.content
            : undefined;

        if (isUser) {
          return (
            <UserMessageBubble
              key={message.id}
              message={message}
              isEditing={isEditing}
              editDraft={editDraft}
              onSaveEdit={onSaveEdit}
              onResendEdit={onResendEdit}
              onCancelEdit={onCancelEdit}
              onStartEdit={onStartEdit}
              onDraftChange={onDraftChange}
              onCopy={onCopy}
              onFork={onFork}
              onDelete={onDelete}
            />
          );
        }

        return (
          <AssistantMessageBlock
            key={message.id}
            message={message}
            isEditing={isEditing}
            editDraft={editDraft}
            canRegenerate={canRegenerate}
            isAgentActive={isAgentActive}
            isLatestAssistant={index === messages.length - 1}
            approvalBusyIds={approvalBusyIds}
            showThinking={showThinking}
            onSaveEdit={onSaveEdit}
            onCancelEdit={onCancelEdit}
            onStartEdit={onStartEdit}
            onDraftChange={onDraftChange}
            onCopy={onCopy}
            onFork={onFork}
            onDelete={onDelete}
            onRegenerate={onRegenerate}
            onToolApproval={onToolApproval}
            onModeSwitchApproval={onModeSwitchApproval}
            onSubmit={onSubmit}
            onSetMode={onSetMode}
            currentModel={currentModel}
            onRegenerateWithCurrent={onRegenerateWithCurrent}
            fallbackModeSwitchPrompt={fallbackModeSwitchPrompt}
          />
        );
      })}

      {queuedPrompt && pending && (
        <div className="flex justify-end opacity-50" aria-label="Queued message">
          <div className="panel-card max-w-[85%] rounded px-2.5 py-1.5 font-mono-tech text-[10px] leading-[1.6] text-foreground/70">
            <div className="mb-0.5 font-mono-tech text-[8px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/50">
              queued — sends when the run finishes
            </div>
            <div className="whitespace-pre-wrap break-words line-clamp-4">{queuedPrompt}</div>
          </div>
        </div>
      )}

      {pending && <PendingIndicator mode={mode} reconnecting={reconnecting} liveToolCalls={messages.length > 0 ? messages[messages.length - 1]?.liveToolCalls : undefined} onPauseRun={onPauseLiveRun} onResumeRun={onResumeLiveRun} />}

      {apiKeySwitchNotice && <ApiKeySwitchBanner notice={apiKeySwitchNotice} />}

      {resumableRun && dismissedResumeRunId !== resumableRun.id && (
        <ResumableRunBanner run={resumableRun} onResume={onResumeRun} onDismiss={onDismissResume} />
      )}

      {pendingApprovals && pendingApprovals.length > 0 && (
        <PendingApprovalsCard approvals={pendingApprovals} busyIds={approvalBusyIds} onDecide={onToolApproval} />
      )}

      {formattedError && <ErrorBanner error={formattedError} />}

      {bottomGap > 0 && (
        <div
          data-testid="message-list-bottom-gap"
          aria-hidden="true"
          style={{ height: `${bottomGap}px` }}
        />
      )}
    </div>
  );
}

const MessageList = memo(MessageListComponent);

MessageList.displayName = "MessageList";

/* ---------- Sub-components ---------- */

type UserBubbleProps = {
  message: ChatMessage;
  isEditing: boolean;
  editDraft: string;
  onSaveEdit: () => void;
  onResendEdit: () => void;
  onCancelEdit: () => void;
  onStartEdit: (id: string, content: string) => void;
  onDraftChange: (content: string) => void;
  onCopy: (content: string) => void;
  onFork: (id: string) => void;
  onDelete: (id: string) => void;
};

function UserMessageBubble({
  message,
  isEditing,
  editDraft,
  onSaveEdit,
  onResendEdit,
  onCancelEdit,
  onStartEdit,
  onDraftChange,
  onCopy,
  onFork,
  onDelete,
}: UserBubbleProps) {
  return (
    <article aria-label="Your message" data-message-id={message.id} className="flex justify-end">
      <div className="sidebar-panel max-w-[380px] w-fit overflow-hidden rounded">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/30 px-3 py-1.5">
          <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
            you
          </span>
          <div className="flex items-center gap-1 text-muted-foreground/40">
            {isEditing ? (
              <>
                <Hint label="Save edit (keep locally)">
                  <button
                    onClick={onSaveEdit}
                    className="rounded p-1 transition-colors hover:bg-card-hover/40 hover:text-accent-green"
                    type="button"
                  >
                    <Check size={12} />
                  </button>
                </Hint>
                <Hint label="Send edited message">
                  <button
                    onClick={onResendEdit}
                    className="rounded p-1 transition-colors hover:bg-card-hover/40 hover:text-accent-blue"
                    type="button"
                  >
                    <Send size={12} />
                  </button>
                </Hint>
                <Hint label="Cancel">
                  <button
                    onClick={onCancelEdit}
                    className="rounded p-1 transition-colors hover:bg-card-hover/40 hover:text-accent-red"
                    type="button"
                  >
                    <X size={12} />
                  </button>
                </Hint>
              </>
            ) : (
              <>
                <Hint label="Copy">
                  <button
                    onClick={() => onCopy(message.content)}
                    className="rounded p-1 transition-colors hover:bg-card-hover/40 hover:text-foreground"
                    type="button"
                  >
                    <Copy size={12} />
                  </button>
                </Hint>
                <Hint label="Branch from here">
                  <button
                    onClick={() => onFork(message.id)}
                    className="rounded p-1 transition-colors hover:bg-card-hover/40 hover:text-foreground"
                    type="button"
                  >
                    <GitBranch size={12} />
                  </button>
                </Hint>
                <Hint label="Edit">
                  <button
                    onClick={() => onStartEdit(message.id, message.content)}
                    className="rounded p-1 transition-colors hover:bg-card-hover/40 hover:text-foreground"
                    type="button"
                  >
                    <Pencil size={12} />
                  </button>
                </Hint>
                <Hint label="Delete">
                  <button
                    onClick={() => onDelete(message.id)}
                    className="rounded p-1 transition-colors hover:bg-card-hover/40 hover:text-accent-red"
                    type="button"
                  >
                    <Trash2 size={12} />
                  </button>
                </Hint>
              </>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="px-3 py-2">
          {isEditing ? (
            <textarea
              value={editDraft}
              onChange={(e) => onDraftChange(e.target.value)}
              className="min-h-[64px] w-full resize-y panel-card rounded px-2.5 py-2 font-mono-tech text-[10px] leading-[1.6] text-foreground placeholder:text-muted-foreground/50 focus:border-border focus:outline-none"
              rows={4}
            />
          ) : (
            <div
              className="whitespace-pre-wrap font-mono-tech leading-[1.6] text-foreground"
              style={{ fontSize: "calc(10px * var(--font-size-multiplier, 1))" }}
            >
              {message.content}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

type AssistantBlockProps = {
  message: ChatMessage;
  isEditing: boolean;
  editDraft: string;
  canRegenerate: boolean;
  isAgentActive: boolean;
  approvalBusyIds: string[];
  showThinking: boolean;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onStartEdit: (id: string, content: string) => void;
  onDraftChange: (content: string) => void;
  onCopy: (content: string) => void;
  onFork: (id: string) => void;
  onDelete: (id: string) => void;
  onRegenerate: (id: string) => void;
  onToolApproval: (approvalId: string, approved: boolean) => void;
  onModeSwitchApproval: (targetMode: "agent" | "plan", prompt: string, sourceConversationId?: string) => void;
  onSubmit: (prompt: string, overrides?: { mode?: ChatMode }) => void;
  onSetMode: (mode: ChatMode) => void;
  currentModel?: string;
  onRegenerateWithCurrent?: (messageId: string) => void;
  fallbackModeSwitchPrompt: string | undefined;
  /** True only for the newest assistant message — gates the plan handoff button. */
  isLatestAssistant: boolean;
};

function AssistantMessageBlock({
  message,
  isEditing,
  editDraft,
  canRegenerate,
  isAgentActive,
  approvalBusyIds,
  showThinking,
  onSaveEdit,
  onCancelEdit,
  onStartEdit,
  onDraftChange,
  onCopy,
  onFork,
  onDelete,
  onRegenerate,
  onToolApproval,
  onModeSwitchApproval,
  onSubmit,
  onSetMode,
  currentModel,
  onRegenerateWithCurrent,
  fallbackModeSwitchPrompt,
  isLatestAssistant,
}: AssistantBlockProps) {
  return (
    <article aria-label="Assistant response" data-message-id={message.id} className="w-full min-w-0 overflow-hidden">
      <div className="w-full min-w-0">
        {isEditing ? (
          <textarea
            value={editDraft}
            onChange={(e) => onDraftChange(e.target.value)}
            className="w-full panel-card rounded px-2.5 py-2 font-mono-tech text-[10px] leading-[1.6] text-foreground focus:outline-none"
            rows={6}
          />
        ) : (
          <>
            {(message.mode === "agent" || message.mode === "plan") && (
              <Suspense fallback={null}>
                <AgentStepsViewer
                  steps={
                    showThinking
                      ? (message.agentSteps ?? [])
                      : (message.agentSteps ?? []).map((step) => ({ ...step, reasoning: undefined }))
                  }
                  liveToolCalls={message.liveToolCalls}
                  liveReasoning={showThinking ? message.liveReasoning : undefined}
                  onToolApproval={onToolApproval}
                  approvalBusyIds={approvalBusyIds}
                  isAgentActive={isAgentActive}
                  agentRunId={message.agentRunId}
                />
              </Suspense>
            )}
            <AssistantMarkdown
              content={message.content}
              hideThoughtBlock={message.mode === "agent" || message.mode === "plan" || !showThinking}
            />
            {/* Plan→Agent handoff: the newest completed plan offers one-click execution. */}
            {message.mode === "plan" && isLatestAssistant && !isAgentActive && message.content.trim().length > 0 && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => {
                    // Pass the target mode explicitly. Calling onSetMode and
                    // then onSubmit would read the stale `mode` closure inside
                    // submitPrompt and re-run the plan in plan mode (audit M1.1).
                    onSetMode("agent");
                    onSubmit(
                      `Execute the following plan from the previous Plan-mode run:\n\n${message.content}`,
                      { mode: "agent" }
                    );
                  }}
                  className="inline-flex items-center gap-2 rounded border border-accent-blue/40 bg-accent-blue/10 px-3 py-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-accent-blue transition-colors hover:bg-accent-blue/20"
                >
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                    <path d="M2.5 1.5l7 4.5-7 4.5z" />
                  </svg>
                  execute plan in agent mode
                </button>
              </div>
            )}
            {message.interactive?.type === "ask_user" && message.interactive.questions.length > 0 && (
              // Only the newest assistant message may be answered — older
              // cards rendered interactive forever and could submit into
              // the live conversation (audit M3). Persisted `answered`
              // flags survive reloads.
              isLatestAssistant && !isAgentActive && !message.interactive.answered ? (
                <InteractiveOptions
                  questions={message.interactive.questions}
                  onSubmit={(response) => {
                    if (message.conversationId) {
                      void markInteractiveAnswered(message.conversationId, message.id).catch(() => undefined);
                    }
                    onSubmit(response);
                  }}
                />
              ) : (
                <div className="panel-card rounded px-3 py-1.5 font-mono-tech text-[9px] text-muted-foreground/70">
                  <Clock size={10} className="mr-1.5 inline text-accent-yellow/70" />
                  {message.interactive.answered ? "answered" : "asked"} ·{" "}
                  {message.interactive.questions.length} question{message.interactive.questions.length === 1 ? "" : "s"}
                </div>
              )
            )}
            {message.interactive?.type === "mode_switch" && (
              isLatestAssistant && !isAgentActive ? (
                <ModeSwitchPrompt
                  targetMode={message.interactive.suggestedMode}
                  prompt={message.interactive.prompt}
                  sourceConversationId={message.interactive.sourceConversationId ?? message.conversationId}
                  approveLabel={message.interactive.approveLabel}
                  cancelLabel={message.interactive.cancelLabel}
                  onApprove={(targetMode, prompt) =>
                    onModeSwitchApproval(
                      targetMode,
                      prompt,
                      message.interactive?.type === "mode_switch"
                        ? message.interactive.sourceConversationId ?? message.conversationId
                        : message.conversationId
                    )
                  }
                  onStayInChat={() => onSetMode("chat")}
                />
              ) : (
                <div className="panel-card rounded px-3 py-1.5 font-mono-tech text-[9px] text-muted-foreground/70">
                  mode switch suggested → {message.interactive.suggestedMode}
                </div>
              )
            )}
            {fallbackModeSwitchPrompt && isLatestAssistant && !isAgentActive && (
              <ModeSwitchPrompt
                targetMode="agent"
                prompt={fallbackModeSwitchPrompt}
                sourceConversationId={message.conversationId}
                approveLabel="Switch to Agent"
                cancelLabel="Stay in Chat"
                onApprove={(targetMode, prompt) => onModeSwitchApproval(targetMode, prompt, message.conversationId)}
                onStayInChat={() => onSetMode("chat")}
              />
            )}
          </>
        )}
      </div>
      <div className="mt-2 flex items-center gap-3 text-muted-foreground/50">
        {isEditing ? (
          <>
            <Hint label="Save">
              <button onClick={onSaveEdit} className="transition-colors hover:text-accent-green">
                <Check size={13} />
              </button>
            </Hint>
            <Hint label="Cancel">
              <button onClick={onCancelEdit} className="transition-colors hover:text-accent-red">
                <X size={13} />
              </button>
            </Hint>
          </>
        ) : message.stats ? (
          <>
            <Hint label="Regenerate">
              <button
                onClick={() => onRegenerate(message.id)}
                disabled={!canRegenerate}
                className="transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted"
              >
                <RotateCcw size={13} />
              </button>
            </Hint>
            {canRegenerate && currentModel && message.model && currentModel !== message.model && onRegenerateWithCurrent && (
              <Hint label={`Regenerate with ${currentModel} (currently selected)`}>
                <button
                  onClick={() => onRegenerateWithCurrent(message.id)}
                  className="inline-flex items-center gap-1 rounded border border-border/40 px-1.5 py-0.5 font-mono-tech text-[8px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 transition-colors hover:border-accent-blue/40 hover:text-accent-blue"
                >
                  <RotateCcw size={9} />
                  {currentModel}
                </button>
              </Hint>
            )}
            <Hint label="Copy">
              <button onClick={() => onCopy(message.content)} className="transition-colors hover:text-foreground">
                <Copy size={13} />
              </button>
            </Hint>
            <Hint label="Branch from here">
              <button onClick={() => onFork(message.id)} className="transition-colors hover:text-foreground">
                <GitBranch size={13} />
              </button>
            </Hint>
            <Hint label="Edit">
              <button onClick={() => onStartEdit(message.id, message.content)} className="transition-colors hover:text-foreground">
                <Pencil size={13} />
              </button>
            </Hint>
            <Hint label="Delete">
              <button onClick={() => onDelete(message.id)} className="transition-colors hover:text-accent-red">
                <Trash2 size={13} />
              </button>
            </Hint>
            <div className="ml-1 inline-flex items-center gap-1.5 font-mono-tech text-[9px] text-muted-foreground">
              {/* A 0 tok/s rate means "restored from history, rate unknown" —
                  show it only for live-generated messages (audit M3). The
                  token count from restored history is a chars/4 estimate. */}
              {message.stats.tokensPerSec > 0 && (
                <>
                  <Gauge size={11} className="text-muted-foreground" />
                  <span>{message.stats.tokensPerSec} tok/s</span>
                </>
              )}
              <span className="text-muted-foreground/50">
                ({message.stats.tokensEstimated ? "≈" : ""}{message.stats.totalTokens})
              </span>
              {message.stats.elapsedMs != null && (
                <>
                  <Clock size={11} className="text-muted-foreground/60" />
                  <span>{message.stats.elapsedMs >= 60000
                    ? `${Math.floor(message.stats.elapsedMs / 60000)}m ${((message.stats.elapsedMs % 60000) / 1000).toFixed(1)}s`
                    : `${(message.stats.elapsedMs / 1000).toFixed(1)}s`
                  }</span>
                </>
              )}
            </div>
          </>
        ) : null}
      </div>
    </article>
  );
}

/* ---------- Notification Banners — Engineering Blueprint ────── */

function ApiKeySwitchBanner({ notice }: { notice: ApiKeySwitchNotice }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div role="status" aria-live="polite" className="overflow-hidden rounded border border-border/40 bg-card-3/40" style={{ backdropFilter: "blur(16px)" }}>
      <div className="flex items-center gap-2.5 px-3 py-2">
        <div className="flex h-5 w-5 items-center justify-center rounded bg-accent-orange/15 text-accent-orange">
          <KeyRound size={11} />
        </div>
        <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          key rotated
        </span>
        <span className="flex-1" />
        <span className="font-mono-tech text-[9px] text-muted-foreground/50 capitalize">{notice.provider}</span>
        <Hint label="Dismiss">
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss key rotation notice"
            className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
          >
            <X size={12} />
          </button>
        </Hint>
      </div>
      <div className="border-t border-border/30 px-3 py-2 font-mono-tech text-[10px] text-muted-foreground/70">
        <code className="text-foreground">{notice.fromKeyName}</code>
        <span className="mx-1.5 text-muted-foreground/40">→</span>
        <code className="text-foreground">{notice.toKeyName}</code>
      </div>
    </div>
  );
}

function ResumableRunBanner({
  run,
  onResume,
  onDismiss,
}: {
  run: AgentRunSummary;
  onResume: () => void;
  onDismiss: (runId: string) => void;
}) {
  return (
    <div role="status" aria-label="Unfinished agent run" className="overflow-hidden rounded border border-accent-yellow/30 bg-card-3/40" style={{ backdropFilter: "blur(16px)" }}>
      <div className="flex items-center gap-2.5 px-3 py-2">
        <RotateCcw size={12} className="shrink-0 text-accent-yellow/70" />
        <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-accent-yellow/80">
          resume run
        </span>
        <span className="font-mono-tech text-[9px] text-accent-yellow/50 uppercase tracking-wider">
          {run.status.replace(/_/g, " ")}
        </span>
        <span className="flex-1" />
        <span className="font-mono-tech text-[9px] text-muted-foreground/40">
          {run.iterationCount} iter
        </span>
      </div>

      {(run.runSummary || run.errorMessage || run.promptPreview) && (
        <div className="border-t border-border/30 px-3 py-2 font-mono-tech text-[10px] leading-5 text-muted-foreground/70">
          {run.runSummary || run.errorMessage || run.promptPreview}
        </div>
      )}

      {(run.provider || run.model) && (
        <div className="border-t border-border/20 px-3 py-1.5 flex items-center gap-2 font-mono-tech text-[9px] text-muted-foreground/40">
          {run.provider && <span className="capitalize">{run.provider}</span>}
          {run.model && <span className="truncate">{run.model}</span>}
        </div>
      )}

      <div className="border-t border-border/30 px-3 py-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onResume}
          className="inline-flex items-center gap-1.5 rounded border border-accent-yellow/40 bg-accent-yellow/10 px-2.5 py-1 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-accent-yellow transition-colors hover:bg-accent-yellow/20"
        >
          <RotateCcw size={11} />
          Resume
        </button>
        <button
          type="button"
          onClick={() => onDismiss(run.id)}
          className="rounded border border-border/40 px-2.5 py-1 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function ErrorBanner({ error }: { error: { summary: string; details?: string } }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div role="alert" aria-live="assertive" className="overflow-hidden rounded border border-accent-red/30 bg-card-3/40" style={{ backdropFilter: "blur(16px)" }}>
      <div className="flex items-center gap-2.5 px-3 py-2">
        <AlertCircle size={12} className="shrink-0 text-accent-red/70" />
        <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-accent-red/80">
          error
        </span>
        <span className="min-w-0 flex-1 truncate font-mono-tech text-[10px] font-medium text-foreground">
          {error.summary}
        </span>
        <Hint label="Dismiss">
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss error"
            className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
          >
            <X size={12} />
          </button>
        </Hint>
      </div>
      {error.details && (
        <div className="border-t border-accent-red/15">
          <pre className="sidebar-scroll max-h-48 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono-tech text-[10px] leading-[1.6] text-accent-red/70">
            {error.details}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * Approvals the server is still holding for this conversation — rendered
 * after a page reload so a blocked run can be unblocked instead of
 * orphaned (audit M2.2).
 */
function PendingApprovalsCard({
  approvals,
  busyIds,
  onDecide
}: {
  approvals: PendingApprovalInfo[];
  busyIds: string[];
  onDecide: (approvalId: string, approved: boolean) => void;
}) {
  return (
    <div
      role="alert"
      className="overflow-hidden rounded border border-accent-yellow/40 bg-card-3/40"
      style={{ backdropFilter: "blur(16px)" }}
    >
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Clock size={12} className="shrink-0 animate-pulse text-accent-yellow" />
        <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-accent-yellow">
          approval waiting
        </span>
        <span className="min-w-0 flex-1 truncate font-mono-tech text-[10px] text-muted-foreground">
          This run is paused until you decide.
        </span>
      </div>
      <div className="divide-y divide-border/30">
        {approvals.map((approval) => {
          const busy = busyIds.includes(approval.approvalId);
          return (
            <div key={approval.approvalId} className="flex items-center gap-2.5 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <code className="font-mono-tech text-[10px] font-semibold text-foreground">{approval.toolName}</code>
                {approval.command && (
                  <div className="mt-0.5 truncate font-mono-tech text-[10px] text-muted-foreground">
                    <span className="select-none text-muted-foreground/40">$ </span>
                    {approval.command}
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => onDecide(approval.approvalId, false)}
                className="shrink-0 rounded border border-border/40 px-2 py-1 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Reject
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onDecide(approval.approvalId, true)}
                className="shrink-0 rounded border border-accent-green/40 bg-accent-green/10 px-2 py-1 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.08em] text-accent-green transition-colors hover:bg-accent-green/20 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {busy ? "…" : "Approve"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Pending Indicator with elapsed timer ─────────────── */

function PendingIndicator({
  mode,
  reconnecting,
  liveToolCalls,
  onPauseRun,
  onResumeRun
}: {
  mode: ChatMode;
  reconnecting: string | null;
  liveToolCalls?: AgentLiveToolCall[];
  /** Exit-hatch controls for a live persisted agent run (audit M2.4). */
  onPauseRun?: () => void;
  onResumeRun?: () => void;
}) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const [runPaused, setRunPaused] = useState(false);
  const startRef = useRef(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    setElapsedMs(0);
    const id = setInterval(() => setElapsedMs(Date.now() - startRef.current), 100);
    return () => clearInterval(id);
  }, []);

  const totalSecs = elapsedMs / 1000;
  const mins = Math.floor(totalSecs / 60);
  const secs = Math.floor(totalSecs % 60);
  const decisecs = Math.floor((elapsedMs % 1000) / 100);
  const timerLabel = mins > 0
    ? `${mins}:${String(secs).padStart(2, "0")}.${decisecs}`
    : `${secs}.${decisecs}s`;

  // Extract active tool info from liveToolCalls
  const activeTools = (liveToolCalls ?? []).filter(
    (tc) => tc.status === "running" || tc.status === "pending"
  );
  const activeToolNames = activeTools.map(
    (tc) => (typeof tc.call?.name === "string" && tc.call.name.trim()) || null
  ).filter((n): n is string => n !== null);

  const statusText = runPaused
    ? "run paused"
    : reconnecting
    ? reconnecting
    : activeToolNames.length > 0
      ? activeToolNames.length === 1
        ? `${activeToolNames[0].replace(/_/g, " ")}`
        : `${activeToolNames.length} tools active`
      : mode === "agent" || mode === "plan"
        ? "working with tools"
        : "thinking";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-2.5 rounded border px-3 py-2",
        reconnecting || runPaused ? "border-accent-yellow/30 bg-accent-yellow/[0.04]" : "border-border/40 bg-card-3/50"
      )}
    >
      <span className="flex gap-[3px]">
        <span className={cn("h-1 w-1 rounded-full animate-bounce [animation-delay:0ms]", reconnecting || runPaused ? "bg-accent-yellow" : "bg-accent-blue")} />
        <span className={cn("h-1 w-1 rounded-full animate-bounce [animation-delay:150ms]", reconnecting || runPaused ? "bg-accent-yellow" : "bg-accent-blue")} />
        <span className={cn("h-1 w-1 rounded-full animate-bounce [animation-delay:300ms]", reconnecting || runPaused ? "bg-accent-yellow" : "bg-accent-blue")} />
      </span>
      <span className={cn(
        "font-mono-tech text-[9px] font-semibold uppercase tracking-[0.12em]",
        reconnecting || runPaused ? "text-accent-yellow/80" : "text-muted-foreground/70"
      )}>
        {statusText}
      </span>
      {(onPauseRun || onResumeRun) && (
        <button
          type="button"
          onClick={() => {
            if (runPaused) {
              onResumeRun?.();
              setRunPaused(false);
            } else {
              onPauseRun?.();
              setRunPaused(true);
            }
          }}
          className="rounded border border-border/40 px-1.5 py-0.5 font-mono-tech text-[8px] font-semibold uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
        >
          {runPaused ? "Resume" : "Pause"}
        </button>
      )}
      <span className="ml-auto font-mono-tech text-[9px] font-medium text-muted-foreground/40 tabular-nums">
        {timerLabel}
      </span>
    </div>
  );
}

export { MessageList, ApiKeySwitchBanner, ResumableRunBanner, ErrorBanner };
