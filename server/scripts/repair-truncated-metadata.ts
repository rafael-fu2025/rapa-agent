/**
 * Repair script for truncated tool call data in message metadata.
 *
 * The `sanitizeJsonValue` function in conversation-memory.ts had a depth
 * limit of 4, which caused tool call objects inside `metadata.steps` to
 * be replaced with "[truncated]". The AgentToolCall rows in the database
 * have the original data (stored with a depth limit of 5, applied to a
 * flatter structure). This script rebuilds the metadata.steps from the
 * AgentToolCall rows.
 *
 * Usage:
 *   cd server
 *   npx tsx scripts/repair-truncated-metadata.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TOOL_OUTPUT_CHAR_LIMIT = 1200;

function truncateText(value: string, limit: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(0, limit - 1))}…`;
}

/** Check if a JSON value contains "[truncated]" at any depth. */
function containsTruncated(value: unknown): boolean {
  if (value === "[truncated]") return true;
  if (typeof value === "string") return value === "[truncated]";
  if (Array.isArray(value)) return value.some(containsTruncated);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsTruncated);
  }
  return false;
}

async function main() {
  console.log("Scanning for messages with truncated metadata...");

  // Find all assistant messages with agent mode that have metadata
  const messages = await prisma.message.findMany({
    where: {
      role: "assistant",
      mode: "agent",
      metadata: { not: null }
    },
    select: {
      id: true,
      metadata: true,
      conversationId: true
    }
  });

  let truncatedCount = 0;
  let repairedCount = 0;
  let skippedCount = 0;

  for (const msg of messages) {
    const metadata = msg.metadata as Record<string, unknown> | null;
    if (!metadata || !metadata.steps) continue;

    // Check if any step has truncated tool calls
    const steps = metadata.steps as unknown[];
    const hasTruncation = steps.some((step) => {
      if (!step || typeof step !== "object") return false;
      const s = step as Record<string, unknown>;
      const toolCalls = s.toolCalls;
      const toolResults = s.toolResults;
      return containsTruncated(toolCalls) || containsTruncated(toolResults);
    });

    if (!hasTruncation) continue;
    truncatedCount++;

    // Find the AgentRun for this message
    const agentRunId = typeof metadata.agentRunId === "string" ? metadata.agentRunId : null;
    let runId = agentRunId;

    if (!runId) {
      // Try finding via assistantMessageId relation
      const run = await prisma.agentRun.findFirst({
        where: { assistantMessageId: msg.id },
        select: { id: true }
      });
      runId = run?.id ?? null;
    }

    if (!runId) {
      console.log(`  [SKIP] Message ${msg.id}: no AgentRun found`);
      skippedCount++;
      continue;
    }

    // Fetch the AgentRunStep and AgentToolCall data
    const runSteps = await prisma.agentRunStep.findMany({
      where: { runId },
      orderBy: { iteration: "asc" },
      include: {
        toolCalls: {
          orderBy: { createdAt: "asc" }
        }
      }
    });

    if (runSteps.length === 0) {
      console.log(`  [SKIP] Message ${msg.id}: AgentRun has no steps`);
      skippedCount++;
      continue;
    }

    // Rebuild the steps array
    const rebuiltSteps = runSteps.map((dbStep) => {
      const toolCalls = dbStep.toolCalls.map((tc) => ({
        id: tc.externalCallId ?? tc.id,
        name: tc.name,
        parameters: (tc.parameters as Record<string, unknown>) ?? {}
      }));

      const toolResults = dbStep.toolCalls.map((tc) => {
        const rd = tc.resultData as Record<string, unknown> | null;
        return {
          success: rd?.success === true,
          error: typeof rd?.error === "string" ? rd.error as string : undefined,
          output: typeof rd?.output === "string"
            ? truncateText(rd.output as string, TOOL_OUTPUT_CHAR_LIMIT)
            : undefined,
          data: rd?.data ?? null
        };
      });

      return {
        iteration: dbStep.iteration,
        reasoning: dbStep.reasoning ?? undefined,
        toolCalls,
        toolResults,
        response: dbStep.response ? truncateText(dbStep.response, TOOL_OUTPUT_CHAR_LIMIT) : undefined,
        timestamp: dbStep.timestamp instanceof Date
          ? dbStep.timestamp.toISOString()
          : new Date(dbStep.timestamp).toISOString()
      };
    });

    // Rebuild the metadata, preserving other fields
    const newMetadata: Record<string, unknown> = {
      ...metadata,
      steps: rebuiltSteps
    };

    // Update the message
    await prisma.message.update({
      where: { id: msg.id },
      data: { metadata: newMetadata as any }
    });

    repairedCount++;
    console.log(
      `  [OK] Message ${msg.id}: rebuilt ${rebuiltSteps.length} steps, ` +
      `${rebuiltSteps.reduce((sum, s) => sum + s.toolCalls.length, 0)} tool calls`
    );
  }

  console.log(`\nDone.`);
  console.log(`  Scanned:    ${messages.length} assistant messages`);
  console.log(`  Truncated:  ${truncatedCount}`);
  console.log(`  Repaired:   ${repairedCount}`);
  console.log(`  Skipped:    ${skippedCount}`);
}

main()
  .catch((err) => {
    console.error("Repair failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
