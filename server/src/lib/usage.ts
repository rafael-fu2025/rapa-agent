import type { AgentTokenUsage } from "./agent.js";
import { prisma } from "./db.js";

type RecordUsageParams = {
  userId: string;
  provider: string;
  model: string;
  mode: "chat" | "agent" | "plan";
  tokenUsage?:
    | { promptTokens?: number; completionTokens?: number; totalTokens?: number }
    | AgentTokenUsage
    | null;
};

export async function recordUsage(params: RecordUsageParams) {
  const promptTokens = params.tokenUsage?.promptTokens ?? 0;
  const completionTokens = params.tokenUsage?.completionTokens ?? 0;
  const totalTokens =
    params.tokenUsage?.totalTokens ?? promptTokens + completionTokens;

  if (totalTokens === 0 && promptTokens === 0 && completionTokens === 0) {
    return;
  }

  await prisma.usageRecord.create({
    data: {
      userId: params.userId,
      provider: params.provider,
      model: params.model,
      mode: params.mode,
      promptTokens: Math.max(0, Math.round(promptTokens)),
      completionTokens: Math.max(0, Math.round(completionTokens)),
      totalTokens: Math.max(0, Math.round(totalTokens)),
    },
  });
}
