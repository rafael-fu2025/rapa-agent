// Detachable runs — module-level live-run store.
//
// The streaming state of an in-flight run (pending flag, live tool calls,
// reasoning, streamed text) used to live exclusively in React state owned
// by the mounted Home view: navigating away unmounted that state and the
// unmount cleanup aborted the SSE loop, which told the server to kill the
// run. This store is the module-level survivor — the stream executors keep
// writing here after the view unmounts, and a remounted view re-derives
// everything from the store snapshot via useSyncExternalStore.
//
// It also hosts the cold-entry re-attach orchestration (page reload /
// first visit while a run is live on the server): list the latest run,
// seed the store from the persisted rows, then replay the run's SSE stream
// through the same mutators.

import {
  getAgentRun,
  getAgentRunStream,
  listAgentRuns,
  type AgentExecutionEvent,
  type AgentLiveToolCall,
  type AgentRunDetail,
  type AgentRunSummary,
  type AgentStep,
  type AgentToolCallStatus,
} from "./agent-api";
import { ACTIVE_RUN_STATUSES, type ChatMode } from "../app/types/chat";

export type LiveRunSource = "attached" | "reattached" | "chat";

export type LiveRunState = {
  conversationId: string;
  /** Persisted run id (null for chat mode / not yet started). */
  activeRunId: string | null;
  pending: boolean;
  reconnecting: string | null;
  liveToolCalls: AgentLiveToolCall[];
  liveReasoning: string | null;
  /** Steps folded so far — lets a remounted view restore history instantly. */
  agentSteps: AgentStep[];
  /** Mode of the streaming run, used when synthesizing the in-flight message. */
  mode: ChatMode | null;
  queuedPrompt: string | null;
  /** Assistant partial content (agent `assistant` events + chat chunks). */
  streamingText: string | null;
  /** Highest event `seq` seen from a re-attach stream (null = none). */
  lastEventSeq: number | null;
  source: LiveRunSource | null;
};

/** Id prefix of the synthesized in-flight assistant message. Routes uses
 *  it to detect "a store-tracked run settled while its placeholder was on
 *  screen" and refetch the canonical persisted row exactly once. */
export const LIVE_MESSAGE_ID_PREFIX = "live-run-";

/** Shared empty arrays: empty states must be field-wise Object.is-equal so
 *  "nothing to reset" and repeated finalizes don't emit. */
const EMPTY_TOOL_CALLS: AgentLiveToolCall[] = [];
const EMPTY_STEPS: AgentStep[] = [];

function emptyState(conversationId: string): LiveRunState {
  return {
    conversationId,
    activeRunId: null,
    pending: false,
    reconnecting: null,
    liveToolCalls: EMPTY_TOOL_CALLS,
    liveReasoning: null,
    agentSteps: EMPTY_STEPS,
    mode: null,
    queuedPrompt: null,
    streamingText: null,
    lastEventSeq: null,
    source: null,
  };
}

/* ---- Module-level singleton state ---- */

const states = new Map<string, LiveRunState>();
const listeners = new Map<string, Set<() => void>>();
const consumerCounts = new Map<string, number>();

function emit(conversationId: string): void {
  const set = listeners.get(conversationId);
  if (!set) return;
  for (const listener of [...set]) listener();
}

/** Immutable replace + emit-only-on-change. */
function mutate(conversationId: string, patch: Partial<LiveRunState>): void {
  const current = getLiveRunState(conversationId);
  let changed = false;
  for (const key of Object.keys(patch) as (keyof LiveRunState)[]) {
    if (!Object.is(current[key], patch[key])) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  states.set(conversationId, { ...current, ...patch });
  emit(conversationId);
}

/* ---- Reads / subscription (useSyncExternalStore contract) ---- */

/** Stable snapshot per conversation: the empty state is created lazily and
 *  kept by identity until the first mutation replaces it, so React's
 *  getSnapshot sees a referentially stable object between changes. */
export function getLiveRunState(conversationId: string): LiveRunState {
  let state = states.get(conversationId);
  if (!state) {
    state = emptyState(conversationId);
    states.set(conversationId, state);
  }
  return state;
}

/** Imperative read — same snapshot identity as getLiveRunState. */
export function getLiveRunSnapshot(conversationId: string): LiveRunState {
  return getLiveRunState(conversationId);
}

export function subscribeLiveRun(conversationId: string, listener: () => void): () => void {
  let set = listeners.get(conversationId);
  if (!set) {
    set = new Set();
    listeners.set(conversationId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(conversationId);
  };
}

/** True while the store tracks an in-flight run for the conversation. */
export function hasLiveRun(conversationId: string): boolean {
  return states.get(conversationId)?.pending === true;
}

/* ---- Mounted-consumer tracking ----
   The queue flush (and any other post-run side effect) must never fire
   headless: when the view that started a run unmounted, its consumer is
   released and the count drops to zero. */

export function acquireLiveRunConsumer(conversationId: string): () => void {
  consumerCounts.set(conversationId, (consumerCounts.get(conversationId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (consumerCounts.get(conversationId) ?? 1) - 1;
    if (next <= 0) consumerCounts.delete(conversationId);
    else consumerCounts.set(conversationId, next);
  };
}

export function hasLiveRunConsumer(conversationId: string): boolean {
  return (consumerCounts.get(conversationId) ?? 0) > 0;
}

/* ---- Mutators (called by stream executors and the re-attach consumer) ---- */

export function setLivePending(conversationId: string, pending: boolean): void {
  mutate(conversationId, { pending });
}

export function setLiveReconnecting(conversationId: string, message: string | null): void {
  mutate(conversationId, { reconnecting: message });
}

/** Upsert by tool-call id (a completed event for the same call replaces
 *  the pending/running entry, mirroring the message-level reducer). */
export function pushLiveToolCall(conversationId: string, call: AgentLiveToolCall): void {
  const current = getLiveRunState(conversationId);
  mutate(conversationId, {
    liveToolCalls: [...current.liveToolCalls.filter((item) => item.call.id !== call.call.id), call],
  });
}

export function setLiveReasoning(conversationId: string, reasoning: string | null): void {
  mutate(conversationId, { liveReasoning: reasoning });
}

/** Commit an iteration's step: replaces the same-iteration entry and
 *  clears the transient live tool cards / reasoning, exactly like the
 *  onStep message reducer. */
export function foldLiveStep(conversationId: string, step: AgentStep): void {
  const current = getLiveRunState(conversationId);
  mutate(conversationId, {
    agentSteps: [...current.agentSteps.filter((s) => s.iteration !== step.iteration), step],
    liveToolCalls: EMPTY_TOOL_CALLS,
    liveReasoning: null,
  });
}

/** Append (default) or replace the streamed assistant partial. */
export function setLiveStreamingText(
  conversationId: string,
  chunk: string,
  mode: "append" | "replace" = "append"
): void {
  const current = getLiveRunState(conversationId);
  const next = mode === "replace" ? chunk : (current.streamingText ?? "") + chunk;
  mutate(conversationId, { streamingText: next });
}

export function setLiveQueuedPrompt(conversationId: string, prompt: string | null): void {
  mutate(conversationId, { queuedPrompt: prompt });
}

export function setLiveActiveRun(
  conversationId: string,
  activeRunId: string | null,
  options?: { source?: LiveRunSource; mode?: ChatMode | null }
): void {
  mutate(conversationId, {
    activeRunId,
    ...(options?.source !== undefined ? { source: options.source } : {}),
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
  });
}

export function setLiveEventSeq(conversationId: string, seq: number): void {
  mutate(conversationId, { lastEventSeq: seq });
}

/**
 * Settle a finished run: clear the transient streaming fields while
 * keeping `lastEventSeq` (and the queued prompt — the queue owner clears
 * it explicitly so keepQueue survives a stop). When `final` is given, the
 * streamed text is set to the complete response so a later remount shows
 * the full content before the canonical row arrives.
 */
export function finalizeLiveRun(conversationId: string, final?: string): void {
  const current = getLiveRunState(conversationId);
  mutate(conversationId, {
    pending: false,
    reconnecting: null,
    liveToolCalls: EMPTY_TOOL_CALLS,
    liveReasoning: null,
    streamingText: final !== undefined ? final : current.streamingText,
  });
}

/** Drop every trace of the run for the conversation (new chat / full reset). */
export function resetLiveRun(conversationId: string): void {
  const current = states.get(conversationId);
  if (!current) {
    states.set(conversationId, emptyState(conversationId));
    return;
  }
  const fresh = emptyState(conversationId);
  let changed = false;
  for (const key of Object.keys(fresh) as (keyof LiveRunState)[]) {
    if (!Object.is(current[key], fresh[key])) {
      changed = true;
      break;
    }
  }
  if (!changed) return; // nothing to reset — no emission
  states.set(conversationId, fresh);
  emit(conversationId);
}

/** Test isolation helper — wipes every conversation's state. */
export function resetAllLiveRuns(): void {
  for (const conversationId of [...states.keys()]) {
    resetLiveRun(conversationId);
  }
}

/* ------------------------------------------------------------------ */
/*  Cold-entry re-attach                                               */
/* ------------------------------------------------------------------ */

const activeReattachRuns = new Set<string>();

function extractRunSteps(run: AgentRunDetail): AgentStep[] {
  if (!Array.isArray(run.steps)) return [];
  return run.steps.flatMap((step): AgentStep[] => {
    if (!step || typeof step !== "object") return [];
    const candidate = step as AgentStep;
    if (typeof candidate.iteration !== "number") return [];
    // Persisted AgentRunStep rows don't embed tool calls/results — normalize
    // to well-formed AgentStep shapes so downstream consumers (task
    // extraction, steps viewer) never see undefined arrays.
    return [{
      ...candidate,
      toolCalls: Array.isArray(candidate.toolCalls) ? candidate.toolCalls : [],
      toolResults: Array.isArray(candidate.toolResults) ? candidate.toolResults : []
    }];
  });
}

/** Call ids already covered by the persisted steps — seeding those as live
 *  cards would render them twice (once in history, once as a live card). */
function collectStepCallIds(steps: AgentStep[]): Set<string> {
  const ids = new Set<string>();
  for (const step of steps) {
    if (!Array.isArray(step.toolCalls)) continue;
    for (const call of step.toolCalls) {
      if (typeof call?.id === "string" && call.id) ids.add(call.id);
    }
  }
  return ids;
}

/** Map persisted AgentToolCall rows onto the live-card shape. Sorted by
 *  startedAt (fallback createdAt); calls already covered by a persisted
 *  step are excluded. The call id prefers `externalCallId` — the id the
 *  live SSE events use — so replayed events upsert these entries instead
 *  of duplicating them. */
function synthesizeLiveToolCalls(run: AgentRunDetail, excludeIds: Set<string>): AgentLiveToolCall[] {
  const rows = run.toolCalls ?? [];
  return rows
    .filter((row) => {
      const callId = typeof row.externalCallId === "string" && row.externalCallId ? row.externalCallId : row.id;
      return !excludeIds.has(callId);
    })
    .sort((a, b) => {
      const aTime = new Date(String(a.startedAt ?? a.createdAt)).getTime() || 0;
      const bTime = new Date(String(b.startedAt ?? b.createdAt)).getTime() || 0;
      return aTime - bTime;
    })
    .map((row, index) => {
      const status = typeof row.status === "string" ? row.status : "running";
      const mapped: AgentToolCallStatus =
        status === "completed"
          ? "completed"
          : status === "failed"
            ? "failed"
            : status === "requires_approval"
              ? "requires_approval"
              : "running";
      const parameters =
        row.parameters && typeof row.parameters === "object" && !Array.isArray(row.parameters)
          ? (row.parameters as Record<string, unknown>)
          : {};
      return {
        iteration: typeof row.iteration === "number" ? row.iteration : index,
        status: mapped,
        call: {
          id: typeof row.externalCallId === "string" && row.externalCallId ? row.externalCallId : row.id,
          name: typeof row.name === "string" && row.name ? row.name : "unknown",
          parameters,
        },
      };
    });
}

/** Apply one re-attach stream event to the store. Never navigates and
 *  never touches React state — the mounted hook mirrors the store into
 *  its messages. */
function applyReattachEvent(conversationId: string, runId: string, event: AgentExecutionEvent): void {
  const seq = (event as { seq?: unknown }).seq;
  if (typeof seq === "number" && Number.isFinite(seq)) {
    setLiveEventSeq(conversationId, seq);
  }
  switch (event.type) {
    case "start":
      // A re-attach start must not trigger "new conversation" handling —
      // just keep tracking the run id.
      setLiveActiveRun(conversationId, event.runId ?? runId, { source: "reattached" });
      break;
    case "thinking":
      setLiveReasoning(conversationId, event.reasoning ?? null);
      break;
    case "tool_call":
      pushLiveToolCall(conversationId, {
        iteration: event.iteration,
        status: event.status,
        call: event.call,
        ...(event.result !== undefined ? { result: event.result } : {}),
      });
      break;
    case "assistant":
      setLiveStreamingText(conversationId, event.content, "replace");
      break;
    case "step":
      foldLiveStep(conversationId, event.step);
      break;
    case "done":
      finalizeLiveRun(conversationId, event.response);
      break;
    case "error":
      setLiveReconnecting(conversationId, null);
      finalizeLiveRun(conversationId);
      break;
  }
}

/**
 * Re-attach to an in-flight agent run on cold entry (page reload / first
 * visit to the conversation). Best effort, module-scope, and idempotent:
 *
 * 1. Skip when the store already tracks a live run for the conversation
 *    (warm return — the executors are still feeding the store).
 * 2. If the latest persisted run is active, seed the store from the run
 *    detail (steps + live tool cards) and mark it pending with source
 *    "reattached" — the mounted hook synthesizes the in-flight assistant
 *    message from this snapshot instantly.
 * 3. Open the run's SSE stream (`since: 0`) feeding the same mutators;
 *    a done event finalizes exactly like a native done.
 * 4. When the stream settles without a done (abort / close), settle the
 *    store so the UI doesn't spin forever. The caller refetches the
 *    canonical messages once the pending flag drops.
 */
export async function reattachLiveRun(
  conversationId: string,
  options: { mode?: ChatMode | null } = {}
): Promise<void> {
  if (hasLiveRun(conversationId)) return;

  let runs: AgentRunSummary[];
  try {
    ({ runs } = await listAgentRuns({ conversationId, limit: 1 }));
  } catch {
    return; // best effort — the resumable-run banner logic still applies
  }
  const latest = runs[0];
  if (!latest || !ACTIVE_RUN_STATUSES.has(latest.status)) return;

  const runId = latest.id;
  if (activeReattachRuns.has(runId)) return; // already re-attaching elsewhere
  activeReattachRuns.add(runId);

  try {
    let run: AgentRunDetail | null = null;
    try {
      ({ run } = await getAgentRun(runId));
    } catch {
      run = null;
    }
    if (!run) return;

    setLiveActiveRun(conversationId, runId, { source: "reattached", mode: options.mode ?? "agent" });
    setLivePending(conversationId, true);
    setLiveReconnecting(conversationId, null);
    setLiveStreamingText(conversationId, "", "replace");

    // History first (each fold clears the live cards), then the in-flight
    // tool cards — the replayed stream refines both from here on.
    const steps = extractRunSteps(run);
    for (const step of steps) foldLiveStep(conversationId, step);
    const excludeIds = collectStepCallIds(steps);
    for (const call of synthesizeLiveToolCalls(run, excludeIds)) {
      pushLiveToolCall(conversationId, call);
    }

    await getAgentRunStream(runId, {
      since: 0,
      onEvent: (event) => applyReattachEvent(conversationId, runId, event),
    });

    const state = getLiveRunSnapshot(conversationId);
    if (state.pending && state.activeRunId === runId) {
      finalizeLiveRun(conversationId);
    }
  } finally {
    activeReattachRuns.delete(runId);
  }
}
