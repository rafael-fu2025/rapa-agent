/**
 * Snapshot comparison — deep-equal with normalization rules from
 * `.agents/notes/implemented/testing/2026-08-15-snapshot-harness-for-agent-loop.md`
 */

import type {
  SnapshotAssertion,
  SnapshotComparisonResult,
  SnapshotFixture
} from "./types.js";
import { REASONING_PREFIX_CHARS, SNAPSHOT_IGNORED_FIELDS } from "./types.js";

/**
 * Strip noise from a recorded event for comparison.
 *
 * - Removes ignored top-level fields
 * - Truncates reasoning strings
 * - Normalizes conversationId to a constant
 */
export function normalizeEvent(event: unknown, idx: number): unknown {
  if (event === null || typeof event !== "object") return event;
  const clone: Record<string, unknown> = {};
  const src = event as Record<string, unknown>;
  for (const [k, v] of Object.entries(src)) {
    if (SNAPSHOT_IGNORED_FIELDS.has(k)) continue;
    if (k === "reasoning" && typeof v === "string") {
      clone[k] = v.slice(0, REASONING_PREFIX_CHARS);
      continue;
    }
    if (k === "step" && v && typeof v === "object") {
      clone[k] = normalizeStep(v as Record<string, unknown>);
      continue;
    }
    clone[k] = v;
  }
  clone.__index = idx;
  return clone;
}

function normalizeStep(step: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(step)) {
    if (SNAPSHOT_IGNORED_FIELDS.has(k)) continue;
    if (k === "reasoning" && typeof v === "string") {
      out[k] = v.slice(0, REASONING_PREFIX_CHARS);
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Deep-equal with array order preserved. Returns the index of the
 * first mismatch, or -1 if all match.
 */
function deepEqualWithIndex(a: unknown, b: unknown): { equal: boolean; path?: string } {
  if (a === b) return { equal: true };
  if (typeof a !== typeof b) return { equal: false, path: "<root>" };
  if (a === null || b === null) return { equal: false, path: "<root>" };

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return { equal: false, path: `[length=${a.length} vs ${b.length}]` };
    for (let i = 0; i < a.length; i += 1) {
      const eq = deepEqualWithIndex(a[i], b[i]);
      if (!eq.equal) return { equal: false, path: `[${i}]${eq.path ?? ""}` };
    }
    return { equal: true };
  }

  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.join(",") !== bKeys.join(",")) {
      return { equal: false, path: `{keys ${aKeys.join(",")} vs ${bKeys.join(",")}}` };
    }
    for (const k of aKeys) {
      const eq = deepEqualWithIndex(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k]
      );
      if (!eq.equal) return { equal: false, path: `.${k}${eq.path ?? ""}` };
    }
    return { equal: true };
  }

  return { equal: false, path: "" };
}

/**
 * Compare actual events against fixture. Returns per-event diffs.
 *
 * Compares a *structural fingerprint* of each event, not its full
 * payload. The fingerprint is `{ type, iteration?, status?, name? }` —
 * just enough to confirm the agent followed the expected sequence.
 * Full payloads are deliberately *not* compared because they include
 * LLM-dependent content (reasoning text, completion timestamps, QA
 * issue lists, API key switch info) that drifts across runs and
 * providers.
 */
export function compareEvents(
  fixture: SnapshotFixture,
  actual: unknown[]
): SnapshotComparisonResult {
  const expected = fixture.events.map(fingerprint);
  const actualFps = actual.map(fingerprint);
  const diffs: SnapshotComparisonResult["diffs"] = [];

  const max = Math.max(expected.length, actualFps.length);
  for (let i = 0; i < max; i += 1) {
    const e = expected[i];
    const a = actualFps[i];
    if (e === undefined) {
      diffs.push({ index: i, field: "<extra>", expected: undefined, actual: a, message: `extra event at index ${i} (fingerprint=${JSON.stringify(a)})` });
      continue;
    }
    if (a === undefined) {
      diffs.push({ index: i, field: "<missing>", expected: e, actual: undefined, message: `missing event at index ${i} (expected ${JSON.stringify(e)})` });
      continue;
    }
    const eq = deepEqualWithIndex(e, a);
    if (!eq.equal) {
      diffs.push({
        index: i,
        field: eq.path ?? "<unknown>",
        expected: e,
        actual: a,
        message: `event ${i} (type=${e.type}) differs at ${eq.path}`
      });
    }
  }

  return { matched: diffs.length === 0, diffs };
}

/**
 * Reduce an event to its structural fingerprint. Only fields that
 * identify the *kind* of event remain. Provider-dependent payloads
 * (reasoning, completion timestamps, QA results, key-switch info)
 * are intentionally dropped.
 */
function fingerprint(event: unknown): Record<string, unknown> {
  if (event === null || typeof event !== "object") return {};
  const src = event as Record<string, unknown>;
  const out: Record<string, unknown> = { type: src.type };
  if (typeof src.iteration === "number") out.iteration = src.iteration;
  if (typeof src.status === "string") out.status = src.status;
  if (src.call && typeof src.call === "object") {
    const call = src.call as Record<string, unknown>;
    out.name = call.name;
  }
  return out;
}

/**
 * Evaluate structural assertions against the actual event stream.
 */
export function evaluateAssertions(
  assertions: SnapshotAssertion[] | undefined,
  events: unknown[]
): Array<{ assertion: SnapshotAssertion; passed: boolean; message?: string }> {
  if (!assertions || assertions.length === 0) return [];

  const toolCalls = events.filter((e): e is { type: string; call?: { name: string } } =>
    e !== null && typeof e === "object" && (e as { type?: string }).type === "tool_call"
  );

  const iterationEvents = events.filter((e): e is { type: string; iteration?: number } =>
    e !== null && typeof e === "object" && (e as { type?: string }).type === "step"
  );

  return assertions.map((a) => {
    switch (a.kind) {
      case "tool_called": {
        const calls = toolCalls.filter((t) => t.call?.name === a.name).length;
        const min = a.min ?? 1;
        const max = a.max ?? Number.POSITIVE_INFINITY;
        const ok = calls >= min && calls <= max;
        return { assertion: a, passed: ok, message: ok ? undefined : `${a.name} called ${calls}x (expected ${min}..${max})` };
      }
      case "no_tool_called": {
        const calls = toolCalls.filter((t) => t.call?.name === a.name).length;
        const ok = calls === 0;
        return { assertion: a, passed: ok, message: ok ? undefined : `${a.name} called ${calls}x (expected 0)` };
      }
      case "iteration_count": {
        const n = iterationEvents.length;
        const min = a.min ?? 0;
        const max = a.max ?? Number.POSITIVE_INFINITY;
        const ok = n >= min && n <= max;
        return { assertion: a, passed: ok, message: ok ? undefined : `iterations=${n} (expected ${min}..${max})` };
      }
      case "contains_text": {
        const haystack = JSON.stringify(events);
        const ok = a.caseSensitive
          ? haystack.includes(a.text)
          : haystack.toLowerCase().includes(a.text.toLowerCase());
        return { assertion: a, passed: ok, message: ok ? undefined : `text not found: ${a.text.slice(0, 60)}` };
      }
    }
  });
}