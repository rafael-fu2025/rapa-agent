// Tool execution, approval, batching, retry, and mode-based restrictions.
// Encapsulates the stateful machinery the Agent class uses to run tool calls.

import { isWithinWorkspaceSymlinkSafe, resolveWorkspacePath } from "../../tools/filesystem.js";
import { toolRegistry } from "../../tools/index.js";
import { isDangerousCommand } from "../../tools/shell.js";
import { analyseCommandRisk, type CommandRiskAssessment } from "../safety/dangerous-patterns.js";
import { detectPromptInjection, wrapUntrustedContent } from "../safety/prompt-injection.js";
import type {
  AgentExecutionMode,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult
} from "../tools.js";
import { getAvailableTools } from "./llm-client.js";
import type {
  AgentConfig,
  ToolApprovalDecision,
  ToolCall,
  ToolCallStatus
} from "./types.js";
import { executeWithResilience } from "./resilience.js";
import { shouldEvictResult, evictResult, type EvictableResult } from "./output-eviction.js";
import { validateWrittenFile } from "./code-validators.js";
import { buildSchemaCorrection, renderSchemaCorrection } from "./schema-correction.js";
import { resolve as resolvePath } from "node:path";

/**
 * Detect wasteful environment-check commands that burn turns without producing
 * useful information. The system prompt already forbids these, but models
 * sometimes ignore it — blocking at the tool level saves a full iteration.
 */
const ENV_CHECK_PATTERNS = [
  /^\s*pwd\b/i,
  /\b(node|npm|npx|python3?|pip3?|ruby|java|go|rustc|cargo)\s+(-{1,2}version|--version|-v|-V)\b/i,
  /\b(ls\s+-la|ls\s+-al|dir\s*$|dir\s+\/)/i,
  /^\s*(whoami|uname|hostname|echo\s+\$SHELL|echo\s+%USERNAME%)\b/i,
  /^\s*(echo\s+["']node:|echo\s+["']npm:)/i,
];

/**
 * Tools that create or modify files in the workspace. Used for:
 * - Auto-injecting update_working_memory after successful writes
 * - Skipping output eviction for recently-written files
 */
const FILE_MUTATING_TOOLS = new Set([
  "write_file",
  "edit_file",
  "replace_in_file",
  "append_file"
]);

function isEnvironmentCheck(command: string): boolean {
  // Only block if the ENTIRE command is an environment check.
  // Don't block "npm install && node server.js" — only pure checks.
  const trimmed = command.trim();
  // If the command has pipes/chains with actual work, let it through
  if (trimmed.includes("&&") || trimmed.includes("||") || trimmed.includes(";") || trimmed.includes("|")) {
    // Check if ALL parts are environment checks
    const parts = trimmed.split(/\s*(?:&&|\|\||;|\|)\s*/);
    return parts.every((part) => ENV_CHECK_PATTERNS.some((re) => re.test(part.trim())));
  }
  return ENV_CHECK_PATTERNS.some((re) => re.test(trimmed));
}

const REJECTION_PHRASES = [
  "rejected by the user",
  "requires approval",
  "not available in chat mode",
  "blocked in plan mode"
];

// Legacy fallback patterns; the typed resilience layer supersedes these but
// they are kept for direct callers of retryToolCall().
const RETRYABLE_PATTERNS: Array<{ pattern: RegExp; fix: string }> = [
  { pattern: /timed out/i, fix: "reducing scope" },
  { pattern: /ENOENT|no such file/i, fix: "checking path" },
  { pattern: /EACCES|permission denied/i, fix: "adjusting permissions" },
  { pattern: /command not found/i, fix: "checking tool availability" },
  { pattern: /ECONNREFUSED|fetch failed/i, fix: "checking connectivity" },
  { pattern: /EEXIST|already exists/i, fix: "checking if resource already exists" },
  { pattern: /EISDIR|is a directory/i, fix: "checking if path is a file" },
  { pattern: /ENOTDIR|not a directory/i, fix: "checking if path is a directory" },
  { pattern: /EBUSY|resource busy/i, fix: "waiting for resource" }
];

const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "replace_in_file",
  "append_file",
  "delete_file",
  "mkdir",
  "rename_file"
]);

// Tools that ingest untrusted external content (file data, web pages, search
// results). Their output is scanned for indirect prompt injection before being
// forwarded to the LLM (OWASP Agentic Top 10 — ASI01).
const UNTRUSTED_INPUT_TOOLS = new Set([
  "read_file",
  "search_content",
  "fetch_url",
  "web_search",
  "search_files"
]);

const PLAN_MODE_ALLOWED_TOOLS = new Set([
  "read_file",
  "list_directory",
  "search_files",
  "search_content",
  "fetch_url",
  "web_search",
  "think",
  "ask_user",
  "add_task",
  "update_task",
  "summarize_progress",
  "delegate_task",
  "git_status",
  "git_diff",
  "git_log",
  "git_branch"
]);

const CHAT_MODE_RESTRICTED_CATEGORIES: ToolDefinition["category"][] = [
  "filesystem",
  "code",
  "shell"
];

function isRejectionError(result: ToolResult): boolean {
  if (typeof result.data === "object" && result.data !== null && "rejected" in result.data) {
    return true;
  }
  return REJECTION_PHRASES.some((phrase) => result.error?.includes(phrase));
}

function getToolCallStatus(result: ToolResult): ToolCallStatus {
  if (!result.success && typeof result.data === "object" && result.data !== null && "requiresApproval" in result.data) {
    return "requires_approval";
  }
  return result.success ? "completed" : "failed";
}

function extractWriteTargetPath(call: ToolCall, workspaceRoot: string): string | null {
  const path = typeof call.parameters.path === "string" && call.parameters.path.trim()
    ? call.parameters.path.trim()
    : typeof call.parameters.filePath === "string" && call.parameters.filePath.trim()
      ? call.parameters.filePath.trim()
      : typeof call.parameters.target_file === "string" && call.parameters.target_file.trim()
        ? call.parameters.target_file.trim()
        : null;
  if (!path) return null;
  try {
    return resolveWorkspacePath(path, workspaceRoot).toLowerCase();
  } catch {
    return path.toLowerCase();
  }
}

export type ToolOrchestratorOptions = {
  context: ToolExecutionContext;
  config: AgentConfig;
};

/**
 * Owns tool-calling policy: which tools are allowed, how they are batched and
 * approved, and how they recover from transient errors. Pure transport of
 * ToolResult[]; the Agent class consumes those results.
 */
export class ToolOrchestrator {
  private context: ToolExecutionContext;
  private config: AgentConfig;
  /** Files written during this agent run — used to skip eviction on re-reads. */
  private writtenFiles: Set<string> = new Set();

  constructor(options: ToolOrchestratorOptions) {
    this.context = options.context;
    this.config = options.config;
  }

  getContext(): ToolExecutionContext {
    return this.context;
  }

  updateContext(partial: Partial<ToolExecutionContext>) {
    this.context = { ...this.context, ...partial };
  }

  isToolAvailable(toolName: string): boolean {
    return getAvailableTools(this.context.mode ?? "agent", this.config.allowedToolNames)
      .some((tool) => tool.name === toolName);
  }

  isToolAutoApproved(definition: ToolDefinition): boolean {
    if (!definition.requiresApproval) return true;
    return this.config.autoApproveTools.includes(definition.name)
      || this.config.autoApproveTools.includes(definition.category);
  }

  needsToolApproval(definition: ToolDefinition): boolean {
    return Boolean(definition.requiresApproval) && !this.isToolAutoApproved(definition);
  }

  buildApprovalRequiredResult(call: ToolCall, options: { riskAssessment?: CommandRiskAssessment } = {}): ToolResult {
    return {
      success: false,
      error: `Tool ${call.name} requires approval before it can run.`,
      errorCategory: "permission",
      fatal: false,
      data: {
        requiresApproval: true,
        approvalId: `${this.context.conversationId}:${call.id}`,
        conversationId: this.context.conversationId,
        callId: call.id,
        tool: call.name,
        parameters: call.parameters,
        risk: options.riskAssessment
          ? {
              severity: options.riskAssessment.severity,
              summary: options.riskAssessment.summary,
              matches: options.riskAssessment.matches.map((m) => ({
                id: m.pattern.id,
                label: m.pattern.label,
                explanation: m.pattern.explanation,
                consequence: m.pattern.consequence,
                matchedText: m.matchedText,
                severity: m.pattern.severity
              }))
            }
          : undefined
      }
    };
  }

  /**
   * Shell command risk overlay (P2-A). If a shell tool call contains a
   * command that matches a dangerous pattern, the call is forced to require
   * approval even when the tool itself is in the auto-approve list. This is
   * the safety net the user explicitly asked for — the agent can never
   * `rm -rf` a system directory without a human in the loop.
   */
  private getCommandRiskForCall(call: ToolCall): CommandRiskAssessment | undefined {
    if (call.name !== "execute_command") return undefined;
    const cmd = typeof call.parameters.command === "string" ? call.parameters.command : undefined;
    if (!cmd) return undefined;

    const risk = analyseCommandRisk(cmd);

    // Layer the allowlist check (VULN-15): if the command is not on the
    // known-safe allowlist, force user approval even when no dangerous
    // pattern matched. This catches unusual commands that slip past the
    // regex-based pattern detector.
    if (!risk.requiresConfirmation && isDangerousCommand(cmd)) {
      risk.requiresConfirmation = true;
      risk.severity = "high";
      risk.summary.push(
        "Command is not on the known-safe allowlist and will be reviewed before execution."
      );
    }

    return risk;
  }

  /**
   * Returns true when a shell call contains a dangerous pattern and so
   * must be approved, regardless of the tool's auto-approve setting.
   */
  needsCommandRiskApproval(call: ToolCall): boolean {
    const risk = this.getCommandRiskForCall(call);
    return Boolean(risk?.requiresConfirmation);
  }

  private async requestToolApproval(call: ToolCall, definition: ToolDefinition): Promise<ToolApprovalDecision> {
    if (!this.config.requestToolApproval) {
      return { approved: false, message: `Tool ${call.name} requires approval before it can run.` };
    }

    return this.config.requestToolApproval({
      call,
      definition,
      conversationId: this.context.conversationId,
      workspaceRoot: this.context.workspaceRoot
    });
  }

  private async resolveToolApproval(call: ToolCall): Promise<{ approved: boolean; message?: string; riskAssessment?: CommandRiskAssessment }> {
    const tool = toolRegistry.get(call.name);
    if (!tool) return { approved: false, message: `Tool ${call.name} not found` };
    const riskAssessment = this.getCommandRiskForCall(call);
    const forcedByRisk = Boolean(riskAssessment?.requiresConfirmation);
    if (!this.needsToolApproval(tool.definition) && !forcedByRisk) return { approved: true };

    const decision = await this.requestToolApproval(call, tool.definition);
    if (!decision.approved) {
      return { approved: false, message: decision.message || `Tool ${call.name} was rejected by the user.`, riskAssessment };
    }
    return { approved: true, riskAssessment };
  }

  getModeToolRestrictionError(
    mode: AgentExecutionMode,
    toolName: string,
    category: ToolDefinition["category"]
  ): string | null {
    if (!this.isToolAvailable(toolName)) {
      return `Tool ${toolName} is not available in this agent configuration. Use only the tools listed in the prompt.`;
    }

    if (mode === "chat") {
      if (CHAT_MODE_RESTRICTED_CATEGORIES.includes(category)) {
        return `Tool ${toolName} is not available in chat mode. This tool requires Editor mode to access files and execute commands.`;
      }
      return null;
    }

    if (mode === "plan") {
      if (!PLAN_MODE_ALLOWED_TOOLS.has(toolName)) {
        return `Tool ${toolName} is blocked in plan mode. Plan mode can inspect and reason, but cannot perform side-effectful actions.`;
      }
    }

    return null;
  }

  private async isPathOutsideWorkspace(call: ToolCall): Promise<boolean> {
    const path = typeof call.parameters.path === "string" && call.parameters.path.trim()
      ? call.parameters.path.trim()
      : undefined;

    if (!path) {
      const searchPath = typeof call.parameters.searchPath === "string" && call.parameters.searchPath.trim()
        ? call.parameters.searchPath.trim()
        : undefined;
      if (!searchPath) return false;
      const fullPath = resolveWorkspacePath(searchPath, this.context.workspaceRoot);
      return !(await isWithinWorkspaceSymlinkSafe(fullPath, this.context.workspaceRoot));
    }

    const fullPath = resolveWorkspacePath(path, this.context.workspaceRoot);
    return !(await isWithinWorkspaceSymlinkSafe(fullPath, this.context.workspaceRoot));
  }

  private async executeToolCall(call: ToolCall, options: { approved?: boolean } = {}): Promise<ToolResult> {
    const tool = toolRegistry.get(call.name);
    if (!tool) {
      return {
        success: false,
        error: `Tool ${call.name} not found`,
        errorCategory: "fatal"
      };
    }

    const mode = this.context.mode ?? "agent";
    const modeRestrictionError = this.getModeToolRestrictionError(mode, call.name, tool.definition.category);
    if (modeRestrictionError) {
      return { success: false, error: modeRestrictionError, errorCategory: "validation" };
    }

    // Block wasteful environment-check commands at the tool level.
    // The system prompt already forbids these, but models sometimes ignore it.
    // Returning an immediate error saves a full turn of wasted execution.
    if (call.name === "execute_command") {
      const cmd = (call.parameters as Record<string, unknown>)?.command;
      if (typeof cmd === "string" && isEnvironmentCheck(cmd)) {
        return {
          success: false,
          error: `BLOCKED: "${cmd}" is a wasteful environment check. Node.js, Python, npm, and all tools are pre-installed. The workspace path is known. Go directly to building. Use list_directory if you need to see workspace files.`,
          errorCategory: "validation"
        };
      }
    }

    if (this.needsToolApproval(tool.definition) && !options.approved) {
      return this.buildApprovalRequiredResult(call);
    }

    // P2-A / P2-B: dangerous command overlay. Even if the tool is auto-approved
    // (e.g. execute_command is in `autoApproveTools`), force the user to
    // confirm any command that matches a high-severity pattern.
    const riskAssessment = this.getCommandRiskForCall(call);
    if (riskAssessment?.requiresConfirmation && !options.approved) {
      return this.buildApprovalRequiredResult(call, { riskAssessment });
    }

    if (tool.definition.riskLevel === "read" && (await this.isPathOutsideWorkspace(call))) {
      if (!options.approved) {
        return this.buildApprovalRequiredResult(call);
      }
      this.updateContext({ allowOutsideWorkspace: true });
    }

    const validation = tool.validate(call.parameters);
    if (!validation.valid) {
      const baseResult: ToolResult = {
        success: false,
        error: `Invalid parameters: ${validation.errors?.join(", ")}`,
        errorCategory: "validation",
        fatal: true
      };
      // Self-healing harness (research C3): include a structured correction
      // the model can act on. The next LLM call sees this in the tool_result
      // and can re-emit a corrected tool call.
      const correction = buildSchemaCorrection(
        call.name,
        tool.definition,
        call.parameters,
        baseResult
      );
      if (correction) {
        baseResult.data = {
          ...((baseResult.data as object) ?? {}),
          schemaCorrection: correction,
          correctionHint: renderSchemaCorrection(correction)
        };
      }
      return baseResult;
    }

    const result = await executeWithResilience({
      toolName: call.name,
      execute: () => tool.execute(call.parameters, this.context),
      context: this.context
    });

    // Indirect prompt injection scan (OWASP ASI01): tools that ingest
    // external content (files, web pages, search results) may carry hidden
    // instructions. Scan successful results and wrap suspicious output so the
    // LLM treats it as untrusted data.
    if (result.success && UNTRUSTED_INPUT_TOOLS.has(call.name)) {
      const outputText = typeof result.output === "string"
        ? result.output
        : typeof result.data === "object" && result.data !== null && "content" in result.data
          ? String((result.data as Record<string, unknown>).content)
          : null;

      if (outputText && outputText.length > 0) {
        const verdict = detectPromptInjection(outputText);
        if (verdict.status === "blocked") {
          result.output = wrapUntrustedContent(outputText, verdict);
          result.data = {
            ...((result.data as object) ?? {}),
            injectionDetected: true,
            injectionVerdict: verdict.status
          };
        } else if (verdict.status === "suspicious") {
          result.output = wrapUntrustedContent(outputText, verdict);
          result.data = {
            ...((result.data as object) ?? {}),
            injectionDetected: true,
            injectionVerdict: verdict.status
          };
        }
      }
    }

    // Post-write code validation (research C1): for write tools, syntax-check
    // the changed file. Catches ~60-80% of "looks-correct" bugs.
    if (result.success && WRITE_TOOLS.has(call.name)) {
      const writePath = extractWriteTargetPath(call, this.context.workspaceRoot);
      if (writePath) {
        const absolute = resolvePath(this.context.workspaceRoot, writePath);
        try {
          const codeCheck = await validateWrittenFile(absolute);
          if (!codeCheck.ok) {
            return {
              success: false,
              error: codeCheck.message ?? "Code validation failed",
              errorCategory: "validation",
              fatal: false,
              data: {
                ...((result.data as object) ?? {}),
                writeSucceeded: true,
                validationFailed: true,
                validator: codeCheck.validator,
                suggestion: "Please fix the syntax errors and rewrite the file."
              }
            };
          }
          result.data = {
            ...((result.data as object) ?? {}),
            validatedBy: codeCheck.validator
          };
        } catch {
          // Validation itself failed (compiler missing, etc.) — don't block the
          // write. The model can still see the result.
        }
      }
    }

    return result;
  }

  private async retryToolCall(call: ToolCall, previousResult: ToolResult): Promise<ToolResult | null> {
    // Only retry transient failures; the resilience layer already exhausted
    // its retries. This is a "nudge" retry that lets the model see the failure
    // once before giving up.
    const category = previousResult.errorCategory ?? "fatal";
    if (category === "validation" || category === "permission" || category === "fatal") {
      return null;
    }

    const retryResult = await this.executeToolCall(call, { approved: true });
    if (retryResult.success) {
      retryResult.data = { ...(retryResult.data as object ?? {}), retried: true, previousError: previousResult.error };
      return retryResult;
    }
    return null;
  }

  /**
   * P2-D: Tool result truncation. After a tool call returns, bound the
   * size of any string fields so a single noisy tool (e.g. `cat`-ing a
   * megabyte log) doesn't blow the LLM's context window. The default
   * cap is 50_000 characters and can be overridden per-call via
   * `TOOL_OUTPUT_MAX_CHARS` env or `config.memoryBudget.toolResultCharLimit`.
   *
   * Truncation is non-destructive: we keep the original result intact and
   * surface a `truncated: true` flag plus a preview on `data`.
   */
  private truncateToolResult(result: ToolResult, call: ToolCall): ToolResult {
    const cap = this.config.memoryBudget?.toolResultCharLimit
      ?? Number(process.env.TOOL_OUTPUT_MAX_CHARS ?? 50_000);
    if (!Number.isFinite(cap) || cap <= 0) return result;
    if (!result.output && !result.data) return result;
    const output = result.output ?? "";
    if (output.length <= cap && typeof result.data !== "string") {
      return result;
    }
    const truncatedOutput = output.length > cap
      ? `${output.slice(0, cap)}\n...[truncated ${output.length - cap} chars]`
      : output;
    let truncatedData: unknown = result.data;
    if (typeof result.data === "string" && result.data.length > cap) {
      truncatedData = `${result.data.slice(0, cap)}\n...[truncated ${result.data.length - cap} chars]`;
    }
    return {
      ...result,
      output: truncatedOutput,
      data: truncatedData === undefined
        ? { ...(result.data as object ?? {}), truncated: true, originalLength: output.length }
        : truncatedData
    };
  }

  /**
   * Evict oversized tool results to disk. Called after truncation.
   * If the result's output or data.content exceeds the eviction threshold,
   * the full content is written to .rapa/evicted/ and replaced with a
   * preview + file path in the agent's history.
   *
   * Skips eviction for reads from .rapa/evicted/ to prevent recursive eviction loops.
   */
  private async evictIfNeeded(result: ToolResult, call: ToolCall): Promise<ToolResult> {
    if (!this.context.workspaceRoot) return result;

    // Prevent recursive eviction: don't evict content that's already from the eviction store
    const params = call.parameters as Record<string, unknown>;
    const filePath = (params?.path ?? params?.filePath) as string | undefined;
    if (filePath && (filePath.includes(".rapa/evicted/") || filePath.includes(".rapa\\evicted\\"))) {
      return result;
    }

    // Skip eviction for reads of files the agent wrote in this run.
    // The agent often needs to re-read its own files for edit_file operations.
    // Evicting those reads forces the agent into a read-evicted → read-evicted loop.
    if (call.name === "read_file" && filePath && this.writtenFiles.has(filePath)) {
      return result;
    }

    // Also skip if the result content is already an eviction notice
    const output = typeof result.output === "string" ? result.output : "";
    if (output.startsWith("[Content evicted to disk")) return result;
    const dataContent = typeof (result.data as Record<string, unknown>)?.content === "string"
      ? (result.data as Record<string, unknown>).content as string : "";
    if (dataContent.startsWith("[Content evicted to disk")) return result;

    if (!shouldEvictResult(result as EvictableResult)) return result;
    return evictResult(result as EvictableResult, this.context.workspaceRoot, call.name) as Promise<ToolResult>;
  }

  /**
   * Execute a list of tool calls, batching read-only tools in parallel and
   * running write/shell tools sequentially (with grouping by target path).
   */
  async executeToolCallsInBatches(calls: ToolCall[]): Promise<ToolResult[]> {
    const results: (ToolResult | null)[] = new Array(calls.length).fill(null);

    const readOnlyIndices: number[] = [];
    const writeIndices: number[] = [];

    for (let i = 0; i < calls.length; i += 1) {
      if (toolRegistry.isToolReadOnly(calls[i].name)) {
        readOnlyIndices.push(i);
      } else {
        writeIndices.push(i);
      }
    }

    const writeGroups: Array<number[]> = [];
    const usedWriteIndices = new Set<number>();

    for (const i of writeIndices) {
      if (usedWriteIndices.has(i)) continue;
      const group: number[] = [i];
      usedWriteIndices.add(i);

      const targetPath = extractWriteTargetPath(calls[i], this.context.workspaceRoot);
      if (targetPath) {
        for (const j of writeIndices) {
          if (i === j || usedWriteIndices.has(j)) continue;
          const otherPath = extractWriteTargetPath(calls[j], this.context.workspaceRoot);
          if (otherPath && otherPath === targetPath) {
            group.push(j);
            usedWriteIndices.add(j);
          }
        }
      }
      writeGroups.push(group);
    }

    if (readOnlyIndices.length > 0) {
      const readOnlyTasks = readOnlyIndices.map(async (i) => {
        const approval = await this.resolveToolApproval(calls[i]);
        if (!approval.approved) {
          results[i] = {
            success: false,
            error: approval.message || `Tool ${calls[i].name} was rejected by the user.`,
            data: { rejected: true, tool: calls[i].name, callId: calls[i].id }
          };
          return;
        }
        results[i] = await this.executeToolCall(calls[i], { approved: approval.approved });
        // P2-D: bound the size of every tool result before it lands in the
        // history. Truncation is non-destructive — the full result stays in
        // the `AgentToolCall` row in the database.
        results[i] = this.truncateToolResult(results[i]!, calls[i]);
        // Evict oversized results to disk (preview + file path in history)
        results[i] = await this.evictIfNeeded(results[i]!, calls[i]);
      });
      await Promise.all(readOnlyTasks);
    }

    for (const group of writeGroups) {
      for (const i of group) {
        const approval = await this.resolveToolApproval(calls[i]);
        if (!approval.approved) {
          results[i] = {
            success: false,
            error: approval.message || `Tool ${calls[i].name} was rejected by the user.`,
            data: { rejected: true, tool: calls[i].name, callId: calls[i].id }
          };
          continue;
        }

        let result = await this.executeToolCall(calls[i], { approved: approval.approved });
        result = this.truncateToolResult(result, calls[i]);
        result = await this.evictIfNeeded(result, calls[i]);
        results[i] = result;

        // Auto-inject update_working_memory after successful file writes.
        // This ensures the agent tracks created/modified files without relying
        // on the model to remember. Matches QoderWork's automatic file tracking.
        if (result.success && FILE_MUTATING_TOOLS.has(calls[i].name)) {
          const writeParams = calls[i].parameters as Record<string, unknown>;
          const writtenPath = (writeParams?.path ?? writeParams?.filePath) as string | undefined;
          if (writtenPath) {
            // Track this file so re-reads skip eviction
            this.writtenFiles.add(writtenPath);

            const memTool = toolRegistry.get("update_working_memory");
            if (memTool) {
              try {
                await memTool.execute(
                  { addFile: writtenPath },
                  { workspaceRoot: this.context.workspaceRoot, userId: this.context.userId, conversationId: this.context.conversationId }
                );
              } catch {
                // Non-fatal — working memory update failure shouldn't block execution
              }
            }
          }
        }

        if (!result.success && result.error && !isRejectionError(result)) {
          const retryResult = await this.retryToolCall(calls[i], result);
          if (retryResult) {
            const truncated = this.truncateToolResult(retryResult, calls[i]);
            results[i] = await this.evictIfNeeded(truncated, calls[i]);
          }
        }
      }
    }

    return results.map((r) => r!);
  }

  /**
   * After a successful write tool call, run checkpoint validation:
   * 1. Run read_lints ONLY when source code files were written (not config/docs)
   * 2. Run run_tests when source code files were modified AND test files exist
   *
   * This implements the Codex-style "fix before proceeding" pattern —
   * but avoids premature validation during initial project creation.
   * Running lint after writing package.json (before server.js exists) produces
   * confusing failures that mislead the agent about its own progress.
   */
  async runCheckpointValidation(calls: ToolCall[], results: ToolResult[]): Promise<ToolResult[]> {
    const validationResults: ToolResult[] = [];

    const successfulWrites = calls.filter((call, index) =>
      WRITE_TOOLS.has(call.name) && results[index]?.success === true
    );

    if (successfulWrites.length === 0) return [];

    // Source code extensions — lint and tests only apply to these
    const SOURCE_EXTENSIONS = new Set([
      ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java",
      ".rb", ".php", ".cs", ".swift", ".kt", ".scala", ".lua",
      ".c", ".cpp", ".h", ".hpp", ".vue", ".svelte"
    ]);

    // Test file patterns — used to detect when tests are available to run
    const TEST_PATTERNS = [
      ".test.", ".spec.", "_test.", "_spec.",
      "test.", "spec.", "tests.", "specs."
    ];

    // Extract file paths from successful writes
    const writtenFiles = successfulWrites.map((call) => {
      const params = call.parameters as Record<string, unknown>;
      return ((params?.path ?? params?.filePath) as string | undefined) ?? "";
    });

    const hasSourceWrites = writtenFiles.some((filePath) => {
      const ext = filePath.includes(".") ? `.${filePath.split(".").pop()?.toLowerCase()}` : "";
      return SOURCE_EXTENSIONS.has(ext);
    });

    const hasTestWrites = writtenFiles.some((filePath) => {
      const lower = filePath.toLowerCase();
      return TEST_PATTERNS.some((pattern) => lower.includes(pattern));
    });

    // Only run lint when actual source code was written — skip for config/doc files
    // (package.json, SPEC.md, .gitignore, etc.) to avoid premature failures
    if (hasSourceWrites) {
      const lintTool = toolRegistry.get("read_lints");
      if (lintTool) {
        try {
          const lintResult = await lintTool.execute({}, this.context);
          if (lintResult) validationResults.push(lintResult);
        } catch {
          // Lint failure is non-fatal
        }
      }
    }

    // Only run tests when source code was modified AND a test file was written
    // (indicates the agent is in the "write tests" phase, not "create project" phase)
    if (hasSourceWrites && hasTestWrites) {
      const testTool = toolRegistry.get("run_tests");
      if (testTool) {
        try {
          const testResult = await testTool.execute({}, this.context);
          if (testResult) validationResults.push(testResult);
        } catch {
          // Test failure is non-fatal
        }
      }
    }

    return validationResults;
  }
}
