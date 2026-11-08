import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { streamChat, forkConversation, deleteConversationMessages, type ChatAttachment, type ReasoningEffort, type TokenUsage } from "../../lib/api";
import { streamAgent, submitAgentToolApproval, abortAgentRun, pauseAgentRun, resumeAgentRun, type AgentRunSummary } from "../../lib/agent-api";
import {
  acquireLiveRunConsumer,
  finalizeLiveRun,
  foldLiveStep,
  getLiveRunState,
  hasLiveRun,
  hasLiveRunConsumer,
  LIVE_MESSAGE_ID_PREFIX,
  pushLiveToolCall,
  resetLiveRun,
  setLiveActiveRun,
  setLivePending,
  setLiveQueuedPrompt,
  setLiveReasoning,
  setLiveReconnecting,
  setLiveStreamingText,
  subscribeLiveRun,
} from "../../lib/live-run-store";
import { DEFAULT_AUTO_APPROVE_TOOLS, useAgentSettings } from "../../lib/agent-settings";
import type { ChatMessage, ChatMode, ApiKeySwitchNotice, SessionUsage } from "../types/chat";
import { getRealOrEstimatedTokenCount } from "../utils/chat-utils";

/**
 * Module-level submit lock. Prevents double-submit at the JavaScript execution
 * level, independent of React state batching or ref staleness. Set to true
 * when submitPrompt starts, reset to false when it completes.
 */
let _submitLock = false;

/** Tool names that create, modify, or delete files/directories. */
const FILE_MUTATING_TOOLS = new Set([
  "write_file",
  "edit_file",
  "replace_in_file",
  "append_file",
  "delete_file",
  "rename_file",
  "mkdir",
]);

/** Debounced dispatch to refresh the workspace file tree. */
function scheduleTreeRefresh(workspaceId: string | undefined, timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) {
  if (timerRef.current) clearTimeout(timerRef.current);
  timerRef.current = setTimeout(() => {
    timerRef.current = null;
    window.dispatchEvent(new CustomEvent("workspace:tree-refresh", { detail: { workspaceId } }));
  }, 600);
}

/** Immediate dispatch (no debounce) for final refresh. */
function flushTreeRefresh(workspaceId: string | undefined, timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) {
  if (timerRef.current) {
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }
  window.dispatchEvent(new CustomEvent("workspace:tree-refresh", { detail: { workspaceId } }));
}

type UseChatStreamParams = {
  conversationId: string | undefined;
  selectedConversationId: string | undefined;
  selectedProvider: string;
  selectedModel: string;
  selectedReasoningEffort: ReasoningEffort;
  mode: ChatMode;
  workspaceId: string | undefined;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setConversationId: (id: string | undefined) => void;
  setSelectedProvider: (provider: string) => void;
  setSelectedModel: (model: string) => void;
  setError: (error: string | null) => void;
  setApiKeySwitchNotice: (notice: ApiKeySwitchNotice | null) => void;
  setMode: (mode: ChatMode) => void;
  setApprovalBusyIds: React.Dispatch<React.SetStateAction<string[]>>;
};

export function useChatStream(params: UseChatStreamParams) {
  const {
    conversationId,
    selectedConversationId,
    selectedProvider,
    selectedModel,
    selectedReasoningEffort,
    mode,
    workspaceId,
    messages,
    setMessages,
    setConversationId,
    setSelectedProvider,
    setSelectedModel,
    setError,
    setApiKeySwitchNotice,
    setMode,
    setApprovalBusyIds,
  } = params;

  const navigate = useNavigate();
  const { settings: agentSettings } = useAgentSettings();
  const { maxIterations, autoApproveCategories, sandboxMode, autoApproveClassifier, worktree: worktreeIsolation, permissionMode } = agentSettings;

  // Detachable runs: the live-run store is the module-level source of truth
  // for in-flight stream state. The executors write every event into the
  // store (keyed by the run's conversation) AND into `messages` via
  // updateMessageById for the mounted instance; a remounted view derives
  // the same props purely from the store snapshot.
  const storeKey = conversationId ?? selectedConversationId ?? "";
  const storeKeyRef = useRef(storeKey);
  storeKeyRef.current = storeKey;
  // Key the currently-running executor writes to (differs from storeKey
  // between submit and the start event, and when the user switches views).
  const activeStoreKeyRef = useRef<string>("");
  const live = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeLiveRun(storeKey, listener), [storeKey]),
    useCallback(() => getLiveRunState(storeKey), [storeKey])
  );

  const [pendingState, setPending] = useState(false);
  const [reconnectingState, setReconnecting] = useState<string | null>(null);
  // Session-scoped context/cost meter (trust & transparency): accumulated
  // across agent runs in the current conversation view, surfaced as a
  // composer chip. Reset by resetStreamState (new chat / unmount).
  const [sessionUsage, setSessionUsage] = useState<SessionUsage>({
    contextPercent: null,
    costUsd: 0,
    lastTotalTokens: null,
  });
  const isStreamingRef = useRef(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const treeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Persisted id of the agent run currently streaming (null for chat mode),
  // used by the exit-hatch controls (audit M2.4).
  const activeRunIdRef = useRef<string | null>(null);

  // Mounted-view values OR the store snapshot: local state covers the
  // native in-flight run, the store covers a run this instance remounted
  // into (detachable runs — navigate away and back, or F5 + re-attach).
  const pending = pendingState || live.pending;
  const reconnecting = reconnectingState ?? live.reconnecting;

  const updateMessageById = useCallback(
    (messageId: string, updater: (message: ChatMessage) => ChatMessage) => {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? updater(m) : m)));
    },
    [setMessages]
  );

  /**
   * Mirror the store's live state onto the streaming assistant message:
   * - Warm re-attach (module survived navigation): synthesizes the
   *   in-flight assistant message from the snapshot, then applies every
   *   store delta so the remounted view tracks the run exactly like the
   *   original instance did.
   * - Re-attach on cold entry (routes seeds the store with source
   *   "reattached"): same synthesis + delta path.
   * - Chat partial: a chat stream aborted on unmount leaves its streamed
   *   text in the store — merge it into an empty trailing assistant
   *   message so the return trip shows what was generated.
   * Native runs in THIS instance skip the merge (isStreamingRef): their
   * event handlers already write the same values into messages.
   */
  useEffect(() => {
    if (isStreamingRef.current) return;

    if (!live.pending) {
      if (live.source === "chat" && live.streamingText) {
        const text = live.streamingText;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (!last || last.role !== "assistant" || last.content.trim().length > 0) return prev;
          return [...prev.slice(0, -1), { ...last, content: text }];
        });
      }
      // A queued prompt stranded by a run that finished headless (consumer
      // count hit zero) is dropped here — it was never persisted.
      if (live.queuedPrompt) {
        setLiveQueuedPrompt(storeKey, null);
      }
      return;
    }

    const runId = live.activeRunId;
    if (!runId) return;
    setMessages((prev) => {
      const index = prev.findIndex((m) => m.role === "assistant" && m.agentRunId === runId);
      if (index === -1) {
        const synthesized: ChatMessage = {
          id: `${LIVE_MESSAGE_ID_PREFIX}${runId}`,
          conversationId: conversationId ?? selectedConversationId,
          role: "assistant",
          content: live.streamingText ?? "",
          mode: live.mode ?? "agent",
          agentRunId: runId,
          agentSteps: live.agentSteps.length > 0 ? live.agentSteps : undefined,
          liveToolCalls: live.liveToolCalls,
          liveReasoning: live.liveReasoning ?? undefined,
        };
        return [...prev, synthesized];
      }
      const target = prev[index];
      const nextContent = live.streamingText || target.content || "";
      const nextMode = target.mode ?? (live.mode ?? "agent");
      const nextSteps = live.agentSteps.length > 0 ? live.agentSteps : target.agentSteps;
      const nextToolCalls = live.liveToolCalls;
      const nextReasoning = live.liveReasoning ?? target.liveReasoning;
      if (
        nextContent === target.content &&
        nextMode === target.mode &&
        nextSteps === target.agentSteps &&
        nextToolCalls === target.liveToolCalls &&
        nextReasoning === target.liveReasoning
      ) {
        return prev;
      }
      return prev.map((m, i) =>
        i === index
          ? {
              ...m,
              content: nextContent,
              mode: nextMode,
              agentSteps: nextSteps,
              liveToolCalls: nextToolCalls,
              liveReasoning: nextReasoning,
            }
          : m
      );
    });
  }, [live, messages, storeKey, conversationId, selectedConversationId, setMessages]);

  // Mounted-consumer tracking: the post-run queue flush uses this to
  // refuse flushing into an unmounted view (detachable runs).
  useEffect(() => {
    const release = acquireLiveRunConsumer(storeKey);
    return release;
  }, [storeKey]);

  const finalizeAssistStats = useCallback(
    ({
      assistantId,
      finalContent,
      modelUsed,
      providerUsed,
      startedAt,
      mode: runMode,
      tokenUsage,
      elapsedMs,
      costUsd,
      iterations,
      verification,
      status,
    }: {
      assistantId: string;
      finalContent: string;
      modelUsed: string;
      providerUsed: string;
      startedAt: number;
      mode: ChatMode;
      tokenUsage?: TokenUsage;
      elapsedMs?: number;
      costUsd?: number;
      iterations?: number;
      verification?: { testsPassed: boolean; typecheckPassed: boolean } | null;
      status?: string;
    }) => {
      const totalTokens = getRealOrEstimatedTokenCount(finalContent, tokenUsage);
      const generatedTokens = tokenUsage?.completionTokens ?? totalTokens;
      const elapsedSec = Math.max(0.1, (performance.now() - startedAt) / 1000);
      const tokensPerSec = generatedTokens > 0 ? generatedTokens / elapsedSec : 0;

      updateMessageById(assistantId, (message) => ({
        ...message,
        content: finalContent,
        model: modelUsed,
        provider: providerUsed,
        mode: runMode,
        stats: {
          tokensPerSec: Number(tokensPerSec.toFixed(1)),
          totalTokens,
          ...(elapsedMs !== undefined ? { elapsedMs } : {}),
          ...(costUsd !== undefined ? { costUsd } : {}),
          ...(iterations !== undefined ? { iterations } : {}),
          ...(verification !== undefined ? { verification } : {}),
          ...(status !== undefined ? { status } : {}),
        },
      }));
    },
    [updateMessageById]
  );

  const startRun = useCallback(() => {
    setPending(true);
    isStreamingRef.current = true;
    setError("");
    setApiKeySwitchNotice(null);
  }, [setError, setApiKeySwitchNotice]);

  const executeChatStream = useCallback(
    async ({
      prompt,
      attachments = [],
      assistantId,
      conversationIdToUse,
      providerToUse,
      modelToUse,
      reasoningEffortToUse,
      startedAt,
      errorMessage,
    }: {
      prompt: string;
      attachments?: ChatAttachment[];
      assistantId: string;
      conversationIdToUse?: string;
      providerToUse: string;
      modelToUse: string;
      reasoningEffortToUse?: ReasoningEffort;
      startedAt: number;
      errorMessage: string;
    }) => {
      startRun();
      let streamedText = "";
      // Reconnect boundary: when the transport re-POSTs the prompt, the
      // server regenerates the response from scratch — the first chunk of a
      // new attempt REPLACES the partial text instead of appending to it
      // (otherwise a reconnect duplicates the streamed prefix in the UI).
      let awaitingNewAttempt = false;
      const controller = new AbortController();
      streamAbortRef.current = controller;
      let runStoreKey = conversationIdToUse ?? storeKeyRef.current;
      activeStoreKeyRef.current = runStoreKey;

      try {
        await streamChat(
          {
            prompt,
            attachments,
            provider: providerToUse,
            model: modelToUse,
            conversationId: conversationIdToUse,
            workspaceId,
            mode: "chat",
            // "off" suppresses the setting entirely on the backend.
            reasoningEffort: reasoningEffortToUse ?? "off",
          },
          {
            onStart: (event) => {
              if (event.conversationId) {
                runStoreKey = event.conversationId;
                activeStoreKeyRef.current = runStoreKey;
                setConversationId(event.conversationId);
                // Store becomes the source of truth for the run from here.
                setLivePending(runStoreKey, true);
                setLiveActiveRun(runStoreKey, null, { source: "chat", mode: "chat" });
                setLiveReconnecting(runStoreKey, null);
                setLiveStreamingText(runStoreKey, "", "replace");
              }
              if (event.model) {
                setSelectedModel(event.model);
              }
            },
            onChunk: (chunk) => {
              if (awaitingNewAttempt) {
                streamedText = "";
                awaitingNewAttempt = false;
                setLiveStreamingText(runStoreKey, "", "replace");
              }
              streamedText += chunk;
              setLiveStreamingText(runStoreKey, chunk, "append");
              updateMessageById(assistantId, (message) => ({
                ...message,
                content: streamedText,
                model: modelToUse,
                provider: providerToUse,
                mode: "chat",
              }));
            },
            onDone: (event) => {
              if (event.conversationId) {
                setConversationId(event.conversationId);
                if (selectedConversationId !== event.conversationId) {
                  // Use history.replaceState instead of navigate() to update the URL
                  // WITHOUT triggering React Router's navigation handlers.
                  window.history.replaceState(null, "", `/?c=${encodeURIComponent(event.conversationId)}`);
                }
              }

              finalizeLiveRun(runStoreKey, streamedText || event.content || "");

              finalizeAssistStats({
                assistantId,
                finalContent: streamedText || event.content || "",
                modelUsed: event.model ?? modelToUse,
                providerUsed: providerToUse,
                startedAt,
                mode: "chat",
                tokenUsage: event.tokenUsage,
              });

              if (event.apiKeySwitch) {
                setApiKeySwitchNotice({
                  provider: providerToUse,
                  fromKeyName: event.apiKeySwitch.fromKeyName,
                  toKeyName: event.apiKeySwitch.toKeyName,
                });
              }

              updateMessageById(assistantId, (message) => ({
                ...message,
                conversationId: event.conversationId ?? message.conversationId,
                content: streamedText || event.content || "",
                model: event.model ?? modelToUse,
                provider: providerToUse,
                mode: "chat",
                interactive: event.interactive,
              }));
            },
            onError: (message) => {
              setLiveReconnecting(runStoreKey, null);
              setReconnecting(null);
              setError(message);
            },
            onReconnect: () => {
              awaitingNewAttempt = true;
              setLiveReconnecting(runStoreKey, "Reconnecting...");
              setReconnecting("Reconnecting...");
            },
          },
          { signal: controller.signal }
        );
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : errorMessage);
        }
      } finally {
        if (streamAbortRef.current === controller) {
          streamAbortRef.current = null;
        }
        // Clear the reconnect banner on every exit path — the agent stream
        // did this, the chat stream didn't, leaving a stale "Reconnecting...".
        setLiveReconnecting(runStoreKey, null);
        finalizeLiveRun(runStoreKey);
        setReconnecting(null);
        setPending(false);
        isStreamingRef.current = false;
        _submitLock = false;
      }
    },
    [
      startRun,
      selectedConversationId,
      workspaceId,
      navigate,
      setConversationId,
      setSelectedModel,
      setError,
      setApiKeySwitchNotice,
      updateMessageById,
      finalizeAssistStats,
    ]
  );

  const executeAgentStream = useCallback(
    async ({
      prompt,
      assistantId,
      conversationIdToUse,
      providerToUse,
      modelToUse,
      reasoningEffortToUse,
      startedAt,
      runMode,
      errorMessage,
    }: {
      prompt: string;
      assistantId: string;
      conversationIdToUse?: string;
      providerToUse: string;
      modelToUse: string;
      reasoningEffortToUse?: ReasoningEffort;
      startedAt: number;
      runMode: "agent" | "plan";
      errorMessage: string;
    }) => {
      startRun();
      let finalContent = "";
      let finalTokenUsage: TokenUsage | undefined;
      let finalElapsedMs: number | undefined;
      // Run-receipt fields captured from the done event (trust & transparency).
      let finalStatus: string | undefined;
      let finalIterations: number | undefined;
      let finalCostUsd: number | undefined;
      let finalVerification: { testsPassed: boolean; typecheckPassed: boolean } | null | undefined;
      let activeConversationId = conversationId;
      let activeRunId: string | null = null;
      const controller = new AbortController();
      streamAbortRef.current = controller;
      // Expose the run id to handleStopGeneration / pause / resume, which
      // live outside this closure (audit M2.4).
      activeRunIdRef.current = null;
      let runStoreKey = conversationIdToUse ?? storeKeyRef.current;
      activeStoreKeyRef.current = runStoreKey;

      const setAgentMessageState = (updater: (message: ChatMessage) => ChatMessage) => {
        updateMessageById(assistantId, updater);
      };

      try {
        const autoApproveTools = Array.from(new Set([...DEFAULT_AUTO_APPROVE_TOOLS, ...autoApproveCategories]));

        await streamAgent(
          {
            prompt,
            provider: providerToUse,
            model: modelToUse,
            mode: runMode,
            conversationId: conversationIdToUse,
            workspaceId,
            maxIterations,
            autoApproveTools,
            reasoningEffort: reasoningEffortToUse ?? "off",
            // Item 3 — Agent Settings wiring: shell sandbox strategy,
            // LLM auto-approve classifier, worktree-per-run isolation.
            // "native" is the server default, so only send non-defaults.
            ...(sandboxMode && sandboxMode !== "native" ? { sandboxMode } : {}),
            ...(permissionMode && permissionMode !== "ask" ? { permissionMode } : {}),
            ...(autoApproveClassifier?.enabled ? { autoApproveClassifier } : {}),
            ...(worktreeIsolation ? { worktree: true } : {}),
          },
          {
            onStart: (event) => {
              activeConversationId = event.conversationId;
              runStoreKey = event.conversationId;
              activeStoreKeyRef.current = runStoreKey;
              setConversationId(event.conversationId);
              // Remember the persisted run id so Stop/Pause/Resume can
              // address the exit-hatch control routes (audit M2.4).
              activeRunId = event.runId ?? null;
              activeRunIdRef.current = activeRunId;
              // Store becomes the source of truth for the run from here —
              // it keeps updating even after this view unmounts.
              setLivePending(runStoreKey, true);
              setLiveActiveRun(runStoreKey, activeRunId, { source: "attached", mode: runMode });
              setLiveReconnecting(runStoreKey, null);
              setLiveStreamingText(runStoreKey, "", "replace");
              if (selectedConversationId !== event.conversationId) {
                // Use history.replaceState instead of navigate() to update the URL
                // WITHOUT triggering React Router's navigation handlers. This prevents
                // the loadConversation useEffect from firing and duplicating messages
                // that were already added locally by submitPrompt.
                window.history.replaceState(null, "", `/?c=${encodeURIComponent(event.conversationId)}`);
              }
              if (event.model) {
                setSelectedModel(event.model);
              }
              updateMessageById(assistantId, (message) => ({
                ...message,
                conversationId: event.conversationId ?? message.conversationId,
                ...(event.runId ? { agentRunId: event.runId } : {}),
              }));
            },
            onThinking: (event) => {
              setLiveReasoning(runStoreKey, event.reasoning ?? null);
              setAgentMessageState((message) => ({
                ...message,
                mode: "agent",
                liveReasoning: event.reasoning,
              }));
            },
            onToolCall: (event) => {
              pushLiveToolCall(runStoreKey, {
                iteration: event.iteration,
                status: event.status,
                call: event.call,
                ...(event.result !== undefined ? { result: event.result } : {}),
              });
              setAgentMessageState((message) => {
                const existing = message.liveToolCalls ?? [];
                const withoutCurrent = existing.filter((item) => item.call.id !== event.call.id);
                return {
                  ...message,
                  mode: "agent",
                  liveToolCalls: [...withoutCurrent, event],
                };
              });
              // Auto-refresh file tree when a file-mutating tool completes
              if (event.status === "completed" && FILE_MUTATING_TOOLS.has(event.call.name)) {
                scheduleTreeRefresh(workspaceId, treeRefreshTimerRef);
              }
            },
            onAssistant: (event) => {
              finalContent = event.content;
              setLiveStreamingText(runStoreKey, event.content, "replace");
              setAgentMessageState((message) => ({
                ...message,
                content: event.content,
                model: modelToUse,
                provider: providerToUse,
                mode: runMode,
                interactive: event.interactive,
              }));
            },
            onStep: (event) => {
              foldLiveStep(runStoreKey, event.step);
              setAgentMessageState((message) => {
                const previousSteps = message.agentSteps ?? [];
                const nextSteps = [...previousSteps.filter((s) => s.iteration !== event.step.iteration), event.step];
                return {
                  ...message,
                  agentSteps: nextSteps,
                  liveReasoning: undefined,
                  liveToolCalls: [],
                };
              });
            },
            onDone: (event) => {
              const doneEvent = event as typeof event & { agentRunId?: string; elapsedMs?: number };
              finalContent = event.response;
              finalTokenUsage = event.tokenUsage;
              finalElapsedMs = doneEvent.elapsedMs;
              finalStatus = event.status;
              finalIterations = event.iterations;
              finalCostUsd = typeof event.estimatedCostUsd === "number" ? event.estimatedCostUsd : undefined;
              finalVerification = event.verification === undefined ? undefined : event.verification;

              // Settle the store with the full response — a view that
              // remounts later shows the complete content instantly.
              finalizeLiveRun(runStoreKey, event.response);

              // Accumulate the session context/cost meter. contextPercent
              // reports the latest run's pressure (null when the server
              // didn't emit contextUsage); cost accumulates across runs.
              setSessionUsage((prev) => ({
                contextPercent: event.contextUsage?.percent ?? null,
                costUsd: prev.costUsd + (typeof event.estimatedCostUsd === "number" ? event.estimatedCostUsd : 0),
                lastTotalTokens: event.tokenUsage?.totalTokens ?? null,
              }));

              setAgentMessageState((message) => ({
                ...message,
                content: event.response,
                agentRunId: doneEvent.agentRunId,
                agentSteps: event.steps,
                liveReasoning: undefined,
                liveToolCalls: [],
                interactive: event.interactive,
                // Item 3 — single additive merge of done.worktree into the
                // message metadata so the worktree banner can render (and
                // address merge/discard/open) without extra stream state.
                ...(event.worktree
                  ? { worktree: { ...event.worktree, workspaceId: workspaceId ?? null } }
                  : {}),
              }));

              if (activeConversationId && selectedConversationId !== activeConversationId) {
                window.history.replaceState(null, "", `/?c=${encodeURIComponent(activeConversationId)}`);
              }

              if (event.apiKeySwitch) {
                setApiKeySwitchNotice({
                  provider: providerToUse,
                  fromKeyName: event.apiKeySwitch.fromKeyName,
                  toKeyName: event.apiKeySwitch.toKeyName,
                });
              }

              // Final tree refresh when agent run completes
              flushTreeRefresh(workspaceId, treeRefreshTimerRef);
            },
            onError: (message) => {
              setLiveReconnecting(runStoreKey, null);
              setReconnecting(null);
              setError(message);
            },
            onReconnect: () => {
              setLiveReconnecting(runStoreKey, "Reconnecting...");
              setReconnecting("Reconnecting...");
            },
          },
          { signal: controller.signal }
        );

        finalizeAssistStats({
          assistantId,
          finalContent,
          modelUsed: modelToUse,
          providerUsed: providerToUse,
          startedAt,
          mode: runMode,
          tokenUsage: finalTokenUsage,
          elapsedMs: finalElapsedMs,
          status: finalStatus,
          iterations: finalIterations,
          costUsd: finalCostUsd,
          verification: finalVerification,
        });
      } catch (err) {
        setLiveReconnecting(runStoreKey, null);
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : errorMessage);
        }
      } finally {
        if (streamAbortRef.current === controller) {
          streamAbortRef.current = null;
        }
        finalizeLiveRun(runStoreKey);
        setPending(false);
        setReconnecting(null);
        isStreamingRef.current = false;
        _submitLock = false;
      }
    },
    [
      conversationId,
      startRun,
      selectedConversationId,
      workspaceId,
      navigate,
      setConversationId,
      setSelectedModel,
      setError,
      setApiKeySwitchNotice,
      updateMessageById,
      finalizeAssistStats,
      maxIterations,
      autoApproveCategories,
      sandboxMode,
      autoApproveClassifier,
      worktreeIsolation,
    ]
  );

  // Queued prompt: submitted while a stream was running; auto-sent when
  // the run finishes instead of the old silent no-op (audit M4).
  const [queuedPromptState, setQueuedPrompt] = useState<string | null>(null);
  const queuedPromptRef = useRef<{ prompt: string; attachments: ChatAttachment[] } | null>(null);
  const submitPromptRef = useRef<((prompt: string, attachments: ChatAttachment[]) => Promise<void>) | null>(null);
  const queuedPrompt = queuedPromptState ?? live.queuedPrompt;

  const flushQueuedPrompt = useCallback(async () => {
    const queued = queuedPromptRef.current;
    if (!queued) return;
    // Detachable runs: never flush headless. When the view that queued the
    // prompt unmounted, its consumer was released — the queued prompt is
    // dropped (the store clears it on the next mount) instead of
    // re-submitting into a dead component.
    if (!hasLiveRunConsumer(activeStoreKeyRef.current)) return;
    queuedPromptRef.current = null;
    setQueuedPrompt(null);
    setLiveQueuedPrompt(activeStoreKeyRef.current, null);
    await submitPromptRef.current?.(queued.prompt, queued.attachments);
  }, []);

  const submitPrompt = useCallback(
    async (
      prompt: string,
      attachments: ChatAttachment[] = [],
      overrides?: Partial<{ mode: ChatMode; provider: string; model: string; conversationId: string; reasoningEffort: ReasoningEffort }>
    ) => {
      // Triple guard against double-submit:
      // 1. Module-level lock (synchronous, survives React re-renders)
      // 2. Ref-based streaming flag (synchronous, survives closures)
      // 3. Store-tracked run for this conversation (imperative read —
      //    deliberately NOT the render-scoped `pending`: the post-run
      //    queue flush runs in the same microtask chain as the executor's
      //    finally, before React re-renders, so state-derived flags would
      //    be stale and re-queue the prompt instead of sending it)
      if (_submitLock || isStreamingRef.current || hasLiveRun(storeKeyRef.current)) {
        // A stream is already running — queue the prompt instead of the
        // old silent no-op; it auto-sends when the run finishes
        // (audit M4).
        queuedPromptRef.current = { prompt, attachments };
        setQueuedPrompt(prompt);
        setLiveQueuedPrompt(storeKeyRef.current, prompt);
        return;
      }

      // Check if the last user message has the same content (deduplication)
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      if (lastUserMsg && lastUserMsg.content === prompt && lastUserMsg.createdAt) {
        const age = Date.now() - lastUserMsg.createdAt.getTime();
        if (age < 10_000) return; // Same prompt within 10 seconds — ignore
      }

      _submitLock = true;
      isStreamingRef.current = true;
      setPending(true);

      const startedAt = performance.now();
      const attachmentSummary =
        attachments.length > 0 ? `\n\nAttachments: ${attachments.map((item) => item.name).join(", ")}` : "";
      const runMode: ChatMode = overrides?.mode ?? mode;
      const runProvider = overrides?.provider ?? selectedProvider;
      const runModel = overrides?.model ?? selectedModel;
      const runReasoningEffort: ReasoningEffort = overrides?.reasoningEffort ?? selectedReasoningEffort;
      const runConversationId = overrides?.conversationId ?? conversationId ?? selectedConversationId;
      setMode(runMode);
      setSelectedProvider(runProvider);
      setSelectedModel(runModel);
      setConversationId(runConversationId);
      setApiKeySwitchNotice(null);
      // Fresh run — clear any stale streamed partial so a view remounting
      // during THIS run can't show the previous response's text.
      setLiveStreamingText(runConversationId ?? storeKeyRef.current, "", "replace");

      const userMessage: ChatMessage = {
        id: `u-${Date.now()}`,
        conversationId: runConversationId,
        role: "user",
        content: `${prompt}${attachmentSummary}`,
        createdAt: new Date(),
        model: runModel,
        provider: runProvider,
        mode: runMode,
        reasoningEffort: runReasoningEffort,
      };

      const assistantId = `a-${Date.now()}`;
      const assistantMessage: ChatMessage = {
        id: assistantId,
        conversationId: runConversationId,
        role: "assistant",
        content: "",
        model: runModel,
        provider: runProvider,
        mode: runMode,
        reasoningEffort: runReasoningEffort,
      };

      setMessages((prev) => [...prev, userMessage, assistantMessage]);

      if (runMode === "agent" || runMode === "plan") {
        const agentPrompt =
          attachments.length > 0
            ? `${prompt}\n\nThe user attached these files, but Agent mode can only inspect files that exist in the selected workspace: ${attachments.map((item) => item.name).join(", ")}`
            : prompt;
        await executeAgentStream({
          prompt: agentPrompt,
          assistantId,
          conversationIdToUse: runConversationId,
          providerToUse: runProvider,
          modelToUse: runModel,
          reasoningEffortToUse: runReasoningEffort,
          startedAt,
          runMode,
          errorMessage: runMode === "plan" ? "Failed to run plan" : "Failed to run agent",
        });
        await flushQueuedPrompt();
        return;
      }

      await executeChatStream({
        prompt,
        attachments,
        assistantId,
        conversationIdToUse: runConversationId,
        providerToUse: runProvider,
        modelToUse: runModel,
        reasoningEffortToUse: runReasoningEffort,
        startedAt,
        errorMessage: "Failed to send message",
      });
      await flushQueuedPrompt();
    },
    [
      messages,
      mode,
      selectedProvider,
      selectedModel,
      selectedReasoningEffort,
      conversationId,
      selectedConversationId,
      setMode,
      setSelectedProvider,
      setSelectedModel,
      setConversationId,
      setApiKeySwitchNotice,
      setMessages,
      executeAgentStream,
      executeChatStream,
      flushQueuedPrompt,
    ]
  );

  // The queue flush needs the latest submitPrompt; a ref breaks the
  // circular dependency.
  submitPromptRef.current = async (prompt, attachments) => {
    await submitPrompt(prompt, attachments);
  };

  const handleStopGeneration = useCallback((keepQueue = false) => {
    // Tell the server first when a persisted agent run is in flight, so
    // the run's status is marked aborted and the exit hatch coordinates
    // a clean stop — then cut the client stream (audit M2.4). The run id
    // falls back to the store so a reattached view can stop too.
    const stopKey = activeStoreKeyRef.current || storeKeyRef.current;
    const runId = activeRunIdRef.current ?? live.activeRunId;
    if (runId) {
      activeRunIdRef.current = null;
      void abortAgentRun(runId).catch(() => undefined);
    }
    // Stopping discards any queued follow-up — the user interrupted.
    // Exception: "send now" (keepQueue) preserves it and re-sends right
    // after the abort settles (audit M4).
    if (!keepQueue) {
      queuedPromptRef.current = null;
      setQueuedPrompt(null);
      setLiveQueuedPrompt(stopKey, null);
    }
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    // Settle the store immediately so a reattached view stops showing the
    // run as active (the reattach stream settles on its own afterwards).
    finalizeLiveRun(stopKey);
    setPending(false);
    isStreamingRef.current = false;
  }, [live.activeRunId]);

  /**
   * Send-now: abort the in-flight stream but keep the queued prompt, then
   * flush it once the abort settles. The aborted stream's own post-run
   * flush (submitPrompt → flushQueuedPrompt) races this timeout —
   * flushQueuedPrompt nulls the ref before submitting, so exactly one of
   * the two can win; the other is a no-op.
   */
  const handleSendQueuedNow = useCallback(() => {
    if (!queuedPromptRef.current) return;
    handleStopGeneration(true);
    window.setTimeout(() => {
      if (!queuedPromptRef.current) return;
      // Abort not fully unwound yet — the stream's own flush will pick the
      // queue up; submitting now would just re-queue via the submit guard.
      if (isStreamingRef.current) return;
      void flushQueuedPrompt();
    }, 150);
  }, [handleStopGeneration, flushQueuedPrompt]);

  const handlePauseRun = useCallback(() => {
    const runId = activeRunIdRef.current ?? live.activeRunId;
    if (!runId) return;
    void pauseAgentRun(runId).catch(() => undefined);
  }, [live.activeRunId]);

  const handleResumeRunControls = useCallback(() => {
    const runId = activeRunIdRef.current ?? live.activeRunId;
    if (!runId) return;
    void resumeAgentRun(runId).catch(() => undefined);
  }, [live.activeRunId]);

  const handleAgentToolApproval = useCallback(
    async (approvalId: string, approved: boolean) => {
      setApprovalBusyIds((prev) => (prev.includes(approvalId) ? prev : [...prev, approvalId]));

      try {
        await submitAgentToolApproval({
          approvalId,
          approved,
          message: approved ? undefined : "Rejected by user",
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Failed to submit tool approval";
        console.error("Approval failed:", errorMessage);

        if (errorMessage.includes("not found") || errorMessage.includes("expired")) {
          setError("Approval expired. The agent will retry the command - please approve it again.");
        } else {
          setError(errorMessage);
        }
      } finally {
        setApprovalBusyIds((prev) => prev.filter((item) => item !== approvalId));
      }
    },
    [setApprovalBusyIds, setError]
  );

  const handleModeSwitchApproval = useCallback(
    async (targetMode: "agent" | "plan", prompt: string, sourceConversationId?: string) => {
      const originConversationId = sourceConversationId?.trim() || conversationId || selectedConversationId;

      // Do NOT set isStreamingRef here: submitPrompt's first guard is
      // `if (isStreamingRef.current) return;`, so pre-setting it made the
      // submit silently no-op AND blocked every later submit/load until
      // "New Chat" — the mode-switch deadlock. submitPrompt sets the flag
      // itself once its guards pass.
      if (originConversationId && selectedConversationId !== originConversationId) {
        navigate(`/?c=${encodeURIComponent(originConversationId)}`, { replace: true });
      }

      await submitPrompt(prompt, [], {
        mode: targetMode,
        conversationId: originConversationId,
      });
    },
    [conversationId, selectedConversationId, navigate, submitPrompt]
  );

  const handleRegenerate = useCallback(
    async (assistantMessageId: string, overrides?: { model?: string; provider?: string }) => {
      if (pending) return;

      const assistantIndex = messages.findIndex((item) => item.id === assistantMessageId && item.role === "assistant");
      if (assistantIndex <= 0) return;

      const previous = messages[assistantIndex - 1];
      const target = messages[assistantIndex];

      if (!previous || previous.role !== "user" || !target) return;

      const prompt = previous.content.trim();
      if (!prompt) return;

      // Explicit overrides (regenerate-with-a-different-model) win over
      // the message's original settings (audit M4).
      const modelToUse = overrides?.model ?? target.model ?? selectedModel;
      const runProvider = overrides?.provider ?? target.provider ?? selectedProvider;
      const runMode: ChatMode = target.mode ?? "chat";
      // Preserve the reasoning effort of the message being regenerated.
      // If the target has no setting (older message before this column
      // existed), fall back to the currently selected effort so the
      // user's last choice isn't silently overridden.
      const runReasoningEffort: ReasoningEffort = (target.reasoningEffort as ReasoningEffort | undefined) ?? selectedReasoningEffort;
      const startedAt = performance.now();

      setSelectedModel(modelToUse);
      setSelectedProvider(runProvider);

      updateMessageById(assistantMessageId, (message) => ({
        ...message,
        content: "",
        model: modelToUse,
        provider: runProvider,
        mode: runMode,
        stats: undefined,
      }));

      if (runMode === "agent" || runMode === "plan") {
        await executeAgentStream({
          prompt,
          assistantId: assistantMessageId,
          providerToUse: runProvider,
          modelToUse,
          reasoningEffortToUse: runReasoningEffort,
          startedAt,
          runMode,
          errorMessage:
            runMode === "plan" ? "Failed to regenerate plan response" : "Failed to regenerate agent response",
        });
        return;
      }

      await executeChatStream({
        prompt,
        assistantId: assistantMessageId,
        providerToUse: runProvider,
        modelToUse,
        reasoningEffortToUse: runReasoningEffort,
        startedAt,
        errorMessage: "Failed to regenerate response",
      });
    },
    [
      pending,
      messages,
      selectedModel,
      selectedProvider,
      selectedReasoningEffort,
      setSelectedModel,
      setSelectedProvider,
      updateMessageById,
      executeAgentStream,
      executeChatStream,
    ]
  );

  const handleResumeRun = useCallback(
    async (resumableRun: AgentRunSummary | null) => {
      if (!resumableRun || pending) return;

      setError(null);

      await submitPrompt(
        "Continue from where you left off and finish the previous agent task. Reuse completed work, verify anything still needed, and clearly report any remaining blocker.",
        [],
        {
          mode: "agent",
          provider: resumableRun.provider ?? selectedProvider,
          model: resumableRun.model ?? selectedModel,
        }
      );
    },
    [pending, selectedProvider, selectedModel, submitPrompt, setError]
  );

  const handleFork = useCallback(
    async (messageId: string) => {
      if (!conversationId) return;
      try {
        const forked = await forkConversation(conversationId, messageId);
        navigate(`/?c=${encodeURIComponent(forked.id)}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fork conversation");
      }
    },
    [conversationId, navigate, setError]
  );

  const handleResendEdit = useCallback(
    async (userMessageId: string, editedContent: string) => {
      if (pending) return;
      const cleanPrompt = editedContent.trim();
      if (!cleanPrompt) return;

      const userIndex = messages.findIndex((m) => m.id === userMessageId);
      if (userIndex === -1) return;

      const targetUserMsg = messages[userIndex];
      const runMode: ChatMode = targetUserMsg.mode ?? mode;
      const runProvider = targetUserMsg.provider ?? selectedProvider;
      const runModel = targetUserMsg.model ?? selectedModel;
      const runReasoningEffort: ReasoningEffort =
        (targetUserMsg.reasoningEffort as ReasoningEffort | undefined) ?? selectedReasoningEffort;
      const runConversationId = targetUserMsg.conversationId ?? conversationId ?? selectedConversationId;

      const startedAt = performance.now();
      _submitLock = true;
      isStreamingRef.current = true;
      setPending(true);

      const assistantId = `a-${Date.now()}`;
      const updatedUserMsg: ChatMessage = {
        ...targetUserMsg,
        content: cleanPrompt,
        model: runModel,
        provider: runProvider,
        mode: runMode,
        reasoningEffort: runReasoningEffort,
      };

      const assistantMessage: ChatMessage = {
        id: assistantId,
        conversationId: runConversationId,
        role: "assistant",
        content: "",
        model: runModel,
        provider: runProvider,
        mode: runMode,
        reasoningEffort: runReasoningEffort,
      };

      // Truncate messages up to the edited user message and append the new assistant message
      const prefix = messages.slice(0, userIndex);
      setMessages([...prefix, updatedUserMsg, assistantMessage]);

      // Persist the truncation server-side. Without this the server kept
      // the original unedited tail and the reloaded conversation showed
      // BOTH branches (audit M1.3). Best-effort: on failure the stream
      // still proceeds, matching the previous client-only behavior.
      if (runConversationId) {
        void deleteConversationMessages(runConversationId, { afterMessageId: userMessageId }).catch(() => undefined);
      }

      if (runMode === "agent" || runMode === "plan") {
        await executeAgentStream({
          prompt: cleanPrompt,
          assistantId,
          conversationIdToUse: runConversationId,
          providerToUse: runProvider,
          modelToUse: runModel,
          reasoningEffortToUse: runReasoningEffort,
          startedAt,
          runMode,
          errorMessage: runMode === "plan" ? "Failed to run plan" : "Failed to run agent",
        });
        return;
      }

      await executeChatStream({
        prompt: cleanPrompt,
        attachments: [],
        assistantId,
        conversationIdToUse: runConversationId,
        providerToUse: runProvider,
        modelToUse: runModel,
        reasoningEffortToUse: runReasoningEffort,
        startedAt,
        errorMessage: "Failed to send message",
      });
    },
    [
      pending,
      messages,
      mode,
      selectedProvider,
      selectedModel,
      selectedReasoningEffort,
      conversationId,
      selectedConversationId,
      executeAgentStream,
      executeChatStream,
      setMessages,
      setPending,
    ]
  );

  const resetStreamState = useCallback(() => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }
    isStreamingRef.current = false;
    setPending(false);
    setReconnecting(null);
    queuedPromptRef.current = null;
    setQueuedPrompt(null);
    // Fresh conversation — drop the store's run state for the view and
    // restart the context/cost meter.
    resetLiveRun(storeKeyRef.current);
    setSessionUsage({ contextPercent: null, costUsd: 0, lastTotalTokens: null });
  }, []);

  // Detachable runs: when the owning component unmounts (e.g. navigating
  // to Settings mid-stream), an in-flight AGENT run keeps streaming at
  // module scope — the store keeps updating so navigating back
  // re-attaches instantly and the run is not killed server-side. Chat
  // mode (and runs that never persisted a runId) still aborts: the server
  // cancels upstream on socket close and the partial persists for the
  // return trip.
  useEffect(() => {
    return () => {
      if (streamAbortRef.current && !activeRunIdRef.current) {
        streamAbortRef.current.abort();
      }
    };
  }, []);

  return {
    pending,
    reconnecting,
    queuedPrompt,
    sessionUsage,
    isStreamingRef,
    streamAbortRef,
    submitPrompt,
    handleStopGeneration,
    handleSendQueuedNow,
    handleAgentToolApproval,
    handleModeSwitchApproval,
    handleRegenerate,
    handleResendEdit,
    handleResumeRun,
    handleFork,
    handlePauseRun,
    handleResumeRunControls,
    updateMessageById,
    resetStreamState,
  };
}
