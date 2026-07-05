// Public entry point for the agent loop.
//
// This file is a slim coordinator. The heavy lifting has been moved into:
//   - ./agent/types.ts          — shared types, constants, and pure utilities
//   - ./agent/response-parser.ts — assistant response parsing (JSON / XML / heuristics)
//   - ./agent/prompt-builder.ts  — system prompt, direct responses, provider messages
//   - ./agent/llm-client.ts      — HTTP streaming + API-key failover
//   - ./agent/tool-orchestrator.ts — tool execution, approval, batching, retry
//
// The Agent class composes these modules to drive the iterative tool-use loop.

import type { ToolExecutionContext } from "./tools.js";
import { toolRegistry } from "./tools.js";
import { buildTaskSummary } from "../tools/task-store.js";
import { LLMClient, buildOpenAITools, getAvailableTools } from "./agent/llm-client.js";
import { ToolOrchestrator } from "./agent/tool-orchestrator.js";
import {
  buildProviderMessages,
  buildSystemPrompt,
  createBroadAnalysisFallbackAskUser,
  getAskUserPayload,
  getInjectedSystemMessages,
  isAskUserOnlyClarification,
  shouldRequireInitialAskUserForBroadAnalysis
} from "./agent/prompt-builder.js";
import {
  createStreamThinkStripper,
  getIntentMatchedPhrase,
  looksLikeContinuationResponse,
  parseAssistantResponse,
  pushStreamThinkDelta
} from "./agent/response-parser.js";
import {
  getConfiguredLlmTimeoutMs,
  mergeTokenUsage,
  type AgentConfig,
  type AgentExecutionEvent,
  type AgentMessage,
  type AgentStep,
  type AgentTokenUsage,
  type ApiKeySwitchInfo,
  type FinalizedAskUserTurn,
  type ToolCall
} from "./agent/types.js";
import {
  applyReasoningDelta,
  createReasoningBudgetState,
  maybeMarkerLoopCorrection,
  REASONING_BUDGET_TOKENS_AGENT,
  REASONING_BUDGET_TOKENS_CHAT,
  REASONING_BUDGET_TOKENS_PLAN,
  type ReasoningBudgetState
} from "./agent/reasoning-budget.js";
import { startTrace, withSpan, recordEvent, setSpanAttribute, flushTrace } from "./agent/tracing.js";
import { estimateComplexity, scaleThreshold, type ComplexityAssessment } from "./agent/complexity.js";
import {
  runRuleLayerQA,
  hasFailedRule,
  summarizeQaIssues,
  type QaIssue
} from "./agent/qa-rules.js";
import {
  createWorkingMemory,
  persistWorkingMemory,
  type WorkingMemory
} from "./agent/working-memory.js";
import { getCompactionAction, compactHistory, type CompactionAction } from "./agent/context-compactor.js";
import { PROVIDER_HISTORY_CHAR_BUDGET, computeHistoryBudget } from "./agent/types.js";

/**
 * Per-mode defaults for `maxIterations` (research L3). Callers can still
 * override these by passing `maxIterations` explicitly in AgentConfig.
 */
const DEFAULT_MAX_ITERATIONS_BY_MODE: Record<string, number> = {
  chat: 4,
  plan: 25,
  agent: 50
};

function resolveMaxIterations(config: AgentConfig, mode: string | undefined): number {
  if (config.maxIterations > 0) return config.maxIterations;
  return DEFAULT_MAX_ITERATIONS_BY_MODE[mode ?? "agent"] ?? 12;
}

function resolveReasoningBudgetTokens(mode: string | undefined): number {
  switch (mode) {
    case "chat": return REASONING_BUDGET_TOKENS_CHAT;
    case "plan": return REASONING_BUDGET_TOKENS_PLAN;
    case "agent":
    default:
      return REASONING_BUDGET_TOKENS_AGENT;
  }
}

// Re-exports — preserve the public surface so existing consumers
// (`./routes/agent.ts`, `./agent-run-store.ts`, `./conversation-memory.ts`,
// `./usage.ts`) keep working without any change to their import paths.
export type {
  AgentConfig,
  AgentExecutionEvent,
  AgentMessage,
  AgentStep,
  AgentTokenUsage,
  ApiKeySwitchInfo,
  AskUserOption,
  AskUserPayload,
  AskUserQuestion,
  FinalizedAskUserTurn,
  ParsedAssistantResponse,
  ProviderAssistantMessage,
  ProviderChatMessage,
  ProviderTokenUsage,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolCall,
  ToolCallStatus
} from "./agent/types.js";

export {
  DEFAULT_LLM_TIMEOUT_MS,
  RETRY_LLM_TIMEOUT_MS,
  getConfiguredLlmTimeoutMs,
  mergeTokenUsage,
  normalizeTokenUsage,
  truncateText
} from "./agent/types.js";

export class Agent {
  private context: ToolExecutionContext;
  private config: AgentConfig;
  private history: AgentMessage[] = [];
  private steps: AgentStep[] = [];
  private tokenUsage: AgentTokenUsage = {};
  private initialized = false;
  private apiKeySwitch?: ApiKeySwitchInfo;
  /**
   * Per-run rolling window of recent tool-call signatures, used to detect when
   * the model is looping (emitting the same calls repeatedly). The Agent checks
   * this in `checkRetryDiversity` and nudges the model to switch approach.
   */
  private recentToolSignatures: string[] = [];
  /**
   * Odysseus-style stall detector. Increments when the model emits a round
   * with the same tool-call signature as a recent round AND no real text;
   * resets to 0 on any progress. When it crosses the threshold, the next
   * round is forced to be tool-free so the model commits to a final answer.
   */
  private stuckRounds = 0;
  /**
   * §5.3 — adaptive stall thresholds. Computed once at the start of
   * `stream()` from the user's prompt and the seed history. Stored
   * here so the per-iteration stall checks can read it without
   * recomputing.
   */
  private complexity: ComplexityAssessment | null = null;
  /**
   * Scaled per-run stall thresholds. Recomputed in `stream()` from
   * `this.complexity.thresholdMultiplier`. Defaults match the module
   * constants when the multiplier is 1.
   */
  private stallThresholds = {
    stuck: STUCK_THRESHOLD,
    noProgress: NO_PROGRESS_THRESHOLD,
    runaway: STUCK_RUNAWAY_THRESHOLD
  };
  /**
   * Cap on how many times we'll inject the intent-without-action nudge
   * ("You said you would X — call the actual tool now") in a single run.
   * Prevents a model that genuinely can't emit a tool from pinning us in
   * a forever nudge loop.
   */
  private intentNudgeCount = 0;
  /**
   * Tracks the cumulative count of each tool name across this run. Used to
   * catch the runaway case where the model fires a single tool type
   * hundreds of times (hard backstop — kicks in even if signatures vary).
   */
  private toolNameCounts: Map<string, number> = new Map();
  /**
   * Tracks the cumulative count of ALL tool calls across this run (across
   * all tools and all rounds). A hard ceiling that the iteration cap alone
   * can't enforce, because the model can emit many tools per round.
   */
  private totalToolCalls = 0;
  /**
   * Counts consecutive rounds in which the model emitted ONLY read-only
   * tools (filesystem reads, web reads) with no meaningful text progress.
   * Resets on any write/exec/ask_user call, or when the model emits
   * substantial text. Catches the "list_directory + read_file in alternation
   * forever" pattern that the signature-based detector misses.
   */
  private noProgressRounds = 0;
  /**
   * Tracks how many times each file path has been written/edited in this run.
   * Used to detect revision loops where the agent keeps polishing the same file.
   */
  private fileEditCounts: Map<string, number> = new Map();
  /**
   * True on the iteration immediately after a force-answer injection. The
   * tool-free round is forced by skipping tool execution and discarding
   * any tool calls the model emits. Reset to false after the round.
   */
  private forceAnswerNext = false;
  private llm: LLMClient;
  private tools: ToolOrchestrator;
  private workingMemory: WorkingMemory | null = null;
  private compactionSummary: string | undefined = undefined;
  private runStartTime = 0;

  constructor(context: ToolExecutionContext, config: AgentConfig, llmClient?: LLMClient) {
    this.context = context;
    this.config = config;
    // Test seam: an injected LLMClient lets tests drive the loop without a
    // network. Production callers omit it and get a real client wired with the
    // token-usage and API-key-failover callbacks below.
    this.llm = llmClient ?? new LLMClient({
      config,
      onTokenUsage: (usage) => {
        this.tokenUsage = mergeTokenUsage(this.tokenUsage, usage);
      },
      onApiKeySwitch: async (info) => {
        this.config.apiKey = info.newApiKey;
        this.config.primaryApiKeyId = info.newKeyId;
        this.config.primaryApiKeyName = info.newKeyName;
        this.apiKeySwitch = this.llm.getApiKeySwitch();
        await this.config.onApiKeySwitch?.({
          providerSettingId: this.config.providerSettingId,
          newKeyId: info.newKeyId
        });
      }
    });
    this.tools = new ToolOrchestrator({ context, config });
  }

  async run(userPrompt: string): Promise<{ response: string; steps: AgentStep[]; status: "completed" | "max_iterations" | "failed" | "interrupted" }> {
    let finalResponse = "";
    let finalSteps: AgentStep[] = [];
    let finalStatus: "completed" | "max_iterations" | "failed" | "interrupted" = "completed";

    for await (const event of this.stream(userPrompt)) {
      if (event.type === "step") {
        finalSteps = [...this.steps];
      }
      if (event.type === "done") {
        finalResponse = event.response;
        finalSteps = event.steps;
        finalStatus = event.status;
      }
    }

    return {
      response: finalResponse,
      steps: finalSteps,
      status: finalStatus
    };
  }

  async *stream(userPrompt: string | Array<Record<string, unknown>>): AsyncGenerator<AgentExecutionEvent> {
    this.runStartTime = Date.now();
    this.apiKeySwitch = undefined;
    this.history = [...(this.config.seedHistory ?? [])];
    this.history.push({
      role: "user",
      content: userPrompt
    });

    // Reset per-run supervisor state.
    this.stuckRounds = 0;
    this.intentNudgeCount = 0;
    this.forceAnswerNext = false;
    this.toolNameCounts = new Map();
    this.totalToolCalls = 0;
    this.noProgressRounds = 0;
    this.fileEditCounts = new Map();
    this.compactionSummary = undefined;

    // Initialize working memory and persist to disk as .rapa/working-memory.md.
    // The model can read/update this file with read_file/edit_file.
    // It survives context compaction and process restarts.
    const goalText = typeof userPrompt === "string" ? userPrompt : JSON.stringify(userPrompt);
    this.workingMemory = createWorkingMemory(goalText.slice(0, 500));
    if (this.context.workspaceRoot) {
      await persistWorkingMemory(this.context.workspaceRoot, this.workingMemory);
    }

    // Stale task guard: if the task store is empty but the conversation
    // history may contain references to tasks from a previous session,
    // inject a system message so the agent knows to create a fresh plan.
    // This prevents the agent from assuming planning is already done
    // when it sees old task references in the replayed history.
    if (!(await buildTaskSummary(this.context.conversationId))) {
      this.history.push({
        role: "system",
        content: "No task plan exists for this run. The conversation history may reference tasks from a previous session, but those are stale. If this task requires multiple steps, call plan_tasks NOW to create a fresh plan before doing any other work."
      });
    }

    // Apply per-mode defaults (L3).
    const mode = this.context.mode ?? "agent";
    const effectiveMaxIterations = resolveMaxIterations(this.config, mode);
    if (this.config.maxIterations <= 0) {
      this.config.maxIterations = effectiveMaxIterations;
    }

    // §5.3 — Estimate task complexity and scale the stall thresholds.
    // Trivial tasks get tight thresholds so we don't burn turns; complex
    // tasks (refactors, migrations) get loose thresholds so we don't
    // bail mid-work. Done once at the start of the run.
    const goalTextForComplexity = typeof userPrompt === "string" ? userPrompt : JSON.stringify(userPrompt);
    this.complexity = estimateComplexity(goalTextForComplexity, this.config.seedHistory);
    const mult = this.complexity.thresholdMultiplier;
    this.stallThresholds = {
      stuck: scaleThreshold(STUCK_THRESHOLD, mult),
      noProgress: scaleThreshold(NO_PROGRESS_THRESHOLD, mult),
      runaway: scaleThreshold(STUCK_RUNAWAY_THRESHOLD, mult)
    };

    // Open a root trace span (O2) for the entire agent run.
    const traceRoot = startTrace("agent.run", {
      conversationId: this.context.conversationId,
      model: this.config.model,
      mode
    });
    setSpanAttribute("maxIterations", effectiveMaxIterations);
    if (this.complexity) {
      setSpanAttribute("complexity.label", this.complexity.label);
      setSpanAttribute("complexity.score", this.complexity.score);
      setSpanAttribute("stallThresholds.stuck", this.stallThresholds.stuck);
      setSpanAttribute("stallThresholds.noProgress", this.stallThresholds.noProgress);
      setSpanAttribute("stallThresholds.runaway", this.stallThresholds.runaway);
    }

    yield {
      type: "start",
      conversationId: this.context.conversationId,
      model: this.config.model
    };

    const requiresInitialAskUser =
      typeof userPrompt === "string"
      && shouldRequireInitialAskUserForBroadAnalysis(userPrompt, this.config.isNewConversation, mode);
    let clarificationCorrectionCount = 0;
    let parseErrorCount = 0;
    let fileWriteCount = 0;
    let commandCount = 0;

    for (let iteration = 1, correctionCount = 0; iteration <= this.config.maxIterations; iteration += 1) {
      // Graduated compaction: check BEFORE the LLM call so the model always
      // sees a clean context. Warn at 55%, compact at 65%, force-answer at 85%.
      // Working memory survives via .rapa/working-memory.md on disk.
      // Adaptive budget: scales to 85% of the model's context window.
      // Explicit per-call override > env var > adaptive (model-based) > fixed default.
      const budget = this.config.memoryBudget?.historyCharBudget
        ?? computeHistoryBudget(this.config.model);
      const compactionAction = getCompactionAction(this.history, budget);

      if (compactionAction === "warn") {
        this.history.push({
          role: "user",
          content: "Context window is at 55% capacity. Start wrapping up your current task — finish the most critical remaining work (especially verification: run tests, check builds) and prepare your final answer soon."
        });
        yield {
          type: "thinking",
          iteration,
          reasoning: "[Context at 55% — warned model to start wrapping up]"
        };
      }

      if (compactionAction === "compact") {
        try {
          const llmCall = async (messages: Array<{ role: string; content: string }>) => {
            const result = await this.llm.callNonStreaming(messages, "compaction");
            return result;
          };
          const { compactedHistory, summary } = await compactHistory(
            this.history,
            budget,
            llmCall,
            this.compactionSummary
          );
          this.history = compactedHistory;
          this.compactionSummary = summary;

          // Inject task plan reminder after compaction — the plan_tasks result
          // was likely truncated, so we re-inject the current task state.
          const postCompactionTasks = await buildTaskSummary(this.context.conversationId);
          if (postCompactionTasks) {
            this.history.push({
              role: "system",
              content: `[TASK PLAN — restored after context compaction]\n${postCompactionTasks}\n\nContinue executing tasks in order. Mark each as completed via update_task before moving to the next.`
            });
          }

          yield {
            type: "thinking",
            iteration,
            reasoning: `[Context compacted at 65% — ${summary.length} chars summary. Working memory in .rapa/working-memory.md]`
          };
        } catch {
          // Compaction failure is non-fatal — continue with full history
        }
      }

      if (compactionAction === "force_answer") {
        this.forceAnswerNext = true;
        this.history.push({
          role: "user",
          content: "Context window is at 85% capacity. STOP all tool calls immediately. Write your best final answer NOW from the information already gathered. This is not optional."
        });
        yield {
          type: "thinking",
          iteration,
          reasoning: "[Context at 85% — forcing final answer]"
        };
      }

      let llmResponse: AgentMessage | undefined;
      // Per-iteration reasoning budget (L1, L2).
      const reasoningState: ReasoningBudgetState = createReasoningBudgetState(
        resolveReasoningBudgetTokens(mode)
      );
      try {
        const generator = this.callLLM();
        let currentReasoning = "";
        let currentContent = "";
        const thinkStripper = createStreamThinkStripper();
        let embeddedThinking = "";
        while (true) {
          const { value, done } = await generator.next();
          if (done) {
            llmResponse = value as AgentMessage;
            break;
          }
          if (value.reasoningDelta) {
            const budgetResult = applyReasoningDelta(reasoningState, value.reasoningDelta);
            if (budgetResult.accept && budgetResult.truncatedDelta) {
              currentReasoning += budgetResult.truncatedDelta;
              yield { type: "thinking", iteration, reasoning: currentReasoning };
            }
            if (budgetResult.budgetExhausted && currentReasoning.length > 0) {
              // Surface the budget cap so the UI can warn the user.
              yield {
                type: "thinking",
                iteration,
                reasoning: `${currentReasoning}\n\n[Reasoning budget exhausted — proceeding to tool call]`
              };
            }
            // Detect marker loops mid-stream.
            const loopCorrection = maybeMarkerLoopCorrection(reasoningState);
            if (loopCorrection) {
              this.history.push({
                role: "user",
                content: `[System] ${loopCorrection}`
              });
            }
          }
          if (value.contentDelta) {
            // Filter <thinking> tags from content stream.
            //
            // Primary path: for MiniMax-M3, `reasoning_split: true` is sent on
            // the request, so reasoning arrives in the dedicated
            // `reasoning_content` delta above and content arrives here clean.
            //
            // Defensive fallback: if a model regresses to embedding reasoning
            // inside the content field (older MiniMax, custom deployments,
            // or a non-minimax provider that behaves similarly), this
            // stripper extracts the <think>…</think> blocks so they are not
            // surfaced to the user as part of the assistant's prose.
            const stripped = pushStreamThinkDelta(thinkStripper, value.contentDelta);
            if (stripped.thinkingDelta) {
              embeddedThinking += stripped.thinkingDelta;
              currentReasoning += stripped.thinkingDelta;
              yield { type: "thinking", iteration, reasoning: currentReasoning };
            }
            if (stripped.displayDelta) {
              currentContent += stripped.displayDelta;
              yield { type: "assistant", iteration, content: currentContent, final: false };
            }
          }
        }
      } catch (error) {
        throw error;
      }
      if (!llmResponse) throw new Error("Generator completed without returning AgentMessage");

      const parsedResponse = parseAssistantResponse(
        typeof llmResponse.content === "string" ? llmResponse.content : JSON.stringify(llmResponse.content),
        llmResponse.reasoning,
        llmResponse.toolCalls
      );

      if (parsedResponse.parseError) {
        parseErrorCount += 1;

        // After repeated parse errors, the model is stuck in a JSON malformation loop.
        // Try grace synthesis first (one non-tool call asking the model to just write
        // the answer from gathered context); only if THAT fails do we bail. The
        // threshold is intentionally generous so a few stumbles don't kill the run.
        if (parseErrorCount >= 5) {
          const synthesized = await this.runGraceSynthesis(iteration);
          const fallbackResponse = synthesized
            ?? "I ran into repeated issues formatting tool calls. Could you try rephrasing your request or breaking it into smaller steps?";
          this.history.push({ role: "assistant", content: fallbackResponse });
          const step: AgentStep = {
            iteration,
            reasoning: `Parse error loop detected (${parseErrorCount} consecutive malformed responses). Bailing out with grace synthesis.`,
            toolCalls: [],
            toolResults: [],
            response: fallbackResponse,
            timestamp: new Date()
          };
          this.steps.push(step);
          yield { type: "assistant", iteration, content: fallbackResponse, final: true };
          yield { type: "step", step };
          yield* this.emitDone({
            type: "done",
            status: synthesized ? "completed" : "interrupted",
            response: fallbackResponse,
            steps: [...this.steps],
            iterations: this.steps.length,
            tokenUsage: this.getTokenUsage(),
            apiKeySwitch: this.apiKeySwitch
          });
          return;
        }

        // Mid-loop nudge: after a couple of errors, try grace synthesis early to
        // salvage the turn rather than burning two more corrective iterations.
        if (parseErrorCount >= 3) {
          const synthesized = await this.runGraceSynthesis(iteration);
          if (synthesized) {
            this.history.push({ role: "assistant", content: synthesized });
            const step: AgentStep = {
              iteration,
              reasoning: `Parse error loop (${parseErrorCount} malformed responses). Salvaged via grace synthesis.`,
              toolCalls: [],
              toolResults: [],
              response: synthesized,
              timestamp: new Date()
            };
            this.steps.push(step);
            yield { type: "assistant", iteration, content: synthesized, final: true };
            yield { type: "step", step };
            yield* this.emitDone({
              type: "done",
              status: "completed",
              response: synthesized,
              steps: [...this.steps],
              iterations: this.steps.length,
              tokenUsage: this.getTokenUsage(),
              apiKeySwitch: this.apiKeySwitch
            });
            return;
          }
        }

        const errorResult: ToolResultShape = {
          success: false,
          error: parsedResponse.parseError
        };
        const step: AgentStep = {
          iteration,
          reasoning: `The assistant returned malformed tool-call JSON (attempt ${parseErrorCount}) and was asked to retry with a concrete example.`,
          toolCalls: [],
          toolResults: [errorResult],
          timestamp: new Date()
        };

        this.steps.push(step);

        const correctionMsg = parseErrorCount >= 2
          ? `JSON still invalid (attempt ${parseErrorCount}). Error: ${parsedResponse.parseError}\nFix it now. Example: {"reasoning":"...","toolCalls":[{"id":"c1","name":"read_file","parameters":{"path":"file.ts"}}]}`
          : `Invalid JSON: ${parsedResponse.parseError}. Retry with valid JSON or respond in plain text.`;

        this.history.push({ role: "user", content: correctionMsg });

        yield { type: "error", message: parsedResponse.parseError, iteration };
        yield { type: "step", step };
        continue;
      }

      // Successful parse — reset consecutive parse error counter
      parseErrorCount = 0;

      if (requiresInitialAskUser && !isAskUserOnlyClarification(parsedResponse.toolCalls)) {
        clarificationCorrectionCount += 1;

        if (clarificationCorrectionCount > 3) {
          const fallbackAskUser = await createBroadAnalysisFallbackAskUser(
            userPrompt as string,
            this.steps.length,
            this.tools.getContext()
          );
          yield { type: "tool_call", iteration, status: "pending", call: fallbackAskUser.call };
          yield {
            type: "tool_call",
            iteration,
            status: "completed",
            call: fallbackAskUser.call,
            result: fallbackAskUser.result
          };

          const finalizedTurn = this.finalizeAskUserTurn(
            iteration,
            parsedResponse.reasoning || "The model did not provide the required clarification, so a fallback interactive question was generated.",
            [fallbackAskUser.call],
            [fallbackAskUser.result]
          );

          if (finalizedTurn) {
            yield { type: "assistant", iteration, content: finalizedTurn.response, final: true, interactive: finalizedTurn.interactive };
            yield { type: "step", step: finalizedTurn.step };
            yield* this.emitDone({
              type: "done",
              status: "completed",
              response: finalizedTurn.response,
              steps: [...this.steps],
              iterations: this.steps.length,
              tokenUsage: this.getTokenUsage(),
              interactive: finalizedTurn.interactive,
              apiKeySwitch: this.apiKeySwitch
            });
            return;
          }
        }

        const correctionResult: ToolResultShape = {
          success: false,
          error: "A broad codebase-analysis request on a new conversation must begin with a single ask_user tool call."
        };
        const step: AgentStep = {
          iteration,
          reasoning: parsedResponse.reasoning || "The request was broad and required clarification before any analysis or other tools could run.",
          toolCalls: parsedResponse.toolCalls,
          toolResults: [correctionResult],
          timestamp: new Date()
        };

        this.steps.push(step);
        this.history.push({
          role: "assistant",
          content: llmResponse.content,
          reasoning: llmResponse.reasoning,
          toolCalls: parsedResponse.toolCalls
        });
        this.history.push({
          role: "user",
          content: "This is a broad codebase-analysis request in a new conversation. Before doing any investigation, you must first ask the user to narrow the request by calling exactly one tool: ask_user. Do not read files, search the codebase, delegate, or call any other tool yet. Use the structured `questions` array schema (1-4 questions, each with 2-4 options that have label/description, a short header chip, and a multiSelect flag) — include choices for analysis type, scope, and goal. Respond ONLY with a JSON object containing exactly one tool call named ask_user."
        });

        yield { type: "thinking", iteration, reasoning: step.reasoning };
        yield { type: "step", step };
        continue;
      }

      if (parsedResponse.toolCalls.length === 0) {
        // When responseText is empty, fall back to reasoning content if available.
        // This handles the case where the model emitted tool call JSON as content
        // (the parser extracts tool calls but leaves responseText empty).
        let finalResponse = parsedResponse.responseText?.trim() || "";
        if (!finalResponse && parsedResponse.reasoning) {
          // Strip tool-call-related noise from reasoning, use the rest
          finalResponse = parsedResponse.reasoning
            .replace(/I('ll| will) (now )?(call|use|invoke|emit|run)\s.*/gi, "")
            .replace(/Let me (call|use|invoke|run|check|read|write|create)\s.*/gi, "")
            .trim()
            .slice(0, 2000);
        }
        if (!finalResponse) {
          finalResponse = "The agent completed but produced no visible response. Check the thinking panel for reasoning details.";
        }

        // The agent loop ends naturally on a tool-free round. A bare text response
        // IS the final answer. (We previously required an explicit completion
        // tool call to terminate, mirroring Cline. The new model — same as
        // Odysseus — treats "no tool calls" as the declaration of done. The
        // `result` field of a dedicated completion tool is now redundant with
        // the natural assistant text, and the tool had a confusing double-display
        // in the UI: a "task marked complete" tool card AND the assistant message.)
        // `expectsToolUse` already covers hasToolCallMarkup + looksLikeToolUseIntent
        // (which checks both visible content AND reasoning for tool-intent patterns).
        // When it's true and no tool calls were produced, the model planned to act but didn't —
        // regardless of how long the visible response text is.
        const missingToolCalls = parsedResponse.expectsToolUse;
        // Pass the reasoning channel too so the done-signal guard can
        // catch "no tool calls are needed" / "the work is done" in the
        // MiniMax reasoning field even when the visible content is a
        // short acknowledgment or empty.
        const looksUnfinished = looksLikeContinuationResponse(finalResponse, parsedResponse.reasoning);

        if (missingToolCalls || parsedResponse.needsContinuation || looksUnfinished) {
          correctionCount += 1;

          if (correctionCount > 5) {
            // After repeated nudges, the model is genuinely stuck. Salvage what we
            // have with a one-shot grace synthesis over the full conversation,
            // then bail. If the synthesis call also returns nothing, emit an
            // honest canned apology and mark the run interrupted so the user
            // can resume.
            const synthesized = await this.runGraceSynthesis(iteration);
            const fallbackResponse = synthesized
              ?? "I gathered some results but couldn't put a clean answer together. Want me to try a more specific question, or summarize what I did find?";
            this.history.push({ role: "assistant", content: fallbackResponse });
            const step: AgentStep = {
              iteration,
              reasoning: parsedResponse.reasoning || "Grace synthesis produced the final answer after multiple correction rounds.",
              toolCalls: [],
              toolResults: [],
              response: fallbackResponse,
              timestamp: new Date()
            };
            this.steps.push(step);
            yield { type: "assistant", iteration, content: fallbackResponse, final: true };
            yield { type: "step", step };
            yield* this.emitDone({
              type: "done",
              status: synthesized ? "completed" : "interrupted",
              response: fallbackResponse,
              steps: [...this.steps],
              iterations: this.steps.length,
              tokenUsage: this.getTokenUsage(),
              apiKeySwitch: this.apiKeySwitch
            });
            return;
          }

          // Intent-without-action supervisor (Odysseus). Catches "Let me read X" /
          // "I'll do Y" / "I should tail the output" — short text that promises an
          // action but emits no tool call. Inject ONE sharp nudge, then continue.
          // Cap the nudges so a model that genuinely cannot emit a tool doesn't
          // pin us in a forever loop.
          const intentMatch = missingToolCalls || parsedResponse.needsContinuation
            ? null
            : detectIntentWithoutAction(finalResponse);
          if (intentMatch && this.intentNudgeCount < MAX_INTENT_NUDGES) {
            this.intentNudgeCount += 1;
            const step: AgentStep = {
              iteration,
              reasoning: `Intent-without-action nudge #${this.intentNudgeCount}: model wrote "${intentMatch}" but emitted no tool call.`,
              toolCalls: [],
              toolResults: [],
              timestamp: new Date()
            };
            this.steps.push(step);
            this.history.push({
              role: "assistant",
              content: parsedResponse.responseText?.trim() || ""
            });
            this.history.push({
              role: "user",
              content: `You wrote "${intentMatch}" but made no tool call. Call the tool NOW, or say you changed your mind in one sentence.`
            });
            yield { type: "thinking", iteration, reasoning: step.reasoning };
            yield { type: "step", step };
            continue;
          }

          const correctionResult: ToolResultShape = {
            success: false,
            error: looksUnfinished
              ? "The model produced an unfinished continuation response instead of a complete answer or valid tool calls. It was asked to continue properly."
              : parsedResponse.expectsToolUse
                ? "The model planned to use tools but did not emit a toolCalls JSON object. It was asked to retry with tool calls."
                : "The model returned hidden reasoning without visible content or tool calls. It was asked to continue."
          };
          const step: AgentStep = {
            iteration,
            reasoning: parsedResponse.reasoning || "The model produced hidden reasoning or tool-use intent without a usable response.",
            toolCalls: [],
            toolResults: [correctionResult],
            timestamp: new Date()
          };

          // Nudge cap: max 2 corrections to prevent infinite loops (matches odysseus)
          if (parsedResponse.expectsToolUse && this.intentNudgeCount >= MAX_INTENT_NUDGES) {
            // Already nudged twice — treat as final answer instead of correcting
            this.history.push({ role: "assistant", content: finalResponse });
            const step: AgentStep = {
              iteration,
              reasoning: parsedResponse.reasoning,
              toolCalls: [],
              toolResults: [],
              response: finalResponse,
              timestamp: new Date()
            };
            this.steps.push(step);
            yield { type: "assistant", iteration, content: finalResponse, final: true };
            yield { type: "step", step };
            yield* this.emitDone({
              type: "done",
              status: "completed",
              response: finalResponse,
              steps: [...this.steps],
              iterations: this.steps.length,
              tokenUsage: this.getTokenUsage(),
              apiKeySwitch: this.apiKeySwitch
            });
            return;
          }

          const matchedPhrase = parsedResponse.expectsToolUse
            ? getIntentMatchedPhrase(parsedResponse.responseText || "", parsedResponse.reasoning)
            : null;

          this.steps.push(step);
          this.history.push({
            role: "assistant",
            content: parsedResponse.responseText?.trim() || "[Previous assistant response contained hidden reasoning without visible content.]",
            reasoning: llmResponse.reasoning
          });

          let correctionContent: string;
          if (parsedResponse.expectsToolUse && matchedPhrase) {
            this.intentNudgeCount++;
            correctionContent = `You just wrote: "${matchedPhrase}" — but ended the turn without making the actual tool call. The user can see you announced the action but didn't run it. DO IT NOW: emit the actual tool call this turn. If you decided not to do it after all, say so plainly in one sentence instead of restating the plan.`;
          } else if (parsedResponse.expectsToolUse) {
            this.intentNudgeCount++;
            correctionContent = "You planned to use tools but didn't emit a toolCalls JSON. Do it now: {\"reasoning\":\"...\",\"toolCalls\":[{\"id\":\"c1\",\"name\":\"tool_name\",\"parameters\":{}}]}";
          } else if (looksUnfinished) {
            correctionContent = "Your response was unfinished — you promised an action but didn't call the tool. Call it now.";
          } else {
            correctionContent = "Your response had no visible answer or tool calls. Respond with a toolCalls JSON or a plain text answer.";
          }

          this.history.push({
            role: "user",
            content: correctionContent
          });

          yield { type: "thinking", iteration, reasoning: step.reasoning };
          yield { type: "step", step };
          continue;
        }

        this.history.push({ role: "assistant", content: finalResponse });

        const step: AgentStep = {
          iteration,
          reasoning: parsedResponse.reasoning,
          toolCalls: [],
          toolResults: [],
          response: finalResponse,
          timestamp: new Date()
        };
        this.steps.push(step);

        yield { type: "assistant", iteration, content: finalResponse, final: true };
        yield { type: "step", step };
        yield* this.emitDone({
          type: "done",
          status: "completed",
          response: finalResponse,
          steps: [...this.steps],
          iterations: this.steps.length,
          tokenUsage: this.getTokenUsage(),
          apiKeySwitch: this.apiKeySwitch
        });
        return;
      }

      yield { type: "thinking", iteration, reasoning: parsedResponse.reasoning };

      this.history.push({
        role: "assistant",
        content: llmResponse.content,
        reasoning: llmResponse.reasoning,
        toolCalls: parsedResponse.toolCalls
      });

      for (const call of parsedResponse.toolCalls) {
        yield { type: "tool_call", iteration, status: "pending", call };
      }

      for (const call of parsedResponse.toolCalls) {
        const toolDef = toolRegistry.get(call.name);
        if (!toolDef || !this.tools.needsToolApproval(toolDef.definition)) continue;
        yield {
          type: "tool_call",
          iteration,
          status: "requires_approval",
          call,
          result: this.tools.buildApprovalRequiredResult(call)
        };
      }

      // Deduplicate identical tool calls within this response. Models occasionally
      // emit the same call twice in one turn (often accidentally). Repeating it gives
      // the model no new information, so reject as a no-op and let it move on.
      const dedupedToolCalls = deduplicateToolCalls(parsedResponse.toolCalls);
      if (dedupedToolCalls.rejected.length > 0) {
        for (const dup of dedupedToolCalls.rejected) {
          yield {
            type: "tool_call",
            iteration,
            status: "completed",
            call: dup.call,
            result: {
              success: false,
              error: `Duplicate of an earlier tool call in the same response was skipped (tool: ${dup.call.name}). If you intended a different action, change a parameter and call it again.`
            }
          };
        }
      }

      // Retry-diversity check: if the model emits the same call signatures as a
      // previous iteration, force a switch-approach nudge instead of burning the
      // iteration on a retry that will fail the same way.
      const diversityNudge = this.checkRetryDiversity(dedupedToolCalls.calls);

      // Force-answer round (Odysseus pattern) — checked BEFORE the stall detector
      // below. On the previous iteration we told the model "STOP calling tools and
      // answer now." If it emitted a tool call anyway (models often do), we honor
      // the directive immediately rather than re-tripping the stall detector and
      // looping forever. Discard the tool calls; keep the prose. If there's no
      // prose either, run grace synthesis and bail as `interrupted` so the user
      // can resume. This must run before the stall check, otherwise a stuck model
      // re-trips the stall detector every round and the force-answer branch below
      // the tool execution becomes unreachable — the run just burns all iterations.
      if (this.forceAnswerNext) {
        this.forceAnswerNext = false;
        const proseOnly = (llmResponse.content ?? "").toString().trim();
        if (proseOnly) {
          // Model complied: take the prose as the final answer.
          this.history.push({ role: "assistant", content: proseOnly });
          const step: AgentStep = {
            iteration,
            reasoning: parsedResponse.reasoning || "Force-answer round: model produced a final answer after stall detection.",
            toolCalls: [],
            toolResults: [],
            response: proseOnly,
            timestamp: new Date()
          };
          this.steps.push(step);
          yield { type: "assistant", iteration, content: proseOnly, final: true };
          yield { type: "step", step };
          yield* this.emitDone({
            type: "done",
            status: "completed",
            response: proseOnly,
            steps: [...this.steps],
            iterations: this.steps.length,
            tokenUsage: this.getTokenUsage(),
            apiKeySwitch: this.apiKeySwitch
          });
          return;
        }
        // Model ignored the force-answer and produced no prose either. Run grace
        // synthesis; if that also yields nothing, mark the run interrupted so the
        // resume UI offers to continue instead of showing a dead "completed" run.
        const synthesized = await this.runGraceSynthesis(iteration);
        const fallbackResponse = synthesized
          ?? "I gathered some results but couldn't put a clean answer together. Want me to try a more specific question, or summarize what I did find?";
        this.history.push({ role: "assistant", content: fallbackResponse });
        const step: AgentStep = {
          iteration,
          reasoning: parsedResponse.reasoning || "Grace synthesis after force-answer round produced nothing.",
          toolCalls: [],
          toolResults: [],
          response: fallbackResponse,
          timestamp: new Date()
        };
        this.steps.push(step);
        yield { type: "assistant", iteration, content: fallbackResponse, final: true };
        yield { type: "step", step };
        yield* this.emitDone({
          type: "done",
          status: synthesized ? "completed" : "interrupted",
          response: fallbackResponse,
          steps: [...this.steps],
          iterations: this.steps.length,
          tokenUsage: this.getTokenUsage(),
          apiKeySwitch: this.apiKeySwitch
        });
        return;
      }

      // Stall detector (Odysseus pattern). A round is "useless" ONLY when it
      // re-issues a recent tool-call signature AND writes no real text — i.e.
      // the model is going in circles. Genuine exploration (new, distinct
      // calls) is never useless, so multi-step work (file hunts, build→test→
      // fix loops) rides all the way to a real answer. We bail only on a
      // streak of useless rounds, or on a single tool fired an absurd number
      // of times (hard runaway backstop). On bail we don't give up — we force
      // one tool-free round so the model declares done or declares blocked,
      // mirroring Terminus's explicit-completion handshake.
      const thisSignature = computeTurnSignature(dedupedToolCalls.calls);
      const isRepeat = this.recentToolSignatures.includes(thisSignature);
      const realText = (llmResponse.content ?? "").toString().trim();
      if (isRepeat && !realText) {
        this.stuckRounds += 1;
      } else {
        this.stuckRounds = 0;
      }
      for (const c of dedupedToolCalls.calls) {
        this.toolNameCounts.set(c.name, (this.toolNameCounts.get(c.name) ?? 0) + 1);
        this.totalToolCalls += 1;
      }

      // Rapa-specific: no-progress detector. The signature-based check above
      // misses the screenshot scenario where the model alternates between
      // list_directory and read_file with different paths. Every signature
      // is unique, neither tool hits the single-name runaway, and the loop
      // rides all the way to the iteration cap with no convergence. We add
      // a third detector: count consecutive rounds in which the model emitted
      // ONLY read-only tools (filesystem/web reads) with little/no text.
      // Resets whenever the model produces substantial text or calls a
      // progress-marking tool (write, exec, ask_user, summarize_progress).
      const allReadOnly = dedupedToolCalls.calls.every((c) => READ_ONLY_TOOLS.has(c.name));
      const progressToolCalled = dedupedToolCalls.calls.some((c) => PROGRESS_TOOLS.has(c.name));
      if (allReadOnly && realText.length < MIN_PROGRESS_TEXT_CHARS && !progressToolCalled) {
        this.noProgressRounds += 1;
      } else {
        this.noProgressRounds = 0;
      }

      // Revision loop detector: track how many times each file is edited.
      // If the same file is written/edited too many times, the agent may be
      // polishing in a loop rather than making genuine progress.
      // IMPORTANT: test files get a higher threshold (12) because fixing
      // test failures legitimately requires many edits (one per bug).
      const EDIT_TOOLS = new Set(["write_file", "edit_file", "replace_in_file", "append_file"]);
      for (const c of dedupedToolCalls.calls) {
        if (EDIT_TOOLS.has(c.name)) {
          const filePath = (c.parameters as Record<string, unknown>)?.path as string
            ?? (c.parameters as Record<string, unknown>)?.filePath as string
            ?? "unknown";
          const count = (this.fileEditCounts.get(filePath) ?? 0) + 1;
          this.fileEditCounts.set(filePath, count);
        }
      }
      // Test files get a higher threshold — fixing test failures requires
      // multiple edits (one per bug). Non-test files use the standard threshold.
      const isTestFile = (path: string) => /test[_-]|[_-]test\.|spec\.|\.test\.|\.spec\./i.test(path);
      const revisionLoopEntry = Array.from(this.fileEditCounts.entries()).find(([path, n]) => {
        const threshold = isTestFile(path) ? REVISION_LOOP_TEST_THRESHOLD : REVISION_LOOP_THRESHOLD;
        return n >= threshold;
      });
      const revisionLoopFile = revisionLoopEntry?.[0];

      const runawayEntry = Array.from(this.toolNameCounts.entries()).find(([, n]) => n >= this.stallThresholds.runaway);
      const runawayTool = runawayEntry?.[0];
      const noProgressTripped = this.noProgressRounds >= this.stallThresholds.noProgress;
      const totalCallsTripped = this.totalToolCalls >= TOTAL_TOOL_CALL_CAP;
      const revisionLoopTripped = !!revisionLoopFile;
      if (this.stuckRounds >= this.stallThresholds.stuck || runawayTool || noProgressTripped || totalCallsTripped || revisionLoopTripped) {
        let reason: string;
        if (totalCallsTripped) {
          reason = `firing too many tools overall (${this.totalToolCalls} tool calls in this run)`;
        } else if (revisionLoopTripped) {
          reason = `editing the same file (${revisionLoopFile}) too many times — the deliverable is likely already complete`;
        } else if (runawayTool) {
          reason = `calling ${runawayTool} over and over`;
        } else if (noProgressTripped) {
          reason = "doing read-only exploration in a loop without making progress (no write/exec tool called and little to no text in the last several turns)";
        } else {
          reason = "repeating the same tool calls without new progress";
        }
        // Force the NEXT round to be tool-free. The model has its tool results
        // already in context, so it can answer from them — or state plainly
        // what's blocking it.
        this.forceAnswerNext = true;
        this.history.push({
          role: "user",
          content: `You're ${reason}. STOP calling tools and end the turn one of two ways: (a) write your best final answer NOW from the information already gathered, or (b) if you're genuinely blocked, say plainly what's blocking you in a sentence or two.`
        });
        yield {
          type: "thinking",
          iteration,
          reasoning: `Stall detector: ${reason}. Forcing tool-free round.`
        };
        continue;
      }

      const toolResults = await this.tools.executeToolCallsInBatches(dedupedToolCalls.calls);
      correctionCount = 0;

      for (const call of dedupedToolCalls.calls) {
        const result = toolResults[parsedResponse.toolCalls.indexOf(call)];
        const status = this.getToolCallStatus(result);
        yield { type: "tool_call", iteration, status, call, result: result! };

        // Track file writes and command executions for progress reporting
        if (call.name === "write_file" || call.name === "edit_file" || call.name === "append_file") {
          fileWriteCount++;
        }
        if (call.name === "execute_command") {
          commandCount++;
        }
      }

      if (parsedResponse.toolCalls.some((call) => call.name === "ask_user")) {
        const finalizedTurn = this.finalizeAskUserTurn(
          iteration,
          parsedResponse.reasoning,
          parsedResponse.toolCalls,
          toolResults
        );
        if (finalizedTurn) {
          yield { type: "assistant", iteration, content: finalizedTurn.response, final: true, interactive: finalizedTurn.interactive };
          yield { type: "step", step: finalizedTurn.step };
          yield* this.emitDone({
            type: "done",
            status: "completed",
            response: finalizedTurn.response,
            steps: [...this.steps],
            iterations: this.steps.length,
            tokenUsage: this.getTokenUsage(),
            interactive: finalizedTurn.interactive,
            apiKeySwitch: this.apiKeySwitch
          });
          return;
        }
      }

      const step: AgentStep = {
        iteration,
        reasoning: parsedResponse.reasoning,
        toolCalls: dedupedToolCalls.calls,
        toolResults,
        timestamp: new Date()
      };
      const injectedSystemMessages = getInjectedSystemMessages(parsedResponse.toolCalls, toolResults);

      this.steps.push(step);
      this.history.push({
        role: "tool",
        content: JSON.stringify(toolResults),
        toolResults
      });
      if (injectedSystemMessages.length > 0) {
        this.history.push(...injectedSystemMessages);
      }

      // Task plan reminder: inject every iteration so the agent always knows
      // its current task status. Compact one-liner to save context budget.
      const taskSummary = await buildTaskSummary(this.context.conversationId);
      if (taskSummary) {
        this.history.push({
          role: "system",
          content: `[Progress] ${taskSummary} | ${fileWriteCount} file(s) written, ${commandCount} command(s) run. Execute the next pending task or mark the current one completed.`
        });
      }

      if (diversityNudge) {
        // Surface the diversity nudge in history so the next LLM call sees it.
        this.history.push({ role: "user", content: diversityNudge });
        yield { type: "thinking", iteration, reasoning: diversityNudge };
      }

      // Checkpoint validation: run lint (always) and tests (when source files modified)
      const validationResults = await this.tools.runCheckpointValidation(dedupedToolCalls.calls, toolResults);
      for (const result of validationResults) {
        const toolName = result.data && typeof result.data === "object" && "testResults" in (result.data as object)
          ? "run_tests"
          : "read_lints";

        this.history.push({
          role: "tool",
          content: JSON.stringify([result]),
          toolResults: [result]
        });

        yield {
          type: "tool_call",
          iteration,
          status: result.success ? "completed" : "failed",
          call: { id: crypto.randomUUID(), name: toolName, parameters: {} },
          result
        };
      }

      yield { type: "step", step };
    }

    const finalResponse = "I reached the maximum number of iterations. The task may be incomplete.";
    this.history.push({ role: "assistant", content: finalResponse });

    yield { type: "assistant", iteration: this.config.maxIterations, content: finalResponse, final: true };
    yield* this.emitDone({
      type: "done",
      status: "max_iterations",
      response: finalResponse,
      steps: [...this.steps],
      iterations: this.steps.length,
      tokenUsage: this.getTokenUsage(),
      apiKeySwitch: this.apiKeySwitch
    });
  }

  private getToolCallStatus(result: ToolResultShape): "pending" | "running" | "completed" | "failed" | "requires_approval" {
    if (!result.success && typeof result.data === "object" && result.data !== null && "requiresApproval" in result.data) {
      return "requires_approval";
    }
    return result.success ? "completed" : "failed";
  }

  /**
   * Run the lightweight rule-layer QA (research Q1) against the final
   * response. Returns the list of issues so the caller can log/annotate.
   * Does NOT modify the response — that's the caller's job, since we don't
   * want to surprise existing UI consumers. The issues are recorded on the
   * trace so they're visible in dashboards.
   */
  private runFinalQaCheck(finalResponse: string): QaIssue[] {
    const toolsCalled: string[] = [];
    for (const step of this.steps) {
      for (const call of step.toolCalls ?? []) {
        if (!toolsCalled.includes(call.name)) toolsCalled.push(call.name);
      }
    }
    const issues = runRuleLayerQA({
      response: finalResponse,
      steps: this.steps,
      toolsCalled
    });
    if (issues.length > 0) {
      recordEvent("qa.rule_issues", { count: issues.length, summary: summarizeQaIssues(issues).slice(0, 500) });
      setSpanAttribute("qa.failed", hasFailedRule(issues));
      setSpanAttribute("qa.warningCount", issues.filter((i) => i.severity === "warn").length);
      setSpanAttribute("qa.failCount", issues.filter((i) => i.severity === "fail").length);
    }
    return issues;
  }

  /**
   * Wrap a `done` event yield: run QA, log the issues, flush the trace, and
   * annotate the done event with `qa` field. This is the single chokepoint
   * for terminal event emission so we don't have to touch every yield site.
   */
  private async* emitDone(
    event: AgentExecutionEvent & { type: "done" }
  ): AsyncGenerator<AgentExecutionEvent> {
    const qaIssues = this.runFinalQaCheck(event.response);
    const elapsedMs = this.runStartTime > 0 ? Date.now() - this.runStartTime : undefined;
    const enriched = {
      ...event,
      elapsedMs,
      qa: {
        issues: qaIssues,
        passed: !hasFailedRule(qaIssues)
      }
    };
    yield enriched;
    flushTrace();
  }

  private finalizeAskUserTurn(
    iteration: number,
    reasoning: string | undefined,
    toolCalls: ToolCall[],
    toolResults: ToolResultShape[]
  ): FinalizedAskUserTurn | null {
    const userQuestionCall = toolCalls.find((call) => call.name === "ask_user");
    if (!userQuestionCall) return null;

    const askResult = toolResults[toolCalls.indexOf(userQuestionCall)];
    const askPayload = getAskUserPayload(userQuestionCall, askResult);
    if (!askPayload) return null;

    const { questions } = askPayload;
    const primaryQuestion = questions[0]?.question ?? "I need a quick clarification to continue.";
    // For single-question turns, show the question text directly (preserves the existing UX).
    // For multi-question turns, show a brief intro so the user isn't reading the same text twice.
    const responseText = questions.length === 1
      ? primaryQuestion
      : `I need a few quick clarifications (${questions.length}) before I continue.`;

    const injectedSystemMessages = getInjectedSystemMessages(toolCalls, toolResults);
    const step: AgentStep = {
      iteration,
      reasoning,
      toolCalls,
      toolResults,
      response: responseText,
      timestamp: new Date()
    };

    this.steps.push(step);
    this.history.push({
      role: "tool",
      content: JSON.stringify(toolResults),
      toolResults
    });
    if (injectedSystemMessages.length > 0) {
      this.history.push(...injectedSystemMessages);
    }
    this.history.push({ role: "assistant", content: responseText });

    const interactivePayload = questions.length > 0
      ? { type: "ask_user" as const, questions }
      : undefined;
    return { response: responseText, step, interactive: interactivePayload };
  }

  private async *callLLM() {
    const tools = getAvailableTools(this.context.mode ?? "agent", this.config.allowedToolNames);
    const openAITools = buildOpenAITools(tools);
    const timeoutMs = getConfiguredLlmTimeoutMs();
    // P2-C: per-call memory budget overrides from the agent config. When
    // unset, the prompt builder uses the module-level defaults.
    const budget = this.config.memoryBudget;

    const generator = this.llm.streamChat(
      buildProviderMessages(this.history, undefined, false, budget),
      timeoutMs,
      openAITools
    );

    let result = await generator.next();
    while (!result.done) {
      const chunk = result.value;
      yield chunk;
      result = await generator.next();
    }
    return result.value;
  }

  getHistory(): AgentMessage[] {
    return this.history;
  }

  getSteps(): AgentStep[] {
    return this.steps;
  }

  getTokenUsage(): AgentTokenUsage | undefined {
    if (
      this.tokenUsage.promptTokens === undefined
      && this.tokenUsage.completionTokens === undefined
      && this.tokenUsage.totalTokens === undefined
    ) {
      return undefined;
    }
    return this.tokenUsage;
  }

  /**
   * Detect when the model is making the same tool calls it tried before, and
   * return a nudge to push it toward a different approach. The nudge is empty
   * on the first occurrence, escalating in strength each time the same turn
   * signature repeats. This is the Aider-style "diversity check" from
   * callsphere.tech's reflection pattern.
   */
  checkRetryDiversity(calls: ToolCall[]): string {
    const signature = computeTurnSignature(calls);
    const recent = this.recentToolSignatures;

    // First occurrence: just record, no nudge.
    if (!recent.includes(signature)) {
      this.recentToolSignatures.unshift(signature);
      if (this.recentToolSignatures.length > RECENT_TURNS_TO_TRACK) {
        this.recentToolSignatures.pop();
      }
      return "";
    }

    // Same turn signature appeared before — count consecutive repeats.
    const repeatCount = recent.filter((s) => s === signature).length;

    if (repeatCount === 1) {
      return "You just tried the same set of tool calls in a previous turn. The result is unlikely to change unless you change at least one parameter or switch to a different tool. Re-read the relevant file/section and pick a different anchor or approach.";
    }

    if (repeatCount === 2) {
      return "You are repeating the same tool calls for the third time. Stop and switch approach: re-read the actual file content, change the unique anchor string in your oldText, or use a different tool (e.g. read_file the whole file then write_file the corrected content instead of surgical edit_file).";
    }

    // 3+ repeats: hard stop and force the model to think.
    return "You are stuck in a tool-call loop. STOP calling tools with the same arguments. Instead: (1) read_file the full file, (2) explicitly describe what you are about to change and why, (3) call exactly one tool with parameters that are provably different from your last attempt.";
  }

  /**
   * Last-resort synthesis call. Used when the model has gathered data via tools
   * but failed to produce a final answer (stuck in a loop, hit the correction
   * cap, or ignored the force-answer nudge). We ask the same model one blunt,
   * non-streaming question over the full conversation and take whatever it
   * returns. If THAT also returns nothing, the caller emits a canned apology.
   *
   * Mirrors the grace-synthesis fallback in Odysseus's agent_loop.py
   * (force_answer branch around the "grace synthesis failed" log line).
   */
  private async runGraceSynthesis(iteration: number): Promise<string | null> {
    try {
      // Append a one-shot instruction. The model has every tool result in
      // `this.history` already; we just need it to write the prose.
      const synthPrompt: AgentMessage = {
        role: "user",
        content: "Using ONLY the information already gathered above, write the final answer for the user now. Do NOT call any tools, do NOT explain your reasoning — output the finished response directly. If some data couldn't be fetched, just work with what you have and note what's missing in one short line."
      };
      const history = [...this.history, synthPrompt];
      // Convert AgentMessage[] (which includes "tool" role) into the provider
      // format expected by streamChat. buildProviderMessages collapses tool
      // results back into user-facing text.
      const providerMessages = buildProviderMessages(history, undefined, true);
      const generator = this.llm.streamChat(providerMessages, 30_000, []);
      let result = await generator.next();
      let accumulated = "";
      while (!result.done) {
        const chunk = result.value as { type?: string; contentDelta?: string; reasoningDelta?: string };
        if (chunk?.type === "assistant" && chunk.contentDelta) {
          accumulated += chunk.contentDelta;
        }
        result = await generator.next();
      }
      const final = result.value as AgentMessage | undefined;
      const text = (final?.content ?? accumulated).toString().trim();
      return text.length > 0 ? text : null;
    } catch (err) {
      recordEvent("grace_synthesis_failed", { iteration, error: String(err) });
      return null;
    }
  }
}

type ToolResultShape = {
  success: boolean;
  data?: unknown;
  error?: string;
  output?: string;
};

/**
 * Hash a tool call's parameters deterministically so two calls with the same
 * (name, params) are recognized as duplicates. Sorted by key so {a:1,b:2} === {b:2,a:1}.
 */
function hashToolCallParams(name: string, params: Record<string, unknown>): string {
  const sorted = JSON.stringify(params, Object.keys(params).sort());
  return `${name}::${sorted}`;
}

/**
 * Deduplicate identical tool calls within a single assistant turn. If the model
 * emitted the same (name, params) twice, keep the first and reject the rest as
 * a no-op duplicate (informative error instead of wasting a tool execution).
 */
function deduplicateToolCalls(calls: ToolCall[]): { calls: ToolCall[]; rejected: Array<{ call: ToolCall }> } {
  const seen = new Set<string>();
  const kept: ToolCall[] = [];
  const rejected: Array<{ call: ToolCall }> = [];
  for (const call of calls) {
    const signature = hashToolCallParams(call.name, call.parameters);
    if (seen.has(signature)) {
      rejected.push({ call });
      continue;
    }
    seen.add(signature);
    kept.push(call);
  }
  return { calls: kept, rejected };
}

/**
 * Track the last few iterations' tool-call signatures on the Agent instance.
 * If a new turn emits the same signatures as a recent turn, the model is looping
 * and we nudge it to change approach instead of burning the iteration.
 */
const RECENT_TURNS_TO_TRACK = 5;

function computeTurnSignature(calls: ToolCall[]): string {
  return calls.map((c) => hashToolCallParams(c.name, c.parameters)).sort().join("|");
}

// ─────────────────────────────────────────────────────────────────────────
// Odysseus-style supervisor constants.
//
// STUCK_THRESHOLD: how many consecutive useless rounds (same tool signature
// + no real text) before we force the next round to be tool-free.
//
// STUCK_RUNAWAY_THRESHOLD: any single tool fired this many times in a run
// (regardless of signature variation) is a runaway — same response.
//
// MAX_INTENT_NUDGES: cap on the "you said you would X but emitted no tool"
// nudges. Prevents a model that genuinely cannot emit a tool call from
// pinning us in a forever nudge loop.
// ─────────────────────────────────────────────────────────────────────────
const STUCK_THRESHOLD = 6;
const STUCK_RUNAWAY_THRESHOLD = 15;
const MAX_INTENT_NUDGES = 2;
// Rapa-specific: detect alternating read-only exploration loops (e.g. alternating
// list_directory + read_file with different paths). The signature-based check
// misses this because every signature is unique, and the single-tool-name
// runaway misses it because no one tool hits 8. We bail after this many
// consecutive "read-only tools, no text, no progress-marking tool" rounds.
const NO_PROGRESS_THRESHOLD = 7;
// Minimum characters of "real" text (after trim) for a round to count as
// producing progress. Short text + intent phrases don't reset the counter.
const MIN_PROGRESS_TEXT_CHARS = 50;
// Absolute ceiling on total tool calls per run. The iteration cap alone isn't
// enough because the model can emit several tool calls per round.
// Set generously (500) to avoid interrupting complex multi-step tasks.
const TOTAL_TOOL_CALL_CAP = 500;
// Revision loop detector: if the same file is edited this many times in a
// single run, the agent is likely in an endless polish loop rather than
// making genuine progress. Triggers the force-answer handshake.
// Non-test files use this threshold (8). Test files use a higher threshold
// (12) because fixing test failures legitimately requires many edits.
const REVISION_LOOP_THRESHOLD = 8;
const REVISION_LOOP_TEST_THRESHOLD = 12;
// Tools that count as "read-only" for the no-progress detector. Listing them
// explicitly (rather than inferring from a flag) is more transparent and
// matches the user's mental model.
const READ_ONLY_TOOLS: Set<string> = new Set([
  "read_file",
  "list_directory",
  "search_files",
  "search_content",
  "read_lints",
  "web_search",
  "fetch_url",
  "list_changed_files",
  "list_scheduled_tasks",
  "list_notification_channels",
  "mcp_list_servers",
  "browser_read"
]);
// Tools whose presence in a round counts as forward progress, regardless of
// how much text the model emitted. Calling write/exec/ask_user/summarize
// means the model is doing something — that round should reset the
// no-progress counter even if its text is sparse.
const PROGRESS_TOOLS: Set<string> = new Set([
  "write_file",
  "edit_file",
  "replace_in_file",
  "append_file",
  "delete_file",
  "rename_file",
  "mkdir",
  "execute_command",
  "start_process",
  "ask_user",
  "summarize_progress",
  "summarize_conversation",
  "plan_tasks",
  "update_task",
  "update_working_memory",
  "add_task",
  "list_tasks",
  // §2.x — new progress-marking tools
  "render_widget",
  "present_file",
  "generate_image",
  "create_document",
  "send_notification",
  "send_email",
  "schedule_task",
  "cancel_scheduled_task",
  "browser_click",
  "browser_type",
  "browser_navigate"
]);

/**
 * Detect "intent without action" — short assistant text that promises a tool
 * call ("let me read X", "I'll do Y", "I should tail the logs") but the model
 * actually emitted no tool. Returns the matched phrase (for echoing in the
 * nudge) or null if the text doesn't look like an unfinished promise.
 *
 * Conservative — only matches when:
 *   - The response is short (< 400 chars)
 *   - There are no fenced code blocks
 *   - There's a "let me / I'll / I should / let's / I will" phrase
 *
 * Long answers that happen to contain "let me know" are not stalls.
 */
const INTENT_PHRASE_RE = /\b(let me|let'?s|i'?ll|i will|i should|i'?m going to|i am going to|next,?\s+i'?ll|now,?\s+i'?ll)\b[^.!?\n]{0,80}/i;

function detectIntentWithoutAction(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length >= 400) return null;
  if (/```/.test(trimmed)) return null;
  const match = INTENT_PHRASE_RE.exec(trimmed);
  return match ? match[0].trim() : null;
}
