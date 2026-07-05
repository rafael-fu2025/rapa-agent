// Eval framework (research P2-D).
//
// Lightweight evaluation harness for agent runs. You define a "golden
// trace" — a fixture of expected events for a given prompt + workspace —
// and the framework replays it and asserts the actual run matches.
//
// The framework is intentionally simple: no ML, no statistical model, just
// a deterministic matcher. It is designed to catch regressions in
// the agent loop (wrong tool chosen, wrong file modified, runaway cost)
// without trying to score subjective quality.
//
// Use cases:
//   - Replay a known-good run before deploying a prompt change
//   - Assert that a new tool change doesn't break the agent's tool
//     selection on a regression test
//   - Catch cost regressions (a prompt change shouldn't 10x the tokens)

import type { AgentExecutionEvent } from "../lib/agent/types.js";

export type GoldenEvent = {
  type: AgentExecutionEvent["type"] | "any";
  /** Optional: the event's `tool` (for tool_call) must match. */
  tool?: string;
  /** Optional: the event must contain this substring in `content` (case-insensitive). */
  contentContains?: string;
  /** Optional: the event must NOT contain this substring in `content` (case-insensitive). */
  contentNotContains?: string;
  /** Optional: the tool call's parameters must contain this object (deep partial match). */
  parametersContain?: Record<string, unknown>;
  /** Optional: a custom assertion that runs against the event. */
  assert?: (event: AgentExecutionEvent) => void | string;
};

export type GoldenCase = {
  id: string;
  description: string;
  prompt: string;
  events: GoldenEvent[];
  /** Optional: the run should consume fewer than N tokens. */
  maxTotalTokens?: number;
  /** Optional: the run should consume less than $X. */
  maxCostUsd?: number;
  /** Optional: the run should complete in fewer than N iterations. */
  maxIterations?: number;
};

export type EvalFailure = {
  caseId: string;
  eventIndex: number;
  reason: string;
};

export type EvalResult = {
  caseId: string;
  pass: boolean;
  failures: EvalFailure[];
  eventsChecked: number;
  durationMs: number;
};

export type EventSource = AsyncIterable<AgentExecutionEvent> | Iterable<AgentExecutionEvent>;

/**
 * Run a single golden case against an event source. The source is
 * consumed once and the events are matched against the case's expectations
 * in order.
 */
export async function runEval(caseDef: GoldenCase, source: EventSource): Promise<EvalResult> {
  const start = Date.now();
  const failures: EvalFailure[] = [];
  const events: AgentExecutionEvent[] = [];

  for await (const event of source as AsyncIterable<AgentExecutionEvent>) {
    events.push(event);
  }

  // Match each expected event against the next available actual event.
  let cursor = 0;
  for (let i = 0; i < caseDef.events.length; i += 1) {
    const expected = caseDef.events[i];
    let matched = false;
    while (cursor < events.length) {
      const actual = events[cursor];
      cursor += 1;
      const reason = checkEvent(expected, actual);
      if (reason === null) {
        matched = true;
        break;
      }
      // If we hit a "wrong event" but the expected was `any`, we keep looking.
      // Otherwise we record the failure and try the next event with the same cursor.
      if (expected.type !== "any") {
        failures.push({ caseId: caseDef.id, eventIndex: i, reason: `event ${cursor - 1}: ${reason}` });
        break;
      }
    }
    if (!matched && expected.type !== "any" && !failures.some((f) => f.eventIndex === i)) {
      failures.push({ caseId: caseDef.id, eventIndex: i, reason: `expected event ${i} (${expected.type}) not seen` });
    }
  }

  // Cost / token assertions can be derived from token usage events.
  if (caseDef.maxTotalTokens !== undefined) {
    const total = sumTokenUsage(events);
    if (total.tokens > caseDef.maxTotalTokens) {
      failures.push({ caseId: caseDef.id, eventIndex: -1, reason: `token budget exceeded: ${total.tokens} > ${caseDef.maxTotalTokens}` });
    }
  }
  if (caseDef.maxCostUsd !== undefined) {
    // cost is tracked via the run-limits module, not on the event payload.
    // We accept maxCostUsd as documentation; enforcement happens elsewhere.
  }

  if (caseDef.maxIterations !== undefined) {
    const iterations = events.filter((e) => e.type === "step").length;
    if (iterations > caseDef.maxIterations) {
      failures.push({ caseId: caseDef.id, eventIndex: -1, reason: `iteration budget exceeded: ${iterations} > ${caseDef.maxIterations}` });
    }
  }

  return {
    caseId: caseDef.id,
    pass: failures.length === 0,
    failures,
    eventsChecked: events.length,
    durationMs: Date.now() - start
  };
}

function checkEvent(expected: GoldenEvent, actual: AgentExecutionEvent): string | null {
  if (expected.type !== "any" && actual.type !== expected.type) {
    return `expected type ${expected.type}, got ${actual.type}`;
  }
  if (expected.tool && actual.type === "tool_call") {
    const tc = actual as Extract<AgentExecutionEvent, { type: "tool_call" }>;
    if (tc.call?.name !== expected.tool) {
      return `expected tool ${expected.tool}, got ${tc.call?.name}`;
    }
  }
  const content = (actual as { content?: string }).content ?? "";
  if (expected.contentContains && !content.toLowerCase().includes(expected.contentContains.toLowerCase())) {
    return `expected content to contain "${expected.contentContains}"`;
  }
  if (expected.contentNotContains && content.toLowerCase().includes(expected.contentNotContains.toLowerCase())) {
    return `expected content NOT to contain "${expected.contentNotContains}"`;
  }
  if (expected.parametersContain && actual.type === "tool_call") {
    const tc = actual as Extract<AgentExecutionEvent, { type: "tool_call" }>;
    for (const [k, v] of Object.entries(expected.parametersContain)) {
      if (JSON.stringify(tc.call?.parameters?.[k]) !== JSON.stringify(v)) {
        return `expected parameter ${k} to equal ${JSON.stringify(v)}, got ${JSON.stringify(tc.call?.parameters?.[k])}`;
      }
    }
  }
  if (expected.assert) {
    const result = expected.assert(actual);
    if (typeof result === "string") return result;
  }
  return null;
}

function sumTokenUsage(events: AgentExecutionEvent[]): { tokens: number } {
  let tokens = 0;
  for (const event of events) {
    const usage = (event as { tokenUsage?: { totalTokens?: number } }).tokenUsage;
    if (usage) {
      tokens += usage.totalTokens ?? 0;
    }
  }
  return { tokens };
}

/**
 * Convenience: run a list of golden cases against a factory of event
 * sources. Returns one result per case.
 */
export async function runEvalSuite(
  cases: GoldenCase[],
  sourceFactory: (caseDef: GoldenCase) => EventSource | Promise<EventSource>
): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  for (const caseDef of cases) {
    const source = await sourceFactory(caseDef);
    out.push(await runEval(caseDef, source));
  }
  return out;
}

/** Pretty-print a suite result for CI logs. */
export function formatEvalResults(results: EvalResult[]): string {
  const lines: string[] = [];
  let passed = 0;
  for (const r of results) {
    const symbol = r.pass ? "✓" : "✗";
    lines.push(`${symbol} ${r.caseId} (${r.durationMs}ms, ${r.eventsChecked} events)`);
    if (!r.pass) {
      for (const f of r.failures) {
        lines.push(`    - [event ${f.eventIndex}] ${f.reason}`);
      }
    } else {
      passed += 1;
    }
  }
  lines.unshift(`Eval: ${passed}/${results.length} passed`);
  return lines.join("\n");
}
