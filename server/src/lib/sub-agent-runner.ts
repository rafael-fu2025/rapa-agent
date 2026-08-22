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

  // Specialist selection: matched by task content, defaulting to the
  // research specialist's methodology for unmatched tasks.
  const specialists = resolveSpecialistDefinitions();
  const matched = classifySpecialistMode(handle.task, specialists)
    ?? specialists.find((s) => s.name === "research_specialist")
    ?? null;
  const allowedToolNames = deriveAllowedTools(matched?.suggestedTools);

  const seedHistory: AgentMessage[] = [];
  const workspaceInstructions = await loadWorkspaceInstructionsSystemMessage(parentContext.workspaceRoot);
  if (workspaceInstructions) seedHistory.push(workspaceInstructions);
  seedHistory.push({
    role: "system",
    content: [
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
    ].filter(Boolean).join("\n\n")
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
  const report = [
    reportBody || (errorMessage ? `Child agent failed: ${errorMessage}` : "Child agent produced no final report."),
    "",
    "--- child agent summary ---",
    `task: ${handle.task.slice(0, 200)}`,
    `mode: ${matched?.name ?? "research_specialist"}`,
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
