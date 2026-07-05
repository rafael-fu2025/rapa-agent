// Resumable agent run detection and context injection.
//
// When a conversation's last agent run ended without finishing cleanly
// (max iterations, failure, or interruption), the next user prompt can
// optionally resume from where it left off instead of starting from scratch.

import { prisma } from "../../lib/db.js";
import { RESUMABLE_RUN_STATUSES, AUTO_RESUME_PROMPT_PATTERN } from "./schemas.js";

export type ResumableRunContext = {
  id: string;
  status: string;
  promptPreview?: string | null;
  responsePreview?: string | null;
  runSummary?: string | null;
  errorMessage?: string | null;
  iterationCount: number;
  lastStep?: {
    iteration: number;
    reasoning?: string | null;
    responsePreview?: string | null;
  } | null;
};

export function shouldAutoResumePrompt(prompt: string) {
  return AUTO_RESUME_PROMPT_PATTERN.test(prompt);
}

export function buildResumeContextMessage(run: ResumableRunContext) {
  const detailLines = [
    `Previous unfinished run ID: ${run.id}`,
    `Status: ${run.status}`,
    run.promptPreview ? `Previous task: ${run.promptPreview}` : undefined,
    run.runSummary ? `Progress summary: ${run.runSummary}` : undefined,
    run.responsePreview ? `Last visible response: ${run.responsePreview}` : undefined,
    run.errorMessage ? `Failure detail: ${run.errorMessage}` : undefined,
    run.lastStep?.reasoning ? `Last step reasoning: ${run.lastStep.reasoning}` : undefined,
    run.lastStep?.responsePreview ? `Last step response preview: ${run.lastStep.responsePreview}` : undefined
  ].filter(Boolean).join("\n");

  return [
    "Resume context: the previous agent run in this conversation did not finish cleanly.",
    detailLines,
    "Continue from this checkpoint instead of restarting completed work unless verification requires it.",
    "If the user's new prompt changes direction, follow the new request and treat this resume context as background only."
  ].join("\n\n");
}

export async function loadLatestResumableRun(conversationId: string): Promise<ResumableRunContext | null> {
  const run = await prisma.agentRun.findFirst({
    where: {
      conversationId,
      status: { in: [...RESUMABLE_RUN_STATUSES] }
    },
    orderBy: { updatedAt: "desc" },
    include: {
      steps: {
        orderBy: { iteration: "desc" },
        take: 1
      }
    }
  });

  if (!run) return null;

  const lastStep = run.steps[0];
  return {
    id: run.id,
    status: run.status,
    promptPreview: run.promptPreview,
    responsePreview: run.responsePreview,
    runSummary: run.runSummary,
    errorMessage: run.errorMessage,
    iterationCount: run.iterationCount,
    lastStep: lastStep
      ? {
          iteration: lastStep.iteration,
          reasoning: lastStep.reasoning,
          responsePreview: lastStep.responsePreview
        }
      : null
  };
}
