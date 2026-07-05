import { Suspense, lazy, memo, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Clock, Copy, FolderOpen, Gauge, GitBranch, KeyRound, Pencil, RotateCcw, Trash2, X, FileEdit } from "lucide-react";
import { AssistantMarkdown } from "../assistant-markdown";
import { InteractiveOptions } from "../interactive-options";
import { ModeSwitchPrompt } from "../mode-switch-prompt";
import type { ChatMessage, ChatMode, ApiKeySwitchNotice } from "../../types/chat";
import type { AgentLiveToolCall, AgentRunSummary } from "../../../lib/agent-api";
import { looksLikeChatModeRestriction, looksLikeWorkspaceRequest } from "../../utils/chat-utils";
import { cn } from "../../../lib/utils";

const AgentStepsViewer = lazy(() => import("../agent-steps-viewer").then(m => ({ default: m.AgentStepsViewer })));
const AgentRunPanel = lazy(() => import("../agent-run-panel").then(m => ({ default: m.AgentRunPanel })));

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
  onCopy: (content: string) => void;
  onStartEdit: (messageId: string, content: string) => void;
  onDraftChange: (content: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDelete: (messageId: string) => void;
  onFork: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
  onToolApproval: (approvalId: string, approved: boolean) => void;
  onModeSwitchApproval: (targetMode: "agent" | "plan", prompt: string, sourceConversationId?: string) => void;
  onResumeRun: () => void;
  onDismissResume: (runId: string) => void;
  onSubmit: (prompt: string) => void;
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
  onCopy,
  onStartEdit,
  onDraftChange,
  onSaveEdit,
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
    <div className="mx-auto w-full max-w-[720px] space-y-5">
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
              <button
                onClick={handleBannerClose}
                className="ml-auto rounded p-1 text-muted-foreground/50 hover:text-foreground hover:bg-card-hover/40 transition-colors"
                title="Dismiss"
                type="button"
              >
                <X size={12} />
              </button>
            </div>
            {workspaceName && (
              <div className="mt-1.5 flex items-center gap-1.5 font-mono-tech text-[10px] text-muted-foreground" title={workspacePath ?? workspaceName}>
                <FolderOpen size={10} className="shrink-0" />
                <span className="truncate max-w-[280px] font-medium text-foreground">{workspaceName}</span>
                {workspacePath && workspacePath !== workspaceName && (
                  <span className="truncate max-w-[200px] text-muted-foreground/60">{workspacePath}</span>
                )}
              </div>
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
            fallbackModeSwitchPrompt={fallbackModeSwitchPrompt}
          />
        );
      })}

      {pending && <PendingIndicator mode={mode} reconnecting={reconnecting} liveToolCalls={messages.length > 0 ? messages[messages.length - 1]?.liveToolCalls : undefined} />}

      {apiKeySwitchNotice && <ApiKeySwitchBanner notice={apiKeySwitchNotice} />}

      {resumableRun && dismissedResumeRunId !== resumableRun.id && (
        <ResumableRunBanner run={resumableRun} onResume={onResumeRun} onDismiss={onDismissResume} />
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
                <button
                  onClick={onSaveEdit}
                  className="rounded p-1 transition-colors hover:bg-card-hover/40 hover:text-accent-green"
                  title="Save"
                  type="button"
                >
                  <Check size={12} />
                </button>
                <button
                  onClick={onCancelEdit}
                  className="rounded p-1 transition-colors hover:bg-card-hover/40 hover:text-accent-red"
                  title="Cancel"
                  type="button"
                >
                  <X size={12} />
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => onCopy(message.content)}
                  className="rounded p-1 transition-colors hover:bg-card-hover/40 hover:text-foreground"
                  title="Copy"
                  type="button"
                >
                  <Copy size={12} />
                </button>
                <button
                  onClick={() => onFork(message.id)}
                  className="rounded p-1 transition-colors hover:bg-card-hover/40 hover:text-foreground"
                  title="Branch from here"
                  type="button"
                >
                  <GitBranch size={12} />
                </button>
                <button
                  onClick={() => onStartEdit(message.id, message.content)}
                  className="rounded p-1 transition-colors hover:bg-card-hover/40 hover:text-foreground"
                  title="Edit"
                  type="button"
                >
                  <Pencil size={12} />
                </button>
                <button
                  onClick={() => onDelete(message.id)}
                  className="rounded p-1 transition-colors hover:bg-card-hover/40 hover:text-accent-red"
                  title="Delete"
                  type="button"
                >
                  <Trash2 size={12} />
                </button>
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
            <div className="whitespace-pre-wrap font-mono-tech text-[10px] leading-[1.6] text-foreground">
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
  onSubmit: (prompt: string) => void;
  onSetMode: (mode: ChatMode) => void;
  fallbackModeSwitchPrompt: string | undefined;
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
  fallbackModeSwitchPrompt,
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
            {message.mode === "agent" && (
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
            {message.mode === "agent" && false && (
              <Suspense fallback={null}>
                <AgentRunPanel agentRunId={message.agentRunId} onError={(msg: string) => console.error(msg)} />
              </Suspense>
            )}
            <AssistantMarkdown
              content={message.content}
              hideThoughtBlock={message.mode === "agent" || !showThinking}
            />
            {message.interactive?.type === "ask_user" && message.interactive.questions.length > 0 && (
              <InteractiveOptions
                questions={message.interactive.questions}
                onSubmit={(response) => onSubmit(response)}
              />
            )}
            {message.interactive?.type === "mode_switch" && (
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
            )}
            {fallbackModeSwitchPrompt && (
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
            <button onClick={onSaveEdit} className="transition-colors hover:text-accent-green" title="Save">
              <Check size={13} />
            </button>
            <button onClick={onCancelEdit} className="transition-colors hover:text-accent-red" title="Cancel">
              <X size={13} />
            </button>
          </>
        ) : message.stats ? (
          <>
            <button
              onClick={() => onRegenerate(message.id)}
              disabled={!canRegenerate}
              className="transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted"
              title="Regenerate"
            >
              <RotateCcw size={13} />
            </button>
            <button onClick={() => onCopy(message.content)} className="transition-colors hover:text-foreground" title="Copy">
              <Copy size={13} />
            </button>
            <button onClick={() => onFork(message.id)} className="transition-colors hover:text-foreground" title="Branch from here">
              <GitBranch size={13} />
            </button>
            <button onClick={() => onStartEdit(message.id, message.content)} className="transition-colors hover:text-foreground" title="Edit">
              <Pencil size={13} />
            </button>
            <button onClick={() => onDelete(message.id)} className="transition-colors hover:text-accent-red" title="Delete">
              <Trash2 size={13} />
            </button>
            <div className="ml-1 inline-flex items-center gap-1.5 font-mono-tech text-[9px] text-muted-foreground">
              <Gauge size={11} className="text-muted-foreground" />
              <span>{message.stats.tokensPerSec} tok/s</span>
              <span className="text-muted-foreground/50">({message.stats.totalTokens})</span>
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

/* ---------- Pending Indicator with elapsed timer ─────────────── */

function PendingIndicator({ mode, reconnecting, liveToolCalls }: { mode: ChatMode; reconnecting: string | null; liveToolCalls?: AgentLiveToolCall[] }) {
  const [elapsedMs, setElapsedMs] = useState(0);
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

  const statusText = reconnecting
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
        reconnecting ? "border-accent-yellow/30 bg-accent-yellow/[0.04]" : "border-border/40 bg-card-3/50"
      )}
    >
      <span className="flex gap-[3px]">
        <span className={cn("h-1 w-1 rounded-full animate-bounce [animation-delay:0ms]", reconnecting ? "bg-accent-yellow" : "bg-accent-blue")} />
        <span className={cn("h-1 w-1 rounded-full animate-bounce [animation-delay:150ms]", reconnecting ? "bg-accent-yellow" : "bg-accent-blue")} />
        <span className={cn("h-1 w-1 rounded-full animate-bounce [animation-delay:300ms]", reconnecting ? "bg-accent-yellow" : "bg-accent-blue")} />
      </span>
      <span className={cn(
        "font-mono-tech text-[9px] font-semibold uppercase tracking-[0.12em]",
        reconnecting ? "text-accent-yellow/80" : "text-muted-foreground/70"
      )}>
        {statusText}
      </span>
      <span className="ml-auto font-mono-tech text-[9px] font-medium text-muted-foreground/40 tabular-nums">
        {timerLabel}
      </span>
    </div>
  );
}

export { MessageList, ApiKeySwitchBanner, ResumableRunBanner, ErrorBanner };
