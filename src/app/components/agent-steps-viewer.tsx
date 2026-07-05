import { useEffect, useState, useRef, lazy, Suspense } from "react";
import { ChevronRight, FileEdit, FileText, Folder, Globe, Search, ShieldAlert, Terminal, Image, Bot, Activity, ArrowUp, ArrowDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

import { getAgentRun, type AgentApprovalData, type AgentLiveToolCall, type AgentStep, type AgentToolResult } from "../../lib/agent-api";

import { cn } from "../../lib/utils";
import { computeDiffStats, extractDiffFromResult } from "./diff-view";
import { TaskList, extractTasks } from "./task-list";

const DiffDialog = lazy(() => import("./diff-dialog").then(m => ({ default: m.DiffDialog })));
type AgentStepsViewerProps = {
  steps: AgentStep[];
  liveToolCalls?: AgentLiveToolCall[];
  liveReasoning?: string;
  statusText?: string;
  workspacePath?: string;
  className?: string;
  onToolApproval?: (approvalId: string, approved: boolean) => Promise<void> | void;
  approvalBusyIds?: string[];
  isAgentActive?: boolean;
  /**
   * Optional. When provided, the viewer will additionally fetch the
   * persisted `AgentRun` for this id and use the resulting
   * `AgentToolCall` rows as a *second-source* for tool names. This
   * fixes the case where a conversation was switched mid-stream: the
   * in-memory `liveToolCalls` are gone, and the persisted
   * `metadata.steps[*].toolCalls[*].name` is sometimes missing for
   * older runs / older model outputs. The dedicated `AgentToolCall`
   * table always has the name (the column is NOT NULL), so we use
   * it as the source of truth.
   */
  agentRunId?: string;
};



type TraceItem =
  | {
      type: "reasoning";
      id: string;
      content: string;
    }
  | {
      type: "tool";
      id: string;
      name: string;
      parameters: Record<string, unknown>;
      result?: AgentToolResult;
      status: AgentLiveToolCall["status"] | "pending";
    };

function getLiveStatusLabel(status: AgentLiveToolCall["status"]) {
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "requires_approval") return "Needs approval";
  return "Queued";
}

function getPersistedToolStatus(result?: AgentToolResult | null): AgentLiveToolCall["status"] | "pending" {
  if (!result) return "pending";
  if (result.success === true) return "completed";
  if (result.success === false) return "failed";
  if (typeof result.error === "string" && result.error.trim()) return "failed";
  if ((typeof result.output === "string" && result.output.trim()) || result.data !== undefined) return "completed";
  return "pending";
}

function getResultLabel(result?: AgentToolResult) {
  const status = getPersistedToolStatus(result);
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  return "Pending";
}

const EDIT_TOOL_NAMES = new Set(["edit_file", "replace_in_file", "append_file", "write_file", "delete_file"]);

function getPhaseLabel(name: string, status: AgentLiveToolCall["status"] | "pending"): string {
  if (status === "pending") return "Preparing...";
  if (status === "running") {
    if (EDIT_TOOL_NAMES.has(name)) return "Editing...";
    if (["read_file", "read_image", "list_directory", "search_content"].includes(name)) return "Reading...";
    if (["execute_command", "start_process"].includes(name)) return "Executing...";
    if (["web_search", "fetch_url"].includes(name)) return "Searching...";
    if (name.startsWith("git_")) return "Running git...";
    return "Running...";
  }
  if (status === "completed") return "Done";
  if (status === "failed") return "Failed";
  if (status === "requires_approval") return "Awaiting approval";
  return "";
}


/* ── Spinning progress ring ─────────────────────────────────────── */
/* Replaces per-status icons with an animated SVG indicator.
   Running:  spinning arc around a neutral dot
   Done:     green ring + checkmark
   Failed:   red ring + X
   Approval: pulsing yellow ring + shield
   Pending:  faint dashed ring                              */

function ProgressRing({ status }: { status: AgentLiveToolCall["status"] | "pending" }) {
  const isRunning = status === "running";
  const isDone = status === "completed";
  const isFailed = status === "failed";
  const isApproval = status === "requires_approval";

  // Circumference = 2 * PI * 6.5 ≈ 40.84
  const C = 40.84;

  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      className={cn("shrink-0", isRunning && "animate-spin")}
      style={{ animationDuration: isRunning ? "0.8s" : undefined }}
    >
      {/* Background track */}
      <circle
        cx="8" cy="8" r="6.5"
        fill="none"
        strokeWidth="1.5"
        className={cn(
          isDone ? "stroke-accent-green/20"
            : isFailed ? "stroke-accent-red/20"
            : isApproval ? "stroke-accent-yellow/20"
            : "stroke-border"
        )}
      />
      {/* Foreground arc */}
      {!isRunning && (
        <circle
          cx="8" cy="8" r="6.5"
          fill="none"
          strokeWidth="1.5"
          strokeDasharray={isApproval ? `${C * 0.7} ${C * 0.3}` : `${C}`}
          strokeLinecap="round"
          className={cn(
            isDone ? "stroke-accent-green"
              : isFailed ? "stroke-accent-red"
              : isApproval ? "stroke-accent-yellow animate-pulse"
              : "stroke-transparent"
          )}
        />
      )}
      {isRunning && (
        <circle
          cx="8" cy="8" r="6.5"
          fill="none"
          strokeWidth="1.5"
          strokeDasharray={`${C * 0.35} ${C * 0.65}`}
          strokeLinecap="round"
          className="stroke-accent-blue"
        />
      )}
      {/* Center indicator */}
      {isDone ? (
        <path d="M5.5 8.5 L7 10 L10.5 6.5" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="stroke-accent-green" />
      ) : isFailed ? (
        <>
          <line x1="6" y1="6" x2="10" y2="10" strokeWidth="1.5" strokeLinecap="round" className="stroke-accent-red" />
          <line x1="10" y1="6" x2="6" y2="10" strokeWidth="1.5" strokeLinecap="round" className="stroke-accent-red" />
        </>
      ) : isApproval ? (
        <circle cx="8" cy="8" r="1.5" className="fill-accent-yellow" />
      ) : (
        <circle cx="8" cy="8" r="1.5" className={cn("fill-muted-foreground", isRunning && "fill-accent-blue")} />
      )}
    </svg>
  );
}

/* ── Tool-type icon resolver ────────────────────────────────────── */
/* Maps common tool names to lucide icons for quick visual scanning. */

function getToolIcon(name: string): LucideIcon {
  const lower = name.toLowerCase();
  if (lower.includes("shell") || lower.includes("bash") || lower.includes("terminal") || lower === "execute_command" || lower === "run_command") return Terminal;
  if (lower === "read_image" || lower === "read_images") return Image;
  if (lower.includes("file") || lower === "edit_file" || lower === "write_file" || lower === "replace_in_file") return FileEdit;
  if (lower === "read_file" || lower === "read_files") return FileText;
  if (lower.includes("folder") || lower.includes("dir") || lower === "list_directory") return Folder;
  if (lower.includes("fetch") || lower.includes("http") || lower.includes("url") || lower.includes("web") || lower.includes("browse")) return Globe;
  if (lower.includes("search") || lower.includes("grep") || lower.includes("find")) return Search;
  if (lower.includes("spawn") || lower.includes("agent") || lower === "delegate_task") return Bot;
  if (lower.includes("cancel") || lower.includes("status") || lower.includes("send_message")) return Activity;
  return FileText;
}

function getToolResultPreview(result?: AgentToolResult) {
  if (!result) return null;
  if (result.error) return result.error;
  if (typeof result.output === "string" && result.output.trim()) return result.output;

  if (result.data && typeof result.data === "object" && !Array.isArray(result.data)) {
    const d = result.data as Record<string, unknown>;

    // read_image: show media type + size instead of dumping base64
    if (typeof d.mediaType === "string" && typeof d.base64Data === "string") {
      const sizeKb = typeof d.fileSize === "number" ? ` (${(d.fileSize / 1024).toFixed(1)}KB)` : "";
      return `Image: ${d.mediaType}${sizeKb}`;
    }

    // search_content outputMode: files_only
    if (d.outputMode === "files_only" && Array.isArray(d.files)) {
      return `${d.totalFiles ?? d.files.length} files matched`;
    }
    // search_content outputMode: count
    if (d.outputMode === "count" && Array.isArray(d.counts)) {
      const total = typeof d.totalMatches === "number" ? d.totalMatches : 0;
      const files = typeof d.totalFiles === "number" ? d.totalFiles : (d.counts as unknown[]).length;
      return `${total} matches across ${files} files`;
    }
    // search_content: context matches summary
    if (Array.isArray(d.matches) && typeof d.totalMatches === "number") {
      const ctxInfo = typeof d.contextLines === "number" && d.contextLines > 0 ? ` (±${d.contextLines} ctx)` : "";
      return `${d.totalMatches} matches${ctxInfo}${d.truncated ? " (truncated)" : ""}`;
    }

    // fetch_url with processedContent
    if (typeof d.processedContent === "string" && d.processedContent.trim()) {
      return d.processedContent.slice(0, 200) + (d.processedContent.length > 200 ? "..." : "");
    }

    // spawn_agent / get_agent_status
    if (typeof d.agentId === "string" && typeof d.status === "string") {
      const task = typeof d.task === "string" ? d.task.slice(0, 80) + (d.task.length > 80 ? "..." : "") : "";
      return `Agent ${d.agentId}: ${d.status}${task ? ` — ${task}` : ""}`;
    }
    // get_agent_status (list mode)
    if (Array.isArray(d.agents)) {
      return `${d.agents.length} child agent${(d.agents as unknown[]).length !== 1 ? "s" : ""}`;
    }
  }

  if (result.data !== undefined) return JSON.stringify(result.data, null, 2);
  return null;
}

function getApprovalData(result?: AgentToolResult): AgentApprovalData | null {
  if (!result?.data || typeof result.data !== "object" || Array.isArray(result.data)) return null;
  const data = result.data as AgentApprovalData;
  return data.requiresApproval && typeof data.approvalId === "string" ? data : null;
}

function normalizeRecord(value: unknown): Record<string, unknown> {

  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

type ToolFileMetadata = {
  fileName: string;
  fullPath: string;
  fileSizeLabel?: string;
  lineRange?: string;
};

const textEncoder = new TextEncoder();

function pickString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function pickNumber(...values: unknown[]) {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function isAbsolutePath(path: string) {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
}

function joinPaths(basePath: string, targetPath: string) {
  const normalizedBase = basePath.replace(/[\\/]+$/, "");
  const normalizedTarget = targetPath.replace(/^[\\/]+/, "");
  return `${normalizedBase}/${normalizedTarget}`.replace(/\\/g, "/");
}

function getFileName(path: string) {
  const normalizedPath = path.replace(/\\/g, "/");
  const segments = normalizedPath.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? normalizedPath;
}

function formatFileSize(bytes?: number) {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const maximumFractionDigits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toLocaleString(undefined, { maximumFractionDigits })} ${units[unitIndex]}`;
}

// Resolves the user-visible label for a tool call. When the persisted
// `name` is missing or empty (which can happen when an agent run was
// started by a model version that didn't include a tool name, or when
// the metadata path is taken and the legacy format omitted the name),
// we fall back to a generic "Tool call" label rather than the previous
// "unknown_tool" string — that literal value was showing up in the UI
// as a system identifier, which looked like a bug to the user. The
// AgentRunPanel below can also override the label with the canonical
// name from the AgentToolCall row when it loads.
function getSafeToolName(value: unknown): { display: string; isFallback: boolean } {
  if (typeof value === "string" && value.trim().length > 0) {
    return { display: value.trim(), isFallback: false };
  }
  return { display: "Tool call", isFallback: true };
}

function isTaskManagementTool(name: string) {
  return name === "add_task" || name === "update_task";
}

/* ── Result-type detection helpers for specialized rendering ──────── */

function isImageResult(result?: AgentToolResult): boolean {
  if (!result?.data || typeof result.data !== "object" || Array.isArray(result.data)) return false;
  const d = result.data as Record<string, unknown>;
  return typeof d.mediaType === "string" && typeof d.base64Data === "string";
}

function isProcessedFetchResult(result?: AgentToolResult): boolean {
  if (!result?.data || typeof result.data !== "object" || Array.isArray(result.data)) return false;
  const d = result.data as Record<string, unknown>;
  return typeof d.processedContent === "string" && d.processedContent.trim().length > 0;
}

function isContextSearchResult(result?: AgentToolResult): boolean {
  if (!result?.data || typeof result.data !== "object" || Array.isArray(result.data)) return false;
  const d = result.data as Record<string, unknown>;
  return Array.isArray(d.matches) && typeof d.contextLines === "number" && (d.contextLines as number) > 0;
}

function extractToolFileMetadata({
  name,
  parameters,
  result,
  workspacePath
}: {
  name: unknown;
  parameters: Record<string, unknown>;
  result?: AgentToolResult;
  workspacePath?: string;
}): ToolFileMetadata | null {
  const safeName = getSafeToolName(name).display;
  const resultData = normalizeRecord(result?.data);
  const isFileTool = safeName.includes("file") || safeName === "edit_file" || safeName === "replace_in_file";
  const rawPath = pickString(
    resultData.fullPath,
    resultData.filePath,
    resultData.newFullPath,
    resultData.oldFullPath,
    parameters.filePath,
    parameters.target_file,
    parameters.targetFile,
    isFileTool ? resultData.path : undefined,
    isFileTool ? resultData.newPath : undefined,
    isFileTool ? parameters.path : undefined,
    isFileTool ? parameters.oldPath : undefined,
    isFileTool ? parameters.newPath : undefined
  );


  if (!rawPath) return null;

  const fullPath = isAbsolutePath(rawPath)
    ? rawPath.replace(/\\/g, "/")
    : workspacePath
      ? joinPaths(workspacePath, rawPath)
      : rawPath.replace(/\\/g, "/");

  const fileSize = pickNumber(
    resultData.fileSize,
    resultData.bytesWritten,
    resultData.bytes,
    resultData.byteLength,
    resultData.size
  ) ?? (typeof resultData.content === "string" ? textEncoder.encode(resultData.content).length : undefined);

  // Extract line range info for read_file and similar tools.
  const startLine = pickNumber(resultData.startLine, resultData.offset);
  const endLine = pickNumber(resultData.endLine);
  const totalLines = pickNumber(resultData.totalLines);
  let lineRange: string | undefined;
  if (startLine !== undefined && endLine !== undefined && totalLines !== undefined) {
    if (endLine >= totalLines && startLine === 1) {
      lineRange = `${totalLines} lines`;
    } else {
      lineRange = `lines ${startLine}–${endLine} of ${totalLines}`;
    }
  } else if (totalLines !== undefined) {
    lineRange = `${totalLines} lines`;
  }

  return {
    fileName: getFileName(fullPath),
    fullPath,
    fileSizeLabel: formatFileSize(fileSize),
    lineRange
  };
}

/* ── Tool Trace Card — Engineering Blueprint redesign ───────────── */
/* Compact single-row design: spinning progress ring, monospace tool name,
   contextual preview (command / file path), expandable detail panel.
   Status accent colours appear only on the ring + label — the card
   chrome stays grayscale to maintain the blueprint aesthetic.        */

function ToolTraceCard({
  name,
  parameters,
  result,
  status,
  workspacePath,
  onToolApproval,
  approvalBusyIds = []
}: {
  name: string;
  parameters: Record<string, unknown> | null | undefined;
  result?: AgentToolResult;
  status: AgentLiveToolCall["status"] | "pending";
  workspacePath?: string;
  onToolApproval?: (approvalId: string, approved: boolean) => Promise<void> | void;
  approvalBusyIds?: string[];
}) {
  const [isOpen, setIsOpen] = useState(false);

  const safeParams = normalizeRecord(parameters);
  const preview = getToolResultPreview(result);
  const fileMeta = extractToolFileMetadata({ name, parameters: safeParams, result, workspacePath });

  const isFailed = status === "failed" || getPersistedToolStatus(result) === "failed";
  const isRunning = status === "running";
  const isApproval = status === "requires_approval";
  const approvalData = isApproval ? getApprovalData(result) : null;
  const approvalId = approvalData?.approvalId;
  const isApprovalBusy = approvalId ? approvalBusyIds.includes(approvalId) : false;

  const hasParams = Object.keys(safeParams).length > 0;
  const hasSpecializedContent = isImageResult(result) || isProcessedFetchResult(result) || isContextSearchResult(result);
  const canExpand = hasParams || Boolean(preview) || Boolean(fileMeta) || hasSpecializedContent;

  // Contextual one-liner: prefer shell command > file path
  const commandPreview = typeof safeParams.command === "string" ? safeParams.command : undefined;
  const pathPreview = fileMeta?.fullPath
    ?? (typeof safeParams.path === "string" ? safeParams.path : undefined);
  const inlinePreview = commandPreview ?? pathPreview;
  const ToolIcon = getToolIcon(name);
  const approvalToolName = name.replace(/_/g, " ");

  // ── Diff summary for edit tools ──────────────────────────────
  const isEditTool = EDIT_TOOL_NAMES.has(name);
  const [diffDialogOpen, setDiffDialogOpen] = useState(false);
  const diffEntry = isEditTool && status === "completed" && result?.data
    ? extractDiffFromResult(result.data as Record<string, unknown>, name, 0)
    : null;
  const diffStats = diffEntry ? computeDiffStats(diffEntry.before, diffEntry.after) : null;
  const isNewFile = diffEntry !== null && !diffEntry.before.trim() && diffEntry.after.trim().length > 0;
  const isDeleteFile = diffEntry !== null && diffEntry.before.trim().length > 0 && !diffEntry.after.trim();
  const hasDiffBadges = diffStats !== null && (diffStats.added > 0 || diffStats.removed > 0);

  return (
    <>
    <div
      className={cn(
        "overflow-hidden rounded border bg-card-3/40 transition-all duration-300",
        isFailed ? "border-accent-red/30"
          : isRunning ? "border-accent-blue/40 animate-[pulse-border_2s_ease-in-out_infinite]"
          : isApproval ? "border-accent-yellow/30"
          : "border-border/40"
      )}
      style={{
        backdropFilter: "blur(16px)",
        ...(isRunning ? { boxShadow: "0 0 8px color-mix(in srgb, var(--accent-blue) 15%, transparent)" } : {})
      }}
    >
      {/* ── Compact header (always visible) ────────────────────────── */}
      <button
        type="button"
        onClick={() => canExpand && setIsOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-2 text-left",
          canExpand && "cursor-pointer hover:bg-card-hover/40",
          !canExpand && "cursor-default"
        )}
      >
        <ProgressRing status={status} />
        <ToolIcon size={13} className="shrink-0 text-muted-foreground/60" />

        <code className="shrink-0 font-mono-tech text-[11px] font-semibold tracking-tight text-foreground">
          {name}
        </code>

        {inlinePreview ? (
          hasDiffBadges && pathPreview && !commandPreview ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setDiffDialogOpen(true); }}
              className="min-w-0 flex-1 truncate text-left font-mono-tech text-[10px] text-muted-foreground/70 transition-colors hover:text-accent-blue cursor-pointer"
              title={`View changes to ${pathPreview}`}
            >
              {inlinePreview}
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate font-mono-tech text-[10px] text-muted-foreground/70">
              {commandPreview ? <span className="text-muted-foreground/40 select-none">$ </span> : null}
              {inlinePreview}
            </span>
          )
        ) : (
          <span className="flex-1" />
        )}

        {hasDiffBadges ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setDiffDialogOpen(true); }}
            className="shrink-0 font-mono-tech text-[9px] font-medium uppercase tracking-[0.12em] text-accent-green transition-colors hover:text-accent-blue cursor-pointer"
          >
            Review Changes
          </button>
        ) : (
          <span
            className={cn(
              "shrink-0 font-mono-tech text-[9px] font-medium uppercase tracking-[0.12em] transition-all duration-300",
              isRunning ? "text-accent-blue"
                : isFailed ? "text-accent-red"
                : status === "completed" ? "text-accent-green"
                : isApproval ? "text-accent-yellow"
                : "text-muted-foreground/50"
            )}
          >
            {getPhaseLabel(name, status)}
          </span>
        )}

        {/* ── Diff summary badges (edit tools, completed) ──────── */}
        {hasDiffBadges && diffStats && diffEntry && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setDiffDialogOpen(true); }}
            className="flex shrink-0 items-center gap-1"
            title={`View changes to ${diffEntry.path}`}
          >
            {isNewFile ? (
              <span className="inline-flex items-center gap-0.5 rounded border border-accent-green/30 bg-accent-green/10 px-1.5 py-0.5 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.08em] text-accent-green">
                New
              </span>
            ) : isDeleteFile ? (
              <span className="inline-flex items-center gap-0.5 rounded border border-accent-red/30 bg-accent-red/10 px-1.5 py-0.5 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.08em] text-accent-red">
                Deleted
              </span>
            ) : (
              <>
                {diffStats.added > 0 && (
                  <span className="inline-flex items-center gap-0.5 rounded border border-accent-green/30 bg-accent-green/10 px-1 py-0.5 font-mono-tech text-[9px] font-semibold text-accent-green">
                    <ArrowUp size={8} />+{diffStats.added}
                  </span>
                )}
                {diffStats.removed > 0 && (
                  <span className="inline-flex items-center gap-0.5 rounded border border-accent-red/30 bg-accent-red/10 px-1 py-0.5 font-mono-tech text-[9px] font-semibold text-accent-red">
                    <ArrowDown size={8} />-{diffStats.removed}
                  </span>
                )}
              </>
            )}
          </button>
        )}

        {canExpand && (
          <ChevronRight
            size={13}
            className={cn(
              "shrink-0 text-muted-foreground/40 transition-transform duration-200",
              isOpen && "rotate-90"
            )}
          />
        )}
      </button>

      {/* ── Running shimmer bar ───────────────────────────────────── */}
      {isRunning && (
        <div className="h-[3px] w-full overflow-hidden bg-accent-blue/10">
          <div className="h-full w-1/3 animate-[shimmer_1.5s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-accent-blue/60 to-transparent" />
        </div>
      )}

      {/* ── File operation context for in-progress edit tools ─────── */}
      {isEditTool && (isRunning || status === "pending") && pathPreview && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded border border-accent-blue/20 bg-accent-blue/[0.04] px-2.5 py-1.5">
          <FileEdit size={12} className="shrink-0 text-accent-blue/60" />
          <span className="truncate font-mono-tech text-[10px] font-medium text-accent-blue/70">
            {pathPreview}
          </span>
        </div>
      )}

      {/* ── Inline approval prompt ────────────────────────────────── */}
      {approvalId && onToolApproval && (
        <div className="mx-3 mb-2 rounded border border-accent-yellow/30 bg-accent-yellow/[0.04] px-3 py-2">
          <div className="flex items-center gap-2 text-[11px]">
            <ShieldAlert size={13} className="shrink-0 text-accent-yellow" />
            <span className="text-accent-yellow">
              Approve <span className="font-semibold">{approvalToolName}</span>?
            </span>
          </div>
          {commandPreview && (
            <code className="mt-1.5 block truncate rounded border border-accent-yellow/20 bg-card px-2 py-1 font-mono-tech text-[10px] text-accent-yellow/80">
              {commandPreview}
            </code>
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={isApprovalBusy}
              onClick={() => void onToolApproval(approvalId, true)}
              className="rounded border border-accent-green/40 bg-accent-green/10 px-2.5 py-1 font-mono-tech text-[10px] font-medium uppercase tracking-wider text-accent-green transition-colors hover:bg-accent-green/20 disabled:opacity-40"
            >
              {isApprovalBusy ? "..." : "Approve"}
            </button>
            <button
              type="button"
              disabled={isApprovalBusy}
              onClick={() => void onToolApproval(approvalId, false)}
              className="rounded border border-accent-red/30 bg-accent-red/[0.06] px-2.5 py-1 font-mono-tech text-[10px] font-medium uppercase tracking-wider text-accent-red transition-colors hover:bg-accent-red/15 disabled:opacity-40"
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {/* ── Expandable details panel ──────────────────────────────── */}
      {canExpand && isOpen && (
        <div className="border-t border-border/50">
          {/* Specialized: read_image preview */}
          {result?.data && typeof result.data === "object" && !Array.isArray(result.data) &&
            typeof (result.data as Record<string, unknown>).mediaType === "string" &&
            typeof (result.data as Record<string, unknown>).base64Data === "string" && (
            <div className="border-b border-border/30 px-3 py-2.5 last:border-b-0">
              <div className="mb-1.5 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/50">
                Image Preview
              </div>
              <img
                src={`data:${(result.data as Record<string, unknown>).mediaType};base64,${(result.data as Record<string, unknown>).base64Data}`}
                alt="Tool result"
                className="max-h-64 rounded border border-border/40 object-contain"
              />
              {typeof (result.data as Record<string, unknown>).textContent === "string" && (
                <pre className="mt-2 max-h-32 overflow-auto rounded border border-border/40 bg-card p-2 font-mono-tech text-[10px] leading-[1.6] text-muted-foreground">
                  {(result.data as Record<string, unknown>).textContent as string}
                </pre>
              )}
            </div>
          )}

          {/* Specialized: fetch_url processedContent */}
          {result?.data && typeof result.data === "object" && !Array.isArray(result.data) &&
            typeof (result.data as Record<string, unknown>).processedContent === "string" && (
            <div className="border-b border-border/30 px-3 py-2.5 last:border-b-0">
              <div className="mb-1.5 flex items-center gap-2 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/50">
                AI Processed
                {(result.data as Record<string, unknown>).converted && (
                  <span className="rounded border border-accent-blue/30 bg-accent-blue/[0.06] px-1 py-px text-[8px] text-accent-blue">
                    html→text
                  </span>
                )}
              </div>
              <div className="max-h-48 overflow-auto rounded border border-border/40 bg-card p-2.5 text-[11px] leading-[1.6] text-muted-foreground">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeKatex]}>
                  {(result.data as Record<string, unknown>).processedContent as string}
                </ReactMarkdown>
              </div>
            </div>
          )}

          {/* Specialized: search_content matches with context lines */}
          {result?.data && typeof result.data === "object" && !Array.isArray(result.data) &&
            Array.isArray((result.data as Record<string, unknown>).matches) &&
            typeof (result.data as Record<string, unknown>).contextLines === "number" &&
            ((result.data as Record<string, unknown>).contextLines as number) > 0 && (
            <div className="border-b border-border/30 px-3 py-2.5 last:border-b-0">
              <div className="mb-1.5 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/50">
                Matches with Context
              </div>
              <div className="max-h-64 space-y-2 overflow-auto">
                {((result.data as Record<string, unknown>).matches as Array<Record<string, unknown>>).map((match, idx) => (
                  <div key={idx} className="rounded border border-border/30 bg-card p-2">
                    <div className="mb-1 font-mono-tech text-[9px] text-muted-foreground/50">
                      {String(match.path)}:{String(match.line)}
                    </div>
                    {Array.isArray(match.beforeLines) && (match.beforeLines as string[]).map((line, i) => (
                      <pre key={`b-${i}`} className="font-mono-tech text-[10px] leading-[1.5] text-muted-foreground/40">{line}</pre>
                    ))}
                    <pre className="rounded bg-accent-yellow/[0.06] px-1 font-mono-tech text-[10px] leading-[1.5] font-medium text-foreground">
                      {String(match.text)}
                    </pre>
                    {Array.isArray(match.afterLines) && (match.afterLines as string[]).map((line, i) => (
                      <pre key={`a-${i}`} className="font-mono-tech text-[10px] leading-[1.5] text-muted-foreground/40">{line}</pre>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {hasParams && (
            <div className="border-b border-border/30 px-3 py-2.5 last:border-b-0">
              <div className="mb-1.5 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/50">
                Parameters
              </div>
              <pre className="max-h-48 overflow-auto panel-card rounded p-2.5 font-mono-tech text-[10px] leading-[1.6] text-muted-foreground">
                {JSON.stringify(safeParams, null, 2)}
              </pre>
            </div>
          )}
          {preview && !isImageResult(result) && !isProcessedFetchResult(result) && !isContextSearchResult(result) && (
            <div className="border-b border-border/30 px-3 py-2.5 last:border-b-0">
              <div className="mb-1.5 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/50">
                {isFailed ? "Error" : "Output"}
              </div>
              <pre
                className={cn(
                  "max-h-48 overflow-auto rounded p-2.5 font-mono-tech text-[10px] leading-[1.6]",
                  isFailed
                    ? "border border-accent-red/20 bg-accent-red/[0.04] text-accent-red/80"
                    : "panel-card text-muted-foreground"
                )}
              >
                {preview}
              </pre>
            </div>
          )}
          {fileMeta && (
            <div className="px-3 py-2">
              <div className="flex items-center gap-2 font-mono-tech text-[10px] text-muted-foreground/60">
                <span className="font-medium text-muted-foreground/80">{fileMeta.fileName}</span>
                {fileMeta.fileSizeLabel && (
                  <span className="text-muted-foreground/40">{fileMeta.fileSizeLabel}</span>
                )}
                {fileMeta.lineRange && (
                  <span className="text-muted-foreground/40">{fileMeta.lineRange}</span>
                )}
              </div>
              <div className="mt-0.5 truncate font-mono-tech text-[9px] text-muted-foreground/40" title={fileMeta.fullPath}>
                {fileMeta.fullPath}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
    {diffEntry && (
      <Suspense fallback={null}>
        <DiffDialog
          open={diffDialogOpen}
          onOpenChange={setDiffDialogOpen}
          filePath={diffEntry.path}
          before={diffEntry.before}
          after={diffEntry.after}
          lineStart={diffEntry.lineStart}
          lineEnd={diffEntry.lineEnd}
          matchStrategy={diffEntry.matchStrategy}
        />
      </Suspense>
    )}
    </>
  );
}


type CollapsibleReasoningProps = {
  content: string;
  isLive?: boolean;
  defaultOpen?: boolean;
};

/* ── Collapsible Reasoning — Engineering Blueprint ──────────────── */
/* Matches the ToolTraceCard aesthetic: monospace uppercase label,
   thin borders, compact single-row header, shimmer bar for live.   */

function CollapsibleReasoning({ content, isLive = false }: CollapsibleReasoningProps) {
  const [isOpen, setIsOpen] = useState(true);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isLive && isOpen && panelRef.current) {
      panelRef.current.scrollTop = panelRef.current.scrollHeight;
    }
  }, [content, isLive, isOpen]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded border",
        isLive ? "border-accent-blue/20 bg-card-3/40" : "border-border/40 bg-card-3/40"
      )}
      style={{ backdropFilter: "blur(16px)" }}
    >
      {/* Header row */}
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-card-hover/40 transition-colors"
      >
        <ProgressRing status={isLive ? "running" : "completed"} />

        <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {isLive ? "thinking" : "reasoning"}
        </span>

        <span className="flex-1" />

        {isLive && (
          <span className="flex gap-[3px]">
            <span className="h-1 w-1 rounded-full bg-accent-blue animate-bounce [animation-delay:0ms]" />
            <span className="h-1 w-1 rounded-full bg-accent-blue animate-bounce [animation-delay:150ms]" />
            <span className="h-1 w-1 rounded-full bg-accent-blue animate-bounce [animation-delay:300ms]" />
          </span>
        )}

        <ChevronRight
          size={13}
          className={cn(
            "shrink-0 text-muted-foreground/40 transition-transform duration-200",
            isOpen && "rotate-90"
          )}
        />
      </button>

      {/* Shimmer bar */}
      {isLive && (
        <div className="h-px w-full overflow-hidden bg-accent-blue/10">
          <div className="h-full w-1/3 animate-[shimmer_1.5s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-accent-blue/50 to-transparent" />
        </div>
      )}

      {/* Content panel */}
      {isOpen && (
        <div
          ref={panelRef}
          className="sidebar-scroll max-h-48 overflow-x-hidden overflow-y-auto border-t border-border/30 px-3 py-2.5"
        >
          <div className="font-mono-tech text-[10px] leading-[1.7] text-muted-foreground/80 break-words [overflow-wrap:anywhere] min-w-0">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={{
                p: ({ children }) => <p className="mb-1 break-words last:mb-0">{children}</p>,
                ul: ({ children }) => <ul className="mb-1 list-disc space-y-0.5 break-words pl-5">{children}</ul>,
                ol: ({ children }) => <ol className="mb-1 list-decimal space-y-0.5 break-words pl-5">{children}</ol>,
                li: ({ children }) => <li>{children}</li>,
                code: ({ children }) => (
                  <code className="rounded border border-border/40 bg-card-3 px-1 py-px font-mono-tech text-[10px]">{children}</code>
                ),
              }}
            >
              {content}
            </ReactMarkdown>
            {isLive && <span className="ml-0.5 inline-block h-3 w-px bg-accent-blue animate-pulse" />}
          </div>
        </div>
      )}
    </div>
  );
}


function buildTraceItems(
  steps: AgentStep[],
  liveReasoning: string | undefined,
  liveToolCalls: AgentLiveToolCall[],
  persistedNameByCallId: Map<string, string>,
  persistedNameByIndex: string[]
): TraceItem[] {
  const items: TraceItem[] = [];
  let flatCallIndex = 0;

  steps.forEach((step, stepIndex) => {
    if (step.reasoning?.trim()) {
      items.push({
        type: "reasoning",
        id: `step-${step.iteration}-reasoning`,
        content: step.reasoning.trim()
      });
    }

    const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
    const toolResults = Array.isArray(step.toolResults) ? step.toolResults : [];

    toolCalls.forEach((call, callIndex) => {
      const result = toolResults[callIndex];
      // Resolve the user-visible name in this priority:
      //   1. The call's own `name` field (if the metadata has it).
      //   2. The persisted AgentToolCall row, by `externalCallId` match
      //      (covers legacy runs that omitted the name on the way to
      //      metadata).
      //   3. The persisted AgentToolCall row, by positional fallback
      //      (covers runs where `externalCallId` was never populated).
      //   4. The generic "Tool call" label.
      const ownName = getSafeToolName(call.name);
      const persistedById = typeof call.id === "string" ? persistedNameByCallId.get(call.id) : undefined;
      const persistedByPosition = persistedNameByIndex[flatCallIndex];
      flatCallIndex++;
      const safeName = ownName.isFallback
        ? (persistedById ?? persistedByPosition ?? ownName.display)
        : ownName.display;
      if (isTaskManagementTool(safeName)) return;

      const safeId = typeof call.id === "string" && call.id.trim().length > 0
        ? call.id
        : `step-${step.iteration}-tool-${callIndex}`;

      items.push({
        type: "tool",
        id: safeId,
        name: safeName,
        parameters: normalizeRecord(call.parameters),
        result,
        status: getPersistedToolStatus(result)
      });
    });

  });


  if (liveReasoning?.trim()) {
    items.push({
      type: "reasoning",
      id: "live-reasoning",
      content: liveReasoning.trim()
    });
  }

  liveToolCalls.forEach((toolCall, index) => {
    const safeName = getSafeToolName(toolCall.call?.name).display;
    if (isTaskManagementTool(safeName)) return;

    const safeId = typeof toolCall.call?.id === "string" && toolCall.call.id.trim().length > 0
      ? toolCall.call.id
      : `live-tool-${index}`;

    items.push({
      type: "tool",
      id: safeId,
      name: safeName,
      parameters: normalizeRecord(toolCall.call?.parameters),
      result: toolCall.result,
      status: toolCall.status
    });
  });


  return items;
}

export function AgentStepsViewer({
  steps,
  liveToolCalls = [],
  liveReasoning,
  workspacePath,
  className,
  onToolApproval,
  approvalBusyIds = [],
  isAgentActive = false,
  agentRunId
}: AgentStepsViewerProps) {

  // Multi-workspace / persistent-agent support: when we have an
  // `agentRunId`, fetch the persisted run and use its
  // `AgentToolCall` rows as a *second-source* for tool names. This
  // covers the case where the user switched away mid-stream and came
  // back: the in-memory `liveToolCalls` are gone, and the
  // persisted `metadata.steps[*].toolCalls[*].name` may be missing
  // for older runs. The DB always has the name.
  const [persistedNameByCallId, setPersistedNameByCallId] = useState<Map<string, string>>(new Map());
  const [persistedNameByIndex, setPersistedNameByIndex] = useState<string[]>([]);

  useEffect(() => {
    if (!agentRunId) {
      setPersistedNameByCallId(new Map());
      setPersistedNameByIndex([]);
      return;
    }
    let cancelled = false;
    getAgentRun(agentRunId)
      .then((response) => {
        if (cancelled) return;
        const byId = new Map<string, string>();
        const byCreatedAt: Array<{ id: string; name: string; createdAt: string }> = [];
        for (const toolCall of response.run.toolCalls ?? []) {
          if (toolCall.name && toolCall.name.trim().length > 0) {
            byId.set(toolCall.id, toolCall.name);
            byCreatedAt.push({ id: toolCall.id, name: toolCall.name, createdAt: toolCall.createdAt });
          }
        }
        byCreatedAt.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
        setPersistedNameByCallId(byId);
        setPersistedNameByIndex(byCreatedAt.map((entry) => entry.name));
      })
      .catch(() => {
        // Swallow the failure — we still have the metadata.steps
        // as a fallback. The "Tool call" label kicks in if no
        // name resolves.
        if (!cancelled) {
          setPersistedNameByCallId(new Map());
          setPersistedNameByIndex([]);
        }
      });
    return () => { cancelled = true; };
  }, [agentRunId]);

  const items = buildTraceItems(steps, liveReasoning, liveToolCalls, persistedNameByCallId, persistedNameByIndex);
  const displayItems = (() => {
    if (!(isAgentActive && liveReasoning?.trim())) {
      return items;
    }

    let hiddenPersistedReasoning = false;
    return [...items].reverse().filter((item) => {
      if (
        !hiddenPersistedReasoning
        && item.type === "reasoning"
        && item.id !== "live-reasoning"
      ) {
        hiddenPersistedReasoning = true;
        return false;
      }
      return true;
    }).reverse();
  })();
  const tasks = extractTasks(steps, liveToolCalls);
  const persistedReasoningItems = displayItems.filter(
    (item): item is Extract<TraceItem, { type: "reasoning" }> => item.type === "reasoning" && item.id !== "live-reasoning"
  );
  const liveReasoningItem = displayItems.find(
    (item): item is Extract<TraceItem, { type: "reasoning" }> => item.type === "reasoning" && item.id === "live-reasoning"
  );

  useEffect(() => {

  }, [displayItems, liveReasoningItem, persistedReasoningItems]);

  if (displayItems.length === 0 && tasks.length === 0) return null;


  return (
    <div className={cn("my-2 space-y-2", className)}>
      {tasks.length > 0 ? <TaskList steps={steps} liveToolCalls={liveToolCalls} isAgentActive={isAgentActive} /> : null}
      {displayItems.map((item, index) => {

        if (item.type === "reasoning") {
          const isLive = item.id === "live-reasoning";
          return (
            <CollapsibleReasoning
              key={item.id}
              content={item.content}
              isLive={isLive}
              defaultOpen={index === displayItems.length - 1}
            />
          );
        }

        return (
          <div
            key={item.id}
            className={cn(
              isAgentActive && (item.status === "running" || item.status === "pending")
                && "animate-[slide-in-up_0.3s_ease-out]"
            )}
          >
            <ToolTraceCard
              name={item.name}
              parameters={item.parameters}
              result={item.result}
              status={item.status}
              workspacePath={workspacePath}
              onToolApproval={onToolApproval}
              approvalBusyIds={approvalBusyIds}
            />
          </div>
        );
      })}

      {/* ── Compact execution summary (shown when run is complete) ──── */}
      {!isAgentActive && displayItems.length > 0 && (() => {
        const toolItems = displayItems.filter((i): i is Extract<TraceItem, { type: "tool" }> => i.type === "tool");
        if (toolItems.length === 0) return null;
        const edits = toolItems.filter((i) => EDIT_TOOL_NAMES.has(i.name)).length;
        const reads = toolItems.filter((i) => ["read_file", "read_image", "list_directory", "search_content"].includes(i.name)).length;
        const commands = toolItems.filter((i) => ["execute_command", "start_process"].includes(i.name)).length;
        const web = toolItems.filter((i) => ["web_search", "fetch_url"].includes(i.name)).length;
        const git = toolItems.filter((i) => i.name.startsWith("git_")).length;
        const failed = toolItems.filter((i) => i.status === "failed").length;
        const parts: string[] = [];
        if (edits) parts.push(`${edits} file${edits > 1 ? "s" : ""} edited`);
        if (commands) parts.push(`${commands} command${commands > 1 ? "s" : ""} run`);
        if (reads) parts.push(`${reads} read`);
        if (web) parts.push(`${web} web lookup${web > 1 ? "s" : ""}`);
        if (git) parts.push(`${git} git op${git > 1 ? "s" : ""}`);
        if (parts.length === 0) parts.push(`${toolItems.length} tool${toolItems.length > 1 ? "s" : ""} used`);
        return (
          <div className="flex items-center gap-2 rounded border border-border/30 bg-card-3/30 px-3 py-1.5">
            <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50">
              Summary
            </span>
            <span className="font-mono-tech text-[9px] text-muted-foreground/60">
              {parts.join(" · ")}
            </span>
            {failed > 0 && (
              <span className="ml-auto font-mono-tech text-[9px] font-medium text-accent-red/70">
                {failed} failed
              </span>
            )}
          </div>
        );
      })()}
    </div>
  );
}
