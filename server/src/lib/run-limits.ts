// Run limits (research ASI10 — Rogue Agents).
//
// Enforces hard caps on the resources a single agent run can consume.
// The agent loop checks `RunLimitTracker.shouldStop()` at the top of every
// iteration and yields a `limit_exceeded` event before doing more work.
//
// Limits:
//   - maxTokens  — total tokens consumed by the run
//   - maxCostUsd — estimated dollar cost (uses a per-model price table)
//   - maxDurationMs — wall-clock time
//   - maxIterations — already enforced in agent.ts, kept here for
//     consistency with the limits the user can configure in settings.
//
// Cost estimation uses a per-model price table for major providers. For
// unknown models, a conservative default of $5/1M tokens is used (rough
// midpoint of Claude Sonnet-class pricing).

export type RunLimits = {
  maxTokens?: number;
  maxCostUsd?: number;
  maxDurationMs?: number;
  maxIterations?: number;
};

export type RunUsage = {
  tokens: number;
  costUsd: number;
  startedAt: number;
  iterations: number;
};

export type LimitBreach = {
  kind: "tokens" | "cost" | "duration";
  limit: number;
  actual: number;
  message: string;
};

const DEFAULT_PRICE_PER_MILLION = 5.0;

type ModelPrice = {
  inputPerMillion: number;
  outputPerMillion: number;
};

const PRICE_TABLE: Record<string, ModelPrice> = {
  // OpenAI
  "gpt-5": { inputPerMillion: 5, outputPerMillion: 15 },
  "gpt-5-mini": { inputPerMillion: 0.25, outputPerMillion: 2 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gpt-4.1": { inputPerMillion: 2, outputPerMillion: 8 },
  "gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  "gpt-4.1-nano": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  "o3": { inputPerMillion: 10, outputPerMillion: 40 },
  "o3-mini": { inputPerMillion: 1.1, outputPerMillion: 4.4 },
  "o4-mini": { inputPerMillion: 1.1, outputPerMillion: 4.4 },
  // Anthropic
  "claude-opus-4.7": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-sonnet-4.6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-sonnet-4.5": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4.5": { inputPerMillion: 1, outputPerMillion: 5 },
  // Google
  "gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 5 },
  "gemini-2.5-flash": { inputPerMillion: 0.075, outputPerMillion: 0.3 },
  "gemini-2.0-pro": { inputPerMillion: 1.25, outputPerMillion: 5 },
  // Meta
  "llama-4-scout": { inputPerMillion: 0.2, outputPerMillion: 0.6 }
};

/**
 * Estimate the dollar cost of a single LLM call given token counts and a
 * model name. Unknown models use a conservative default.
 */
export function estimateCallCost(model: string, inputTokens: number, outputTokens: number): number {
  const key = model.toLowerCase();
  const price = PRICE_TABLE[key]
    ?? Object.entries(PRICE_TABLE).find(([k]) => key.includes(k))?.[1];
  const inputRate = (price?.inputPerMillion ?? DEFAULT_PRICE_PER_MILLION) / 1_000_000;
  const outputRate = (price?.outputPerMillion ?? DEFAULT_PRICE_PER_MILLION) / 1_000_000;
  return inputTokens * inputRate + outputTokens * outputRate;
}

export class RunLimitTracker {
  private usage: RunUsage;
  private limits: RunLimits;
  private readonly runId: string;
  private onBreach?: (breach: LimitBreach) => void;

  constructor(runId: string, limits: RunLimits, now: number = Date.now()) {
    this.runId = runId;
    this.limits = limits;
    this.usage = { tokens: 0, costUsd: 0, startedAt: now, iterations: 0 };
  }

  setBreachListener(listener: (breach: LimitBreach) => void): void {
    this.onBreach = listener;
  }

  getUsage(): RunUsage {
    return { ...this.usage };
  }

  getLimits(): RunLimits {
    return { ...this.limits };
  }

  recordTokens(model: string, inputTokens: number, outputTokens: number): void {
    const total = Math.max(0, inputTokens) + Math.max(0, outputTokens);
    this.usage.tokens += total;
    this.usage.costUsd += estimateCallCost(model, inputTokens, outputTokens);
  }

  recordIteration(): void {
    this.usage.iterations += 1;
  }

  /**
   * Check whether the run has breached any limit. Returns the first breach
   * (if any) and fires the breach listener. The caller should yield a
   * `limit_exceeded` event and exit the loop.
   */
  checkLimits(): LimitBreach | null {
    if (this.limits.maxTokens !== undefined && this.usage.tokens > this.limits.maxTokens) {
      const breach: LimitBreach = {
        kind: "tokens",
        limit: this.limits.maxTokens,
        actual: this.usage.tokens,
        message: `Token limit exceeded: ${this.usage.tokens} > ${this.limits.maxTokens}`
      };
      this.onBreach?.(breach);
      return breach;
    }
    if (this.limits.maxCostUsd !== undefined && this.usage.costUsd > this.limits.maxCostUsd) {
      const breach: LimitBreach = {
        kind: "cost",
        limit: this.limits.maxCostUsd,
        actual: this.usage.costUsd,
        message: `Cost limit exceeded: $${this.usage.costUsd.toFixed(4)} > $${this.limits.maxCostUsd.toFixed(4)}`
      };
      this.onBreach?.(breach);
      return breach;
    }
    if (this.limits.maxDurationMs !== undefined) {
      const elapsed = Date.now() - this.usage.startedAt;
      if (elapsed > this.limits.maxDurationMs) {
        const breach: LimitBreach = {
          kind: "duration",
          limit: this.limits.maxDurationMs,
          actual: elapsed,
          message: `Duration limit exceeded: ${elapsed}ms > ${this.limits.maxDurationMs}ms`
        };
        this.onBreach?.(breach);
        return breach;
      }
    }
    if (this.limits.maxIterations !== undefined && this.usage.iterations > this.limits.maxIterations) {
      const breach: LimitBreach = {
        kind: "duration",
        limit: this.limits.maxIterations,
        actual: this.usage.iterations,
        message: `Iteration limit exceeded: ${this.usage.iterations} > ${this.limits.maxIterations}`
      };
      this.onBreach?.(breach);
      return breach;
    }
    return null;
  }

  /** Build a one-line summary suitable for SSE events / DB rows. */
  summary(): string {
    const parts: string[] = [];
    parts.push(`${this.usage.tokens} tokens`);
    parts.push(`$${this.usage.costUsd.toFixed(4)}`);
    parts.push(`${this.usage.iterations} iterations`);
    if (this.limits.maxDurationMs) {
      const elapsed = Date.now() - this.usage.startedAt;
      parts.push(`${(elapsed / 1000).toFixed(1)}s / ${(this.limits.maxDurationMs / 1000).toFixed(0)}s`);
    }
    return parts.join(" | ");
  }
}

/**
 * Default run limits. Loaded from env at boot. Users can override per-run
 * via the agent request payload.
 */
export function loadDefaultRunLimits(): RunLimits {
  return {
    maxTokens: readEnvInt("AGENT_RUN_MAX_TOKENS", 1_000_000),
    maxCostUsd: readEnvNumber("AGENT_RUN_MAX_COST_USD", 5.0),
    maxDurationMs: readEnvInt("AGENT_RUN_MAX_DURATION_MS", 30 * 60 * 1000),
    maxIterations: readEnvInt("AGENT_RUN_MAX_ITERATIONS", 60)
  };
}

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
