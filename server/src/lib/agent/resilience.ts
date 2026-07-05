// Resilience wrapper: combines timeout, circuit-breaker, and typed retry around
// a tool's raw execute() method. Returns a ToolResult with the right
// errorCategory set, and a durationMs so the agent loop can attribute latency.
//
// Replaces the legacy `retryToolCall` regex-based logic in tool-orchestrator.ts.

import { toolCircuitBreaker, CircuitOpenError } from "./circuit-breaker.js";
import {
  calculateBackoff,
  isRetryable,
  selectConfigForCategory,
  sleep,
  type RetryConfig
} from "./retry.js";
import {
  getToolTimeoutMs,
  withTimeout,
  ToolTimeoutError
} from "./timeout.js";
import type { ToolErrorCategory, ToolExecutionContext, ToolResult } from "../tools.js";

const HTTP_5XX_PATTERN = /\b(5\d\d)\b/;
const HTTP_429_PATTERN = /\b(429)\b/;
const HTTP_4XX_PATTERN = /\b(4\d\d)\b/;
const RATE_LIMIT_PHRASES = ["rate limit", "too many requests", "quota exceeded"];
const TRANSIENT_PHRASES = [
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "fetch failed", "socket hang up", "service unavailable", "internal server error",
  "bad gateway", "gateway timeout"
];
const VALIDATION_PHRASES = [
  "invalid parameters", "missing required", "must be", "should be",
  "invalid argument", "validation"
];
const PERMISSION_PHRASES = [
  "EACCES", "permission denied", "unauthorized", "forbidden", "EPERM"
];
const NOT_FOUND_PHRASES = [
  "ENOENT", "no such file", "not found", "does not exist"
];

export function classifyError(message: string, name?: string): ToolErrorCategory {
  if (name === "ToolTimeoutError") return "timeout";
  if (name === "CircuitOpenError") return "transient";

  const m = message || "";
  const mLower = m.toLowerCase();

  if (HTTP_429_PATTERN.test(m) || RATE_LIMIT_PHRASES.some((p) => mLower.includes(p))) {
    return "rate_limit";
  }
  if (HTTP_5XX_PATTERN.test(m) || TRANSIENT_PHRASES.some((p) => mLower.includes(p))) {
    return "transient";
  }
  if (HTTP_4XX_PATTERN.test(m) || VALIDATION_PHRASES.some((p) => mLower.includes(p))) {
    return "validation";
  }
  if (PERMISSION_PHRASES.some((p) => m.includes(p) || mLower.includes(p.toLowerCase()))) {
    return "permission";
  }
  if (NOT_FOUND_PHRASES.some((p) => mLower.includes(p))) {
    return "not_found";
  }
  return "fatal";
}

export type ExecuteWithResilienceOptions = {
  toolName: string;
  execute: () => Promise<ToolResult>;
  context: ToolExecutionContext;
  /** Optional override; otherwise derived from defaultToolTimeoutMs. */
  timeoutMs?: number;
  /** Optional override; otherwise derived from category. */
  retryConfig?: RetryConfig;
};

export async function executeWithResilience(
  options: ExecuteWithResilienceOptions
): Promise<ToolResult> {
  const { toolName, execute, context } = options;
  const timeoutMs = options.timeoutMs ?? getToolTimeoutMs(toolName);
  const start = Date.now();

  // Circuit breaker check.
  try {
    toolCircuitBreaker.guard(toolName);
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      return {
        success: false,
        error: error.message,
        errorCategory: "transient",
        fatal: false,
        durationMs: Date.now() - start,
        data: { circuitOpen: true, recoveryAt: error.recoveryAt }
      };
    }
    throw error;
  }

  let lastResult: ToolResult | null = null;
  let lastCategory: ToolErrorCategory = "fatal";
  const config = options.retryConfig ?? selectConfigForCategory("transient");

  for (let attempt = 0; attempt < config.maxAttempts; attempt += 1) {
    try {
      const result = await withTimeout(toolName, execute(), timeoutMs);
      const finalResult: ToolResult = {
        ...result,
        durationMs: Date.now() - start
      };
      toolCircuitBreaker.recordSuccess(toolName);
      return finalResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const name = error instanceof Error ? error.name : undefined;
      const category = classifyError(message, name);
      lastCategory = category;
      const retryConfig = options.retryConfig ?? selectConfigForCategory(category);

      lastResult = {
        success: false,
        error: message,
        errorCategory: category,
        fatal: !isRetryable(category, attempt + 1, retryConfig),
        durationMs: Date.now() - start
      };

      if (!isRetryable(category, attempt + 1, retryConfig)) {
        toolCircuitBreaker.recordFailure(toolName);
        return lastResult;
      }

      const delay = calculateBackoff(attempt, retryConfig);
      await sleep(delay);
    }
  }

  if (lastResult) {
    toolCircuitBreaker.recordFailure(toolName);
    return lastResult;
  }

  return {
    success: false,
    error: "Tool execution failed without a result",
    errorCategory: lastCategory,
    durationMs: Date.now() - start
  };
}
