// Tool approval machinery.
//
// When the agent wants to execute a tool that requires user approval
// (e.g. shell commands, file writes), this module manages the async
// request/response flow: the route handler creates a pending approval,
// the frontend shows a confirmation dialog, and the user's decision is
// submitted via the POST /agent/approvals endpoint.

import type { ToolApprovalDecision, ToolApprovalRequest } from "../../lib/agent.js";
import { shouldAutoApprove } from "../../lib/auto-approve.js";
import { analyseCommandRisk } from "../../lib/safety/dangerous-patterns.js";
import { APPROVAL_TIMEOUT_MS } from "./schemas.js";

export type PendingToolApproval = {
  userId: string;
  conversationId: string;
  request: ToolApprovalRequest;
  timeout: NodeJS.Timeout;
  resolve: (decision: ToolApprovalDecision) => void;
};

export const pendingToolApprovals = new Map<string, PendingToolApproval>();

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
    // pattern could silently auto-approve `rm -rf /`.
    const risk = analyseCommandRisk(command);
    const severityForcesHuman =
      risk.severity === "destructive" || risk.severity === "irreversible";

    if (!severityForcesHuman) {
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
