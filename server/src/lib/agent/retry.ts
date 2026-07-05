// Typed retry policies for tool execution.
//
// Replaces the legacy regex-based RETRYABLE_PATTERNS with a per-error-class
// config that gives us exponential backoff with jitter, distinct budgets for
// transient vs business-logic failures, and clear rules for what to never retry
// (validation, permission, not-found).
//
// References: agentic-reliability SKILL, MavikLabs 2026 timeout guide, and the
// "compounding failure problem" math in the roadmap research doc.

import type { ToolErrorCategory } from "../tools.js";

export type RetryConfig = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  exponentialBase: number;
  /** ±jitterFactor randomization, e.g. 0.25 = ±25 %. */
  jitterFactor: number;
  /** Errors that should be retried with this config. */
  retryableCategories: ToolErrorCategory[];
  /** Errors that should fail fast (overrides retryableCategories). */
  nonRetryableCategories: ToolErrorCategory[];
  /** Optional cap on total wall-clock time spent retrying. */
  maxTotalMs?: number;
};

/** Default policy: matches the 2026 production pattern. */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  exponentialBase: 2,
  jitterFactor: 0.25,
  retryableCategories: ["rate_limit", "transient", "timeout"],
  nonRetryableCategories: ["validation", "permission", "not_found", "fatal"]
};

/** Per-error-class overrides (see research doc T1). */
export const RETRY_CONFIG_BY_CATEGORY: Record<ToolErrorCategory, RetryConfig> = {
  rate_limit: {
    ...DEFAULT_RETRY_CONFIG,
    maxAttempts: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000
  },
  transient: {
    ...DEFAULT_RETRY_CONFIG,
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 10_000
  },
  timeout: {
    ...DEFAULT_RETRY_CONFIG,
    maxAttempts: 2,
    baseDelayMs: 0,
    maxDelayMs: 0
  },
  validation: { ...DEFAULT_RETRY_CONFIG, maxAttempts: 1 },
  permission: { ...DEFAULT_RETRY_CONFIG, maxAttempts: 1 },
  not_found: { ...DEFAULT_RETRY_CONFIG, maxAttempts: 1 },
  fatal: { ...DEFAULT_RETRY_CONFIG, maxAttempts: 1 }
};

export function calculateBackoff(attempt: number, config: RetryConfig): number {
  if (config.baseDelayMs === 0) return 0;
  const exponential = Math.min(
    config.baseDelayMs * Math.pow(config.exponentialBase, attempt),
    config.maxDelayMs
  );
  const jitter = exponential * config.jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, exponential + jitter);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryable(
  category: ToolErrorCategory,
  attempt: number,
  config: RetryConfig
): boolean {
  if (config.nonRetryableCategories.includes(category)) return false;
  if (!config.retryableCategories.includes(category)) return false;
  return attempt < config.maxAttempts;
}

export function selectConfigForCategory(category: ToolErrorCategory): RetryConfig {
  return RETRY_CONFIG_BY_CATEGORY[category] ?? DEFAULT_RETRY_CONFIG;
}
