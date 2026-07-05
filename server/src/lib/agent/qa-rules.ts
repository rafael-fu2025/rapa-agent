// Lightweight output QA — rule layer (research Q1).
//
// Cheap, fast checks that catch the most common quality regressions before
// they reach the user. Complements the more expensive LLM-as-judge layer (Q3)
// and the dynamic test-runner layer (Q4 / C6).
//
// Each rule returns a list of issues. If any issue has severity === "fail",
// the response is considered unreliable.

import type { AgentStep, ToolCall, ToolResult } from "./types.js";

export type QaSeverity = "pass" | "warn" | "fail";

export type QaIssue = {
  rule: string;
  severity: QaSeverity;
  message: string;
};

export type QaContext = {
  response: string;
  steps: AgentStep[];
  /** Names of all tools called during the run. */
  toolsCalled: string[];
};

const TOOL_REFERENCE_REGEX = /\b(read_file|write_file|edit_file|search_files|search_content|list_directory|execute_command|fetch_url|web_search|git_status|git_diff|git_log|git_commit|read_lints|run_tests|ask_user|think|add_task|update_task)\b/;

export function runRuleLayerQA(context: QaContext): QaIssue[] {
  const issues: QaIssue[] = [];
  const { response, steps, toolsCalled } = context;

  // Rule 1: response must be non-empty
  if (!response || response.trim().length === 0) {
    issues.push({
      rule: "non_empty_response",
      severity: "fail",
      message: "Assistant produced an empty response."
    });
  }

  // Rule 2: response must reference at least one actually-called tool when work
  // was done. (Catches "I forgot to call the tool" / pure-confabulation cases.)
  const hadWork = steps.some((s) => s.toolCalls && s.toolCalls.length > 0);
  if (hadWork && toolsCalled.length > 0 && response.length > 60) {
    const referenced = TOOL_REFERENCE_REGEX.test(response)
      || /\b(file|directory|command|search|test|tool|workspace|read|wrote|edited|searched|found)\b/i.test(response);
    if (!referenced) {
      issues.push({
        rule: "grounded_in_tools",
        severity: "warn",
        message: "Response does not appear to reference any tools or work performed."
      });
    }
  }

  // Rule 3: response must not contradict an explicit tool failure
  for (const step of steps) {
    for (const result of step.toolResults ?? []) {
      if (!result.success && result.error) {
        const errorSnippet = result.error.slice(0, 30).toLowerCase();
        if (errorSnippet.length > 5 && response.toLowerCase().includes(errorSnippet)) {
          // The response echoes the error — that's actually GOOD, it shows the
          // model acknowledged the failure. Skip.
          continue;
        }
        // Check if the response claims success despite a failure.
        if (/\b(done|success|completed|finished|works|fixed)\b/i.test(response)
          && !/failed|error|couldn'?t|unable|problem|issue/i.test(response)) {
          issues.push({
            rule: "no_false_success",
            severity: "warn",
            message: `Response may claim success despite a tool failure: ${result.error.slice(0, 80)}`
          });
        }
      }
    }
  }

  // Rule 4: response should not be an apology-only response when work was done
  const trimmed = response.trim();
  const isApologyOnly = /^(sorry|i apologize|my apologies|unfortunately)[,.]?\s*$/i.test(trimmed);
  if (isApologyOnly && hadWork) {
    issues.push({
      rule: "no_apology_only",
      severity: "warn",
      message: "Response is only an apology despite tool work having been performed."
    });
  }

  // Rule 5: minimum substance for substantive answers
  if (hadWork && trimmed.length < 20 && !isApologyOnly) {
    issues.push({
      rule: "minimum_substance",
      severity: "warn",
      message: `Response is too short (${trimmed.length} chars) given the work performed.`
    });
  }

  // Rule 6: response should not contain obvious leak patterns
  if (/\b(api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9]{20,})/i.test(response)) {
    issues.push({
      rule: "no_secret_leak",
      severity: "fail",
      message: "Response appears to contain a hardcoded API key or secret."
    });
  }

  return issues;
}

export function hasFailedRule(issues: QaIssue[]): boolean {
  return issues.some((i) => i.severity === "fail");
}

export function summarizeQaIssues(issues: QaIssue[]): string {
  if (issues.length === 0) return "QA passed all rule checks.";
  return issues
    .map((i) => `[${i.severity.toUpperCase()}] ${i.rule}: ${i.message}`)
    .join("\n");
}
