// Sub-agent runner — executes a spawned child agent to completion.
//
// The specialist catalog historically only augmented the PARENT agent's
// prompt ("same-agent specialist guidance"). This runner upgrades
// `spawn_agent` into true delegation: a fresh-context child Agent with a
// restricted read-only toolset runs the task in isolation and hands back a
// structured report. The parent's context only pays for the report — the
// investigation's token burn stays in the child.
//
// Design constraints:
//   - Children are READ-ONLY. The allowlist is intersected with a safe set
//     so even a malicious DB-defined specialist cannot grant write tools.
//   - Nesting is capped (MAX_AGENT_DEPTH); a child cannot spawn children
//     beyond the limit.
//   - Children never touch .rapa/working-memory.md (guarded in agent.ts by
//     agentDepth) and never ask the user for approval.

import { Agent } from "./agent.js";
import type { LLMClient } from "./agent/llm-client.js";
import type { ToolExecutionContext } from "./tools.js";
import type { AgentConfig, AgentExecutionEvent, AgentMessage } from "./agent/types.js";
import { classifySpecialistMode, resolveSpecialistDefinitions } from "./sub-agents.js";
import { loadWorkspaceInstructionsSystemMessage } from "./workspace-instructions.js";
import { childAgentRegistry, type ChildAgentHandle } from "../tools/sub-agents.js";

/** Maximum spawn nesting (parent = depth 0). */
export const MAX_AGENT_DEPTH = 2;
/** Wall-clock budget for one child run. */
export const CHILD_RUN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The only tools a child agent may ever use, regardless of what a
 * specialist's suggestedTools claims. Write/shell/ask_user are excluded.
 */
export const CHILD_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_directory",
  "search_files",
  "search_content",
  "fetch_url",
  "web_search",
  "git_diff",
  "git_log",
  "git_status",
  "think",
  "summarize_progress",
  "read_lints"
]);

/** Per-breadth sweep guidance baked into the explore child's system prompt. */
const EXPLORE_BREADTH_GUIDE: Record<string, string> = {
  quick: "QUICK breadth — spot check. 1-3 tool calls, then report. Prefer list_directory + one targeted read.",
  medium: "MEDIUM breadth — standard sweep. Map the relevant area, then answer; stop as soon as you can.",
  very_thorough: "VERY THOROUGH breadth — exhaustive sweep. Cover every plausible area (directories, search passes, git history if useful) before reporting."
};

export function buildChildSystemPrompt(handle: ChildAgentHandle, matched: { name: string; instructions: string } | null): string {  if (handle.agentType === "explore") {
    return [
      "You are an isolated EXPLORE child agent spawned by a parent agent for ONE bounded codebase-analysis task.",
      `Breadth: ${EXPLORE_BREADTH_GUIDE[handle.breadth] ?? EXPLORE_BREADTH_GUIDE.medium}`,
      "",
      "Method:",
      "- Locate, don't audit. Find where things live and how they connect. Read excerpts and signatures, not whole files, unless the task demands it.",
      "- Cite evidence. Every claim carries a path — file.ts:line when you know the line, bare path otherwise. No uncited assertions.",
      "- Report conclusions, not process. Outcome first, then key findings as a compact list, then assumptions. No narration of what you are about to do.",
      "- Read-only: never modify files. You cannot ask the user questions — make reasonable assumptions and note them.",
      `- Stay within ${handle.maxIterations} iterations. Finish with the report, not with tool calls. The parent sees ONLY your final answer — make it self-contained.`
    ].join("\n");
  }

  return [
    "You are an isolated child agent spawned by a parent agent to complete ONE bounded task.",
    matched
      ? `Operating mode — ${matched.name}:\n\n${matched.instructions}`
      : "",
    [
      "Rules:",
      "- Your tools are READ-ONLY. Report what you find; never modify files.",
      "- You cannot ask the user questions — make reasonable assumptions and note them.",
      `- The parent sees ONLY your final answer. Make it a self-contained report: outcome, key findings, file paths, and any assumptions.`,
      `- Stay within ${handle.maxIterations} iterations. Finish with the report, not with tool calls.`
    ].join("\n")
  ].filter(Boolean).join("\n\n");
}

export type ChildAgentRunOutcome = {
  status: "completed" | "failed" | "cancelled";
  report: string;
  toolCallCount: number;
  iterationCount: number;
};

function deriveAllowedTools(suggested: string[] | undefined): string[] {
  const requested = suggested ?? [];
  const allowed = new Set<string>(CHILD_SAFE_TOOLS);
  for (const tool of requested) {
    if (CHILD_SAFE_TOOLS.has(tool)) allowed.add(tool);
  }
  return [...allowed];
}

/**
 * Build a child AgentConfig from the parent's tool-execution LLM context
 * (the shape available to SpawnAgentTool inside execute()).
 */
export function buildChildConfig(
  llm: ToolExecutionContext["llm"],
  handle: ChildAgentHandle,
  seedHistory: AgentMessage[],
  allowedToolNames: string[]
): AgentConfig {
  return {
    maxIterations: handle.maxIterations,
    autoApproveTools: [],
    provider: llm?.provider ?? "ollama",
    model: llm?.model ?? "",
    baseUrl: llm?.baseUrl ?? "",
    apiKey: llm?.apiKey ?? "ollama",
    // resolveKeysToTry() only admits the primary key when primaryApiKeyId is
    // set. Without it the child had zero usable keys and every LLM call
    // failed with "LLM call failed: no keys available" (the parent works
    // because createAgent always sets the id). These ids are bookkeeping
    // only — the child has no onApiKeySwitch handler, so nothing persists.
    primaryApiKeyId: llm?.apiKey ? `${handle.id}-primary` : undefined,
    primaryApiKeyName: llm?.apiKey ? "inherited from parent" : undefined,
    fallbackApiKeys: llm?.fallbackApiKeys?.map((key) => ({
      apiKeyEncrypted: key.apiKeyEncrypted,
      id: key.id,
      name: key.id
    })),
    encryptionSecret: llm?.encryptionSecret,
    seedHistory,
    allowedToolNames
  };
}

/**
 * Run a spawned child agent to completion (synchronous delegation — the
 * caller blocks until the child finishes, is cancelled, or times out).
 * Updates the registry handle and returns the outcome; never throws.
 * `llmClient` is the Agent constructor's test seam — pass a stub in tests;
 * production callers omit it and the child builds its own client.
 */
export async function runChildAgent(
  parentContext: ToolExecutionContext,
  parentConfig: AgentConfig | undefined,
  handle: ChildAgentHandle,
  llmClient?: LLMClient
): Promise<ChildAgentRunOutcome> {
  const parentDepth = parentContext.agentDepth ?? 0;
  if (parentDepth >= MAX_AGENT_DEPTH) {
    childAgentRegistry.update(handle.id, {
      status: "failed",
      error: `Spawn refused: nesting limit reached (depth ${parentDepth}, max ${MAX_AGENT_DEPTH}).`,
      completedAt: new Date()
    });
    return {
      status: "failed",
      report: `Child agent was not started: the nesting limit (depth ${MAX_AGENT_DEPTH}) was reached. Handle the task directly instead of spawning another agent.`,
      toolCallCount: 0,
      iterationCount: 0
    };
  }

  // Specialist selection: general runs match a specialist by task content
  // (defaulting to the research specialist's methodology); explore runs skip
  // specialists entirely — they have their own locate-and-cite methodology.
  const isExplore = handle.agentType === "explore";
  const specialists = resolveSpecialistDefinitions();
  const matched = isExplore
    ? null
    : classifySpecialistMode(handle.task, specialists)
      ?? specialists.find((s) => s.name === "research_specialist")
      ?? null;
  const allowedToolNames = isExplore
    ? [...CHILD_SAFE_TOOLS]
    : deriveAllowedTools(matched?.suggestedTools);

  const seedHistory: AgentMessage[] = [];
  // Explore skips workspace instruction files (AGENTS.md/CLAUDE.md) — the
  // same speed/cost tradeoff ZCode's Explore agent makes; locating code does
  // not need them and they can be large.
  if (!isExplore) {
    const workspaceInstructions = await loadWorkspaceInstructionsSystemMessage(parentContext.workspaceRoot);
    if (workspaceInstructions) seedHistory.push(workspaceInstructions);
  }
  seedHistory.push({
    role: "system",
    content: buildChildSystemPrompt(handle, matched)
  });

  const childConfig = parentConfig
    ? { ...parentConfig, maxIterations: handle.maxIterations, seedHistory, allowedToolNames, autoApproveTools: [], requestToolApproval: undefined }
    : buildChildConfig(parentContext.llm, handle, seedHistory, allowedToolNames);

  const childContext: ToolExecutionContext = {
    ...parentContext,
    mode: "agent",
    agentDepth: parentDepth + 1,
    runId: undefined
  };

  const child = new Agent(childContext, childConfig, llmClient);

  const timeout = setTimeout(() => handle.abortController?.abort(), CHILD_RUN_TIMEOUT_MS);
  let doneEvent: Extract<AgentExecutionEvent, { type: "done" }> | undefined;
  let errorMessage: string | undefined;
  try {
    childAgentRegistry.update(handle.id, { status: "running" });
    for await (const event of child.stream(handle.task, { signal: handle.abortController?.signal })) {
      if (event.type === "done") doneEvent = event;
      if (event.type === "error") errorMessage = event.message;
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
  }

  const steps = child.getSteps();
  const toolCallCount = steps.reduce((count, step) => count + step.toolCalls.length, 0);
  const filesExamined = new Set<string>();
  for (const step of steps) {
    for (const call of step.toolCalls) {
      const path = call.parameters?.path;
      if (typeof path === "string" && path) filesExamined.add(path);
    }
  }

  const aborted = handle.abortController?.signal.aborted === true;
  const status: ChildAgentRunOutcome["status"] = aborted
    ? "cancelled"
    : doneEvent && doneEvent.status !== "failed"
      ? "completed"
      : errorMessage || !doneEvent
        ? "failed"
        : "completed";

  const reportBody = doneEvent?.response ?? "";
  // A "completed" child that never called a tool answered from imagination,
  // not evidence — flag it so the parent (and user) can't mistake it for a
  // grounded report. Live runs showed weak models doing exactly this.
  const ungrounded = status === "completed" && toolCallCount === 0;
  const report = [
    ungrounded
      ? "WARNING: this child agent completed WITHOUT calling any tools — its findings are unverified inference, not grounded evidence. Re-spawn with a more explicit task or verify the claims yourself."
      : "",
    reportBody || (errorMessage ? `Child agent failed: ${errorMessage}` : "Child agent produced no final report."),
    "",
    "--- child agent summary ---",
    `task: ${handle.task.slice(0, 200)}`,
    handle.agentType === "explore"
      ? `mode: explore (${handle.breadth})`
      : `mode: ${matched?.name ?? "research_specialist"}`,
    `iterations: ${steps.length}/${handle.maxIterations}, tool calls: ${toolCallCount}`,
    filesExamined.size > 0
      ? `paths examined: ${[...filesExamined].slice(0, 20).join(", ")}`
      : ""
  ].filter(Boolean).join("\n");

  childAgentRegistry.update(handle.id, {
    status,
    result: report,
    error: status === "failed" ? errorMessage : undefined,
    toolCallCount,
    iterationCount: steps.length,
    completedAt: new Date()
  });

  return { status, report, toolCallCount, iterationCount: steps.length };
}
