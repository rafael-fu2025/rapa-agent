// Tool approval machinery.
//
// When the agent wants to execute a tool that requires user approval
// (e.g. shell commands, file writes), this module manages the async
// request/response flow: the route handler creates a pending approval,
// the frontend shows a confirmation dialog, and the user's decision is
// submitted via the POST /agent/approvals endpoint.

import type { ToolApprovalDecision, ToolApprovalRequest } from "../../lib/agent.js";
import { shouldAutoApprove } from "../../lib/auto-approve.js";
import { classifyAutoApproval, resolveClassifierConfig } from "../../lib/auto-approve-classifier.js";
import { analyseCommandRisk } from "../../lib/safety/dangerous-patterns.js";
import { APPROVAL_TIMEOUT_MS } from "./schemas.js";

/** Shell tools whose approval requests are routed through the LLM classifier. */
const CLASSIFIER_ELIGIBLE_TOOLS = new Set(["execute_command", "start_process"]);

export type PendingToolApproval = {
  userId: string;
  conversationId: string;
  request: ToolApprovalRequest;
  createdAt: number;
  timeout: NodeJS.Timeout;
  resolve: (decision: ToolApprovalDecision) => void;
};

export const pendingToolApprovals = new Map<string, PendingToolApproval>();

/** Serializable snapshot of a pending approval for the rehydration API. */
export type PendingApprovalInfo = {
  approvalId: string;
  conversationId: string;
  toolName: string;
  command: string;
  createdAt: number;
};

/**
 * List this user's pending (unanswered) approvals, optionally scoped to a
 * conversation. Powers GET /agent/approvals/pending so a reloaded page can
 * re-present an approval prompt instead of orphaning a blocked run
 * (audit M2.2).
 */
export function listPendingApprovals(userId: string, conversationId?: string): PendingApprovalInfo[] {
  const result: PendingApprovalInfo[] = [];
  for (const [approvalId, pending] of pendingToolApprovals) {
    if (pending.userId !== userId) continue;
    if (conversationId && pending.conversationId !== conversationId) continue;
    result.push({
      approvalId,
      conversationId: pending.conversationId,
      toolName: pending.request.call.name,
      command: typeof pending.request.call.parameters?.command === "string"
        ? pending.request.call.parameters.command
        : "",
      createdAt: pending.createdAt
    });
  }
  return result;
}

function getApprovalId(request: ToolApprovalRequest) {
  return `${request.conversationId}:${request.call.id}`;
}

export function waitForToolApproval(userId: string, request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
  const approvalId = getApprovalId(request);

  const existing = pendingToolApprovals.get(approvalId);
  if (existing) {
    clearTimeout(existing.timeout);
    pendingToolApprovals.delete(approvalId);
    existing.resolve({ approved: false, message: "A newer approval request replaced this command." });
  }

  return new Promise((resolve) => {
    const complete = (decision: ToolApprovalDecision) => {
      const current = pendingToolApprovals.get(approvalId);
      if (current) {
        clearTimeout(current.timeout);
        pendingToolApprovals.delete(approvalId);
      }
      resolve(decision);
    };

    const timeout = setTimeout(() => {
      complete({ approved: false, message: "Command approval timed out." });
    }, APPROVAL_TIMEOUT_MS);

    pendingToolApprovals.set(approvalId, {
      userId,
      conversationId: request.conversationId,
      request,
      createdAt: Date.now(),
      timeout,
      resolve: complete
    });
  });
}

export function resolvePendingApproval(approvalId: string, decision: ToolApprovalDecision): boolean {
  const pending = pendingToolApprovals.get(approvalId);
  if (!pending) return false;
  pending.resolve(decision);
  return true;
}

export async function handleToolApproval(
  userId: string,
  workspaceId: string,
  conversationId: string,
  request: ToolApprovalRequest
): Promise<ToolApprovalDecision> {
  // Extract command from parameters for shell tools
  const command = typeof request.call.parameters?.command === "string"
    ? request.call.parameters.command
    : "";

  if (command) {
    // Severity gate FIRST — the documented contract (dangerous-patterns.ts):
    // a "destructive"/"irreversible" finding always goes to the human and
    // overrides any stored auto-approve pattern. Previously a saved wildcard
    // pattern could silently auto-approve `rm -rf /`. The LLM classifier
    // below runs only AFTER this gate, so it can never approve a
    // destructive/irreversible command.
    const risk = analyseCommandRisk(command);
    const severityForcesHuman =
      risk.severity === "destructive" || risk.severity === "irreversible";

    if (!severityForcesHuman) {
      // LLM classifier (opt-in): classify the command BEFORE pattern matching.
      //   approve → resolve as approved (autoApproved)
      //   deny    → resolve as denied with the classifier's reason
      //   unsure  → continue to stored patterns + human prompt as before.
      // The classifier config rides on the approval request (populated by
      // ToolOrchestrator from AgentConfig.autoApproveClassifier); when absent,
      // RAPA_AUTO_APPROVE_CLASSIFIER_MODEL opts it in.
      if (CLASSIFIER_ELIGIBLE_TOOLS.has(request.call.name)) {
        const classifierConfig = resolveClassifierConfig(request.autoApproveClassifier);
        if (classifierConfig.enabled) {
          const verdict = await classifyAutoApproval({
            command,
            toolName: request.call.name,
            userId,
            classifier: classifierConfig
          });
          if (verdict.decision === "approve") {
            return {
              approved: true,
              message: `Auto-approved by classifier: ${verdict.reason}`,
              autoApproved: true
            };
          }
          if (verdict.decision === "deny") {
            return {
              approved: false,
              message: `Denied by classifier: ${verdict.reason}`
            };
          }
          // "unsure" — fall through to pattern matching + human prompt.
        }
      }

      const autoApproveResult = await shouldAutoApprove({
        userId,
        command,
        toolName: request.call.name,
        workspaceId,
        conversationId
      });

      if (autoApproveResult.approved) {
        return {
          approved: true,
          message: `Auto-approved by pattern: ${autoApproveResult.matchedPattern?.name}`,
          autoApproved: true,
          matchedPatternId: autoApproveResult.matchedPattern?.id
        };
      }
    }
  }

  // Fall back to manual approval
  return waitForToolApproval(userId, request);
}
