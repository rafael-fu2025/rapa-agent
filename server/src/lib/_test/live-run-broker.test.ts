// Tests for the live-run event broker (detachable agent runs): per-run seq
// assignment, replay-since correctness, the no-gap/no-double-delivery
// guarantee between replay and live tail (including re-entrant publishes),
// the drop-oldest ring cap, multi-subscriber fanout with listener-throw
// isolation, close + retention sweeping, and the pure re-attach mode
// decision used by GET /agent/runs/:id/stream.

import { describe, expect, it } from "vitest";

import {
  closeRunEvents,
  getRunBufferInfo,
  publishRunEvent,
  resolveReattachMode,
  subscribeRunEvents,
  sweepExpiredRunBuffers,
  type BrokeredRunEvent
} from "../live-run-broker.js";

const ACTIVE_STATUSES = ["pending", "resumed", "in_progress", "running"] as const;

/** Unique run id per test — the broker module state is process-global. */
let runCounter = 0;
function freshRunId(prefix: string) {
  runCounter += 1;
  return `${prefix}-${runCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function collect(runId: string, sinceSeq: number) {
  const received: BrokeredRunEvent[] = [];
  const unsubscribe = subscribeRunEvents(runId, sinceSeq, (brokered) => {
    received.push(brokered);
  });
  return { received, unsubscribe };
}

describe("live-run-broker — publish/seq", () => {
  it("assigns monotonically increasing per-run seqs starting at 1", () => {
    const runId = freshRunId("seq");
    expect(publishRunEvent(runId, { type: "start" })).toBe(1);
    expect(publishRunEvent(runId, { type: "thinking" })).toBe(2);
    expect(publishRunEvent(runId, { type: "step" })).toBe(3);

    const info = getRunBufferInfo(runId);
    expect(info).toMatchObject({ exists: true, eventCount: 3, firstSeq: 1, lastSeq: 3 });
  });

  it("keeps seq counters independent across runs", () => {
    const runA = freshRunId("a");
    const runB = freshRunId("b");
    publishRunEvent(runA, { n: 1 });
    publishRunEvent(runA, { n: 2 });
    expect(publishRunEvent(runB, { n: 1 })).toBe(1);
  });

  it("stamps the seq on a shallow clone, leaving the caller's event untouched", () => {
    const runId = freshRunId("clone");
    const original: Record<string, unknown> = { type: "step", iteration: 1 };
    const seq = publishRunEvent(runId, original);

    expect(original).toEqual({ type: "step", iteration: 1 });
    const buffer = getRunBufferInfo(runId);
    expect(buffer).toBeDefined();
    expect(seq).toBe(1);
  });

  it("returns undefined buffer info for unknown runs", () => {
    expect(getRunBufferInfo(freshRunId("missing"))).toBeUndefined();
  });
});

describe("live-run-broker — replay since", () => {
  it("replays all buffered events for since=0, in order", () => {
    const runId = freshRunId("replay-all");
    for (let index = 1; index <= 5; index += 1) publishRunEvent(runId, { n: index });

    const { received, unsubscribe } = collect(runId, 0);
    unsubscribe();
    expect(received.map((brokered) => brokered.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(received.map((brokered) => brokered.event.n)).toEqual([1, 2, 3, 4, 5]);
  });

  it("replays only events after sinceSeq", () => {
    const runId = freshRunId("replay-tail");
    for (let index = 1; index <= 5; index += 1) publishRunEvent(runId, { n: index });

    const { received, unsubscribe } = collect(runId, 3);
    unsubscribe();
    expect(received.map((brokered) => brokered.seq)).toEqual([4, 5]);
  });

  it("replays nothing when since is at or beyond lastSeq, but still tails live", () => {
    const runId = freshRunId("replay-live-only");
    publishRunEvent(runId, { n: 1 });

    const { received, unsubscribe } = collect(runId, 1);
    publishRunEvent(runId, { n: 2 });
    publishRunEvent(runId, { n: 3 });
    unsubscribe();

    expect(received.map((brokered) => brokered.seq)).toEqual([2, 3]);
  });

  it("does not re-deliver replayed events on the live path (no dupes)", () => {
    const runId = freshRunId("no-dupe");
    publishRunEvent(runId, { n: 1 });
    publishRunEvent(runId, { n: 2 });

    const { received, unsubscribe } = collect(runId, 0);
    publishRunEvent(runId, { n: 3 });
    unsubscribe();

    expect(received.map((brokered) => brokered.seq)).toEqual([1, 2, 3]);
  });
});

describe("live-run-broker — replay/live-tail handoff", () => {
  it("delivers an event published during replay exactly once, after the backlog", () => {
    // Re-entrancy hazard: a listener that publishes while the replay loop is
    // still running must receive that event via the pending queue AFTER the
    // replay backlog, in seq order, exactly once.
    const runId = freshRunId("reentrant");
    publishRunEvent(runId, { n: 1 });
    publishRunEvent(runId, { n: 2 });

    const received: BrokeredRunEvent[] = [];
    let livePublished = 0;
    const unsubscribe = subscribeRunEvents(runId, 0, (brokered) => {
      received.push(brokered);
      if (livePublished === 0) {
        livePublished += 1;
        publishRunEvent(runId, { n: "live" });
      }
    });

    expect(received.map((brokered) => brokered.seq)).toEqual([1, 2, 3]);
    expect(received[2].event.n).toBe("live");
    unsubscribe();

    // One more publish goes straight to live delivery (no queue), still once.
    const second: BrokeredRunEvent[] = [];
    const unsubscribe2 = subscribeRunEvents(runId, 3, (brokered) => second.push(brokered));
    publishRunEvent(runId, { n: 4 });
    unsubscribe2();
    expect(second.map((brokered) => brokered.seq)).toEqual([4]);
  });

  it("subscribers registered mid-stream only see post-subscribe events", () => {
    const runId = freshRunId("mid");
    publishRunEvent(runId, { n: 1 });
    const { received, unsubscribe } = collect(runId, 999);
    publishRunEvent(runId, { n: 2 });
    unsubscribe();
    expect(received.map((brokered) => brokered.seq)).toEqual([2]);
  });
});

describe("live-run-broker — ring cap", () => {
  it("drops oldest events past the cap and advances firstSeq", () => {
    const runId = freshRunId("ring");
    const TOTAL = 5010; // cap is 5000
    for (let index = 1; index <= TOTAL; index += 1) publishRunEvent(runId, { n: index });

    const info = getRunBufferInfo(runId);
    expect(info).toBeDefined();
    expect(info?.eventCount).toBe(5000);
    expect(info?.lastSeq).toBe(TOTAL);
    // Oldest 10 dropped → first surviving seq is 11.
    expect(info?.firstSeq).toBe(TOTAL - 5000 + 1);

    // Replay of a dropped range returns only the surviving tail.
    const { received, unsubscribe } = collect(runId, 0);
    unsubscribe();
    expect(received.length).toBe(5000);
    expect(received[0].seq).toBe(TOTAL - 5000 + 1);
    expect(received[received.length - 1].seq).toBe(TOTAL);
  }, 20_000);

  it("keeps drop-oldest correct after repeated boundary pushes", () => {
    const runId = freshRunId("ring-2");
    publishRunEvent(runId, { n: 1 });
    for (let index = 2; index <= 5001; index += 1) publishRunEvent(runId, { n: index });
    publishRunEvent(runId, { n: 5002 });

    const info = getRunBufferInfo(runId);
    expect(info?.eventCount).toBe(5000);
    expect(info?.firstSeq).toBe(3);
  }, 20_000);
});

describe("live-run-broker — fanout", () => {
  it("fans out to multiple subscribers in order", () => {
    const runId = freshRunId("fanout");
    const a: BrokeredRunEvent[] = [];
    const b: BrokeredRunEvent[] = [];
    const c: BrokeredRunEvent[] = [];
    const unsubA = subscribeRunEvents(runId, 0, (brokered) => a.push(brokered));
    const unsubB = subscribeRunEvents(runId, 0, (brokered) => b.push(brokered));
    const unsubC = subscribeRunEvents(runId, 0, (brokered) => c.push(brokered));

    publishRunEvent(runId, { n: 1 });
    publishRunEvent(runId, { n: 2 });

    unsubA();
    unsubB();
    unsubC();

    expect(a.map((brokered) => brokered.seq)).toEqual([1, 2]);
    expect(b.map((brokered) => brokered.seq)).toEqual([1, 2]);
    expect(c.map((brokered) => brokered.seq)).toEqual([1, 2]);
  });

  it("isolates listener throws — broken listeners never break the publisher or others", () => {
    const runId = freshRunId("throw");
    const healthy: BrokeredRunEvent[] = [];
    const unsubBad = subscribeRunEvents(runId, 0, () => {
      throw new Error("listener exploded");
    });
    const unsubGood = subscribeRunEvents(runId, 0, (brokered) => healthy.push(brokered));

    expect(() => publishRunEvent(runId, { n: 1 })).not.toThrow();
    expect(() => publishRunEvent(runId, { n: 2 })).not.toThrow();

    unsubBad();
    unsubGood();
    expect(healthy.map((brokered) => brokered.seq)).toEqual([1, 2]);
  });

  it("stops delivering after unsubscribe", () => {
    const runId = freshRunId("unsub");
    const received: BrokeredRunEvent[] = [];
    const unsubscribe = subscribeRunEvents(runId, 0, (brokered) => received.push(brokered));
    publishRunEvent(runId, { n: 1 });
    unsubscribe();
    publishRunEvent(runId, { n: 2 });
    expect(received.map((brokered) => brokered.seq)).toEqual([1]);
  });
});

describe("live-run-broker — close + retention sweep", () => {
  it("marks closed, keeps the buffer re-attachable, and sweeps after retention", () => {
    const runId = freshRunId("close");
    publishRunEvent(runId, { n: 1 });
    publishRunEvent(runId, { n: 2 });

    closeRunEvents(runId);
    const info = getRunBufferInfo(runId);
    expect(info?.closedAt).toBeTypeOf("number");

    // Closed but retained: replay still works.
    const { received, unsubscribe } = collect(runId, 0);
    unsubscribe();
    expect(received.map((brokered) => brokered.seq)).toEqual([1, 2]);

    // Default sweep (5 min) must NOT remove a just-closed buffer...
    sweepExpiredRunBuffers();
    expect(getRunBufferInfo(runId)).toBeDefined();

    // ...but a zero-age sweep removes it (no subscribers attached).
    sweepExpiredRunBuffers(0);
    expect(getRunBufferInfo(runId)).toBeUndefined();
  });

  it("close is idempotent — the first closedAt wins", () => {
    const runId = freshRunId("close-idem");
    publishRunEvent(runId, { n: 1 });
    closeRunEvents(runId);
    const first = getRunBufferInfo(runId)?.closedAt;
    // Small clock paranoia: ensure a later close cannot move the timestamp.
    const later = Date.now() + 5;
    const realNow = Date.now;
    Date.now = () => later;
    try {
      closeRunEvents(runId);
      expect(getRunBufferInfo(runId)?.closedAt).toBe(first);
    } finally {
      Date.now = realNow;
    }
  });

  it("does not sweep buffers that still have subscribers", () => {
    const runId = freshRunId("sweep-sub");
    publishRunEvent(runId, { n: 1 });
    closeRunEvents(runId);

    const { unsubscribe } = collect(runId, 0);
    sweepExpiredRunBuffers(0);
    expect(getRunBufferInfo(runId)).toBeDefined();

    unsubscribe();
    sweepExpiredRunBuffers(0);
    expect(getRunBufferInfo(runId)).toBeUndefined();
  });

  it("sweeping an unknown run is a no-op", () => {
    expect(() => sweepExpiredRunBuffers(0)).not.toThrow();
  });
});

describe("resolveReattachMode", () => {
  it("tails live for active runs regardless of buffer state", () => {
    expect(resolveReattachMode("running", undefined, ACTIVE_STATUSES)).toBe("stream");
    expect(resolveReattachMode("running", { eventCount: 42 }, ACTIVE_STATUSES)).toBe("stream");
    expect(resolveReattachMode("in_progress", { eventCount: 0 }, ACTIVE_STATUSES)).toBe("stream");
  });

  it("rejects terminal runs with no buffer or an empty buffer", () => {
    expect(resolveReattachMode("completed", undefined, ACTIVE_STATUSES)).toBe("reject");
    expect(resolveReattachMode("failed", undefined, ACTIVE_STATUSES)).toBe("reject");
    expect(resolveReattachMode("aborted", { eventCount: 0 }, ACTIVE_STATUSES)).toBe("reject");
    expect(resolveReattachMode("interrupted", { eventCount: 0 }, ACTIVE_STATUSES)).toBe("reject");
  });

  it("streams-and-ends for terminal runs with surviving buffer content", () => {
    expect(resolveReattachMode("completed", { eventCount: 7 }, ACTIVE_STATUSES)).toBe("stream-and-end");
    expect(resolveReattachMode("max_iterations", { eventCount: 1 }, ACTIVE_STATUSES)).toBe("stream-and-end");
  });

  it("treats any unknown status as terminal", () => {
    expect(resolveReattachMode("resumed", undefined, ACTIVE_STATUSES)).toBe("stream");
    expect(resolveReattachMode("something-new", undefined, ACTIVE_STATUSES)).toBe("reject");
  });
});
