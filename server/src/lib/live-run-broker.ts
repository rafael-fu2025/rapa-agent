// Live-run event broker — detachable agent runs.
//
// The agent stream route publishes every AgentExecutionEvent it receives
// from Agent.stream() into this in-memory, per-run buffer BEFORE writing it
// to the SSE response. A client that disconnects mid-run can re-attach via
// GET /agent/runs/:id/stream?since=<seq>, replay everything it missed, and
// then tail the rest of the run live.
//
// The broker is intentionally process-local: after a server restart there is
// nothing live to attach to (startAgentRun's stale-run sweep marks those rows
// failed on the next run start).
//
// Replay/live-tail ordering — no gaps, no double delivery:
//   subscribeRunEvents registers the subscriber FIRST, in a "replaying"
//   mode in which the publisher QUEUES live events into a per-subscriber
//   pending list instead of calling the listener directly; it then
//   synchronously replays the buffered snapshot (seq > sinceSeq) and only
//   afterwards switches the subscriber to direct delivery and flushes the
//   queued events in seq order. JavaScript's single-threaded execution means
//   no publish can interleave with the subscribe call itself, and the pending
//   queue covers the only re-entrancy hazard: a listener that (re-entrantly)
//   publishes while a replay or a queued flush is still in flight — those
//   events are appended to the same queue and therefore delivered exactly
//   once, in seq order. Events are never duplicated between replay and live
//   tail because the replay snapshot is taken after registration and the
//   queue holds everything published after that point.

export type BrokeredRunEvent = { seq: number; event: Record<string, unknown> };

type RunSubscriber = {
  fn: (brokered: BrokeredRunEvent) => void;
  /**
   * Non-null while the subscriber is inside replay (or a pending flush):
   * the publisher queues live events here instead of calling `fn` directly.
   * Null once the subscriber is in steady live-delivery mode.
   */
  pendingQueue: BrokeredRunEvent[] | null;
};

type RunBuffer = {
  events: BrokeredRunEvent[];
  /** Next sequence number to assign. Per-run, starts at 1. */
  nextSeq: number;
  /**
   * Seq of events[0]. Events with a smaller seq were already dropped by the
   * ring cap (a re-attaching client asking for `since < firstSeq` gets the
   * oldest survivors, not the full history — see RUN_EVENT_RING_CAP).
   */
  firstSeq: number;
  subscribers: Set<RunSubscriber>;
  /** Set by closeRunEvents; the buffer is swept RETENTION_MS later. */
  closedAt?: number;
};

/** Drop-oldest ring cap per run — bounds memory for very long runs. */
const RUN_EVENT_RING_CAP = 5000;

/** Closed runs keep their buffer re-attachable for 5 minutes. */
const RUN_BUFFER_RETENTION_MS = 5 * 60 * 1000;

const runBuffers = new Map<string, RunBuffer>();

function getOrCreateBuffer(runId: string): RunBuffer {
  let buffer = runBuffers.get(runId);
  if (!buffer) {
    buffer = {
      events: [],
      nextSeq: 1,
      firstSeq: 1,
      subscribers: new Set()
    };
    runBuffers.set(runId, buffer);
  }
  return buffer;
}

/**
 * Remove closed buffers whose retention window has elapsed. Buffers with
 * active subscribers are kept — their listeners may still be mid-replay or
 * waiting for a tail. Called opportunistically from publish/subscribe/
 * getRunBufferInfo so no timer infrastructure is needed.
 */
export function sweepExpiredRunBuffers(maxAgeMs: number = RUN_BUFFER_RETENTION_MS): void {
  const now = Date.now();
  for (const [runId, buffer] of runBuffers) {
    if (buffer.closedAt === undefined) continue;
    if (buffer.subscribers.size > 0) continue;
    if (now - buffer.closedAt >= maxAgeMs) runBuffers.delete(runId);
  }
}

/**
 * Append an event to the run's buffer (assigning its seq) and fan it out to
 * all current subscribers. Returns the assigned seq. The event is shallow
 * cloned with the seq folded in — callers keep ownership of the original.
 */
export function publishRunEvent(runId: string, event: Record<string, unknown>): number {
  sweepExpiredRunBuffers();
  const buffer = getOrCreateBuffer(runId);
  const seq = buffer.nextSeq;
  buffer.nextSeq += 1;
  const brokered: BrokeredRunEvent = { seq, event: { ...event, seq } };
  buffer.events.push(brokered);
  if (buffer.events.length > RUN_EVENT_RING_CAP) {
    buffer.events.shift(); // drop oldest
    buffer.firstSeq = buffer.events[0].seq;
  }

  // Fanout on a snapshot so listeners may (un)subscribe re-entrantly.
  for (const subscriber of [...buffer.subscribers]) {
    if (subscriber.pendingQueue !== null) {
      // Mid-replay (or mid-flush): queue instead of calling directly so the
      // subscriber never sees a live event ahead of the replay backlog.
      subscriber.pendingQueue.push(brokered);
      continue;
    }
    try {
      subscriber.fn(brokered);
    } catch (error) {
      // Listener isolation: one broken listener never breaks the publisher
      // (or the live run) — the SSE write paths already guard themselves.
      console.warn(
        `[live-run-broker] listener for run ${runId} threw: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return seq;
}

/**
 * Subscribe to a run's events. First synchronously replays every buffered
 * event with `seq > sinceSeq` to the listener, then delivers live events as
 * they are published. The returned unsubscribe removes the listener.
 */
export function subscribeRunEvents(
  runId: string,
  sinceSeq: number,
  listener: (brokered: BrokeredRunEvent) => void
): () => void {
  sweepExpiredRunBuffers();
  const buffer = getOrCreateBuffer(runId);
  const subscriber: RunSubscriber = { fn: listener, pendingQueue: [] };
  buffer.subscribers.add(subscriber);

  // Snapshot taken AFTER registration (see module doc for the ordering
  // argument): the replay covers everything published before this point,
  // the pending queue catches everything published after it.
  const replay = buffer.events.filter((brokered) => brokered.seq > sinceSeq);
  for (const brokered of replay) {
    // A listener that unsubscribes mid-replay stops receiving it immediately.
    if (!buffer.subscribers.has(subscriber)) break;
    try {
      subscriber.fn(brokered);
    } catch (error) {
      // Replay listener failures are isolated per event (same contract as
      // live fanout): one throw never gaps the rest of the replay.
      console.warn(
        `[live-run-broker] replay listener for run ${runId} threw: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (buffer.subscribers.has(subscriber)) {
    flushSubscriberQueue(subscriber, () => buffer.subscribers.has(subscriber));
  } else {
    // Unsubscribed mid-replay: drop the queued tail, deliver nothing more.
    subscriber.pendingQueue = null;
  }

  return () => {
    buffer.subscribers.delete(subscriber);
  };
}

/**
 * Deliver the events queued while the subscriber was mid-replay. Index-based
 * loop so events published re-entrantly BY a listener during the flush are
 * appended to the same queue (publish sees a live pendingQueue) and picked
 * up in seq order instead of being lost or delivered out of order.
 */
function flushSubscriberQueue(subscriber: RunSubscriber, isStillSubscribed: () => boolean): void {
  const queue = subscriber.pendingQueue;
  if (!queue) return;
  for (let index = 0; index < queue.length; index += 1) {
    if (!isStillSubscribed()) {
      // Unsubscribed mid-flush: drop the remaining queued events.
      subscriber.pendingQueue = null;
      return;
    }
    const brokered = queue[index];
    if (!brokered) continue;
    try {
      subscriber.fn(brokered);
    } catch (error) {
      console.warn(
        `[live-run-broker] queued listener threw: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  subscriber.pendingQueue = null;
}

/**
 * Mark a run's event buffer closed. Idempotent (the FIRST close timestamp
 * wins so retention counts from when the run actually finished). The buffer
 * stays available for re-attach/late subscribe for RUN_BUFFER_RETENTION_MS,
 * then is removed by the opportunistic sweep.
 */
export function closeRunEvents(runId: string): void {
  const buffer = runBuffers.get(runId);
  if (!buffer) return;
  if (buffer.closedAt === undefined) buffer.closedAt = Date.now();
}

export type RunBufferInfo = {
  exists: boolean;
  eventCount: number;
  firstSeq: number;
  lastSeq: number;
  closedAt?: number;
};

/** Introspection for the re-attach endpoint's 409 / replay decisions. */
export function getRunBufferInfo(runId: string): RunBufferInfo | undefined {
  sweepExpiredRunBuffers();
  const buffer = runBuffers.get(runId);
  if (!buffer) return undefined;
  return {
    exists: true,
    eventCount: buffer.events.length,
    firstSeq: buffer.firstSeq,
    lastSeq: buffer.nextSeq - 1,
    ...(buffer.closedAt !== undefined ? { closedAt: buffer.closedAt } : {})
  };
}

// ---------------------------------------------------------------------------
// Re-attach decision (pure, unit-tested — the route stays thin).
// ---------------------------------------------------------------------------

export type ReattachMode =
  /** Terminal run with no buffered events — nothing to stream, reply 409. */
  | "reject"
  /** Terminal run whose buffer still replays — stream then end the reply. */
  | "stream-and-end"
  /** Active run — stream and tail live until the run finishes or client leaves. */
  | "stream";

/**
 * Decide how GET /agent/runs/:id/stream should behave. A run is "terminal"
 * when its persisted status is not one of the active statuses passed in
 * (routes/agent/schemas.js owns the ACTIVE_RUN_STATUSES list — passed in
 * here to keep this lib module free of route imports). Terminal runs with an
 * empty/absent buffer are not live and cannot be re-attached (409);
 * terminal runs with surviving buffer content replay through their done
 * event and then end; active runs tail live.
 */
export function resolveReattachMode(
  runStatus: string,
  bufferInfo: Pick<RunBufferInfo, "eventCount"> | undefined,
  activeStatuses: readonly string[]
): ReattachMode {
  const isTerminal = !activeStatuses.includes(runStatus);
  if (!isTerminal) return "stream";
  if (!bufferInfo || bufferInfo.eventCount === 0) return "reject";
  return "stream-and-end";
}
