// Reasoning budget + marker-dedup for the agent's thinking stream.
//
// Research L1/L2 in the roadmap: cap the length of streamed reasoning, and
// detect when the model is looping on cognitive markers like "Let me think",
// "Wait", "Actually". Based on Together AI's CREST (Jan 2026) and Elastic
// Reasoning (ICLR 2026).

export const REASONING_BUDGET_TOKENS_DEFAULT = 4_000;
export const REASONING_BUDGET_TOKENS_PLAN = 8_000;
export const REASONING_BUDGET_TOKENS_AGENT = 12_000;
export const REASONING_BUDGET_TOKENS_CHAT = 1_500;

/** Approximate tokens from a string. Rough rule: 1 token ≈ 4 chars. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const COGNITIVE_MARKER_REGEX = /\b(let me think|let\u2019s think|wait|actually|hmm|so,|therefore|on the other hand|in other words|let me reconsider)\b/gi;

export type ReasoningBudgetState = {
  budgetTokens: number;
  tokensUsed: number;
  /** Count of distinct cognitive markers seen in this stream. */
  markerCount: number;
  /** Whether we've already emitted the "exceeded budget" signal. */
  exceeded: boolean;
};

export function createReasoningBudgetState(
  budgetTokens: number = REASONING_BUDGET_TOKENS_DEFAULT
): ReasoningBudgetState {
  return {
    budgetTokens,
    tokensUsed: 0,
    markerCount: 0,
    exceeded: false
  };
}

export type ReasoningDeltaResult = {
  /** True if the caller should accept this delta. */
  accept: boolean;
  /** Truncated delta (may be empty if no remaining budget). */
  truncatedDelta: string;
  /** Tokens consumed by this delta. */
  deltaTokens: number;
  /** Whether budget was exhausted by this delta. */
  budgetExhausted: boolean;
};

/**
 * Process a streaming reasoning delta against the budget.
 * - Counts tokens and clamps if the budget is exceeded.
 * - Counts repeated cognitive markers (loop detection).
 */
export function applyReasoningDelta(
  state: ReasoningBudgetState,
  delta: string
): ReasoningDeltaResult {
  if (!delta) {
    return { accept: true, truncatedDelta: "", deltaTokens: 0, budgetExhausted: state.exceeded };
  }

  const deltaTokens = estimateTokens(delta);

  if (state.exceeded) {
    return { accept: false, truncatedDelta: "", deltaTokens, budgetExhausted: true };
  }

  const matches = delta.match(COGNITIVE_MARKER_REGEX);
  if (matches) {
    state.markerCount += matches.length;
  }

  if (state.tokensUsed + deltaTokens > state.budgetTokens) {
    const remainingTokens = Math.max(0, state.budgetTokens - state.tokensUsed);
    const remainingChars = remainingTokens * 4;
    const truncated = delta.slice(0, remainingChars);
    state.tokensUsed = state.budgetTokens;
    state.exceeded = true;
    return {
      accept: true,
      truncatedDelta: truncated,
      deltaTokens: remainingTokens,
      budgetExhausted: true
    };
  }

  state.tokensUsed += deltaTokens;
  return {
    accept: true,
    truncatedDelta: delta,
    deltaTokens,
    budgetExhausted: false
  };
}

/**
 * Build a correction prompt when the model is looping on cognitive markers.
 * Returns null if the count is below the threshold.
 */
export function maybeMarkerLoopCorrection(
  state: ReasoningBudgetState,
  threshold: number = 8
): string | null {
  if (state.markerCount < threshold) return null;
  return [
    "You appear to be re-thinking the same points repeatedly.",
    "Please commit to an approach now and execute it via tool calls.",
    `You have used ${state.tokensUsed} of ${state.budgetTokens} reasoning tokens.`
  ].join(" ");
}
