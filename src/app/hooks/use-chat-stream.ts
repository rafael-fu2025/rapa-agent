import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { streamChat, forkConversation, type ChatAttachment, type ReasoningEffort, type TokenUsage } from "../../lib/api";
import { streamAgent, submitAgentToolApproval, type AgentRunSummary } from "../../lib/agent-api";
import { DEFAULT_AUTO_APPROVE_TOOLS, useAgentSettings } from "../../lib/agent-settings";
import type { ChatMessage, ChatMode, ApiKeySwitchNotice } from "../types/chat";
import { estimateTokens, getRealOrEstimatedTokenCount } from "../utils/chat-utils";

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
  const { maxIterations, autoApproveCategories } = agentSettings;

  const [pending, setPending] = useState(false);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const isStreamingRef = useRef(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const treeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateMessageById = useCallback(
    (messageId: string, updater: (message: ChatMessage) => ChatMessage) => {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? updater(m) : m)));
    },
    [setMessages]
  );

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
    }: {
      assistantId: string;
      finalContent: string;
      modelUsed: string;
      providerUsed: string;
      startedAt: number;
      mode: ChatMode;
      tokenUsage?: TokenUsage;
      elapsedMs?: number;
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
          elapsedMs,
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
      const controller = new AbortController();
      streamAbortRef.current = controller;

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
                setConversationId(event.conversationId);
              }
              if (event.model) {
                setSelectedModel(event.model);
              }
            },
            onChunk: (chunk) => {
              streamedText += chunk;
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
              setReconnecting(null);
              setError(message);
            },
            onReconnect: () => {
              setReconnecting("Reconnecting...");
            },
          },
          { signal: controller.signal }
        );
      } catch (err) {
        setReconnecting(null);
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : errorMessage);
        }
      } finally {
        if (streamAbortRef.current === controller) {
          streamAbortRef.current = null;
        }
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
      let activeConversationId = conversationId;
      const controller = new AbortController();
      streamAbortRef.current = controller;

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
          },
          {
            onStart: (event) => {
              activeConversationId = event.conversationId;
              setConversationId(event.conversationId);
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
              }));
            },
            onThinking: (event) => {
              setAgentMessageState((message) => ({
                ...message,
                mode: "agent",
                liveReasoning: event.reasoning,
              }));
            },
            onToolCall: (event) => {
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

              setAgentMessageState((message) => ({
                ...message,
                content: event.response,
                agentRunId: doneEvent.agentRunId,
                agentSteps: event.steps,
                liveReasoning: undefined,
                liveToolCalls: [],
                interactive: event.interactive,
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
              setReconnecting(null);
              setError(message);
            },
            onReconnect: () => {
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
        });
      } catch (err) {
        setReconnecting(null);
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : errorMessage);
        }
      } finally {
        if (streamAbortRef.current === controller) {
          streamAbortRef.current = null;
        }
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
    ]
  );

  const submitPrompt = useCallback(
    async (
      prompt: string,
      attachments: ChatAttachment[] = [],
      overrides?: Partial<{ mode: ChatMode; provider: string; model: string; conversationId: string; reasoningEffort: ReasoningEffort }>
    ) => {
      // Quadruple guard against double-submit:
      // 1. Module-level lock (synchronous, survives React re-renders)
      // 2. Ref-based streaming flag (synchronous, survives closures)
      // 3. State-based pending flag (async, catches other paths)
      // 4. Content deduplication (prevents same prompt being submitted twice)
      if (_submitLock || isStreamingRef.current || pending) return;

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
      setMode,
      setSelectedProvider,
      setSelectedModel,
      setConversationId,
      setApiKeySwitchNotice,
      setMessages,
      executeAgentStream,
      executeChatStream,
    ]
  );

  const handleStopGeneration = useCallback(() => {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setPending(false);
    isStreamingRef.current = false;
  }, []);

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
      const originConversationId = sourceConversationId?.trim();
      if (!originConversationId) {
        setError("Could not continue in the same conversation. Please retry from the original thread.");
        return;
      }

      isStreamingRef.current = true;

      if (selectedConversationId !== originConversationId) {
        navigate(`/?c=${encodeURIComponent(originConversationId)}`, { replace: true });
      }

      await submitPrompt(prompt, [], {
        mode: targetMode,
        conversationId: originConversationId,
      });
    },
    [selectedConversationId, navigate, submitPrompt, setError]
  );

  const handleRegenerate = useCallback(
    async (assistantMessageId: string) => {
      if (pending) return;

      const assistantIndex = messages.findIndex((item) => item.id === assistantMessageId && item.role === "assistant");
      if (assistantIndex <= 0) return;

      const previous = messages[assistantIndex - 1];
      const target = messages[assistantIndex];

      if (!previous || previous.role !== "user" || !target) return;

      const prompt = previous.content.trim();
      if (!prompt) return;

      const modelToUse = target.model ?? selectedModel;
      const runProvider = target.provider ?? selectedProvider;
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

  const resetStreamState = useCallback(() => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }
    isStreamingRef.current = false;
    setPending(false);
    setReconnecting(null);
  }, []);

  return {
    pending,
    reconnecting,
    isStreamingRef,
    streamAbortRef,
    submitPrompt,
    handleStopGeneration,
    handleAgentToolApproval,
    handleModeSwitchApproval,
    handleRegenerate,
    handleResumeRun,
    handleFork,
    updateMessageById,
    resetStreamState,
  };
}
