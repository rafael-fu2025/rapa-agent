import { beforeEach, describe, expect, it, vi } from "vitest";

import { getAgentRunStream } from "../agent-api";

const fetchWithAuthMock = vi.hoisted(() => vi.fn());

vi.mock("../http", () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
  API_BASE: "http://127.0.0.1:8787/api",
  authHeaders: () => ({}),
  forceAuthLogout: vi.fn(),
  refreshAuthToken: vi.fn(async () => "invalid" as const),
}));

beforeEach(() => {
  fetchWithAuthMock.mockReset();
});

function sseBody(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n") + "\n\n";
}

describe("getAgentRunStream (detachable-run re-attach transport)", () => {
  it("issues a GET against /agent/runs/:id/stream with the since cursor", async () => {
    fetchWithAuthMock.mockResolvedValue(new Response(sseBody([]), { status: 200 }));
    await getAgentRunStream("run-1", { since: 7, onEvent: vi.fn() });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      "/agent/runs/run-1/stream?since=7",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("parses the SSE stream, feeds onEvent, and captures the done event", async () => {
    const toolCall = { type: "tool_call", iteration: 1, status: "running", call: { id: "c1", name: "read_file", parameters: {} } };
    const done = { type: "done", status: "completed", response: "ok", steps: [], iterations: 1 };
    fetchWithAuthMock.mockResolvedValue(new Response(sseBody([toolCall, done]), { status: 200 }));

    const onEvent = vi.fn();
    const result = await getAgentRunStream("run-2", { since: 0, onEvent });

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(result.finalEvent).toEqual(done);
  });

  it("returns {} silently on 409 RUN_NOT_LIVE without emitting events", async () => {
    fetchWithAuthMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "RUN_NOT_LIVE" }), { status: 409 })
    );
    const onEvent = vi.fn();
    const result = await getAgentRunStream("run-3", { since: 0, onEvent });
    expect(result).toEqual({});
    expect(onEvent).not.toHaveBeenCalled();
    // No retry storm — exactly one fetch.
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it("returns {} on other non-OK statuses", async () => {
    fetchWithAuthMock.mockResolvedValue(new Response("boom", { status: 500 }));
    const result = await getAgentRunStream("run-4", { since: 0, onEvent: vi.fn() });
    expect(result).toEqual({});
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once after 2s on a network error, then surfaces no finalEvent", async () => {
    vi.useFakeTimers();
    try {
      fetchWithAuthMock.mockRejectedValueOnce(new Error("connection reset"));
      fetchWithAuthMock.mockResolvedValue(new Response(sseBody([]), { status: 200 }));

      const onEvent = vi.fn();
      const promise = getAgentRunStream("run-5", { since: 0, onEvent });
      await vi.advanceTimersByTimeAsync(2100);
      const result = await promise;

      expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
      expect(result.finalEvent).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry when the fetch was aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchWithAuthMock.mockRejectedValue(new DOMException("Aborted", "AbortError"));
    const result = await getAgentRunStream("run-6", { since: 0, onEvent: vi.fn(), signal: controller.signal });
    expect(result).toEqual({});
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it("resolves without a finalEvent when the stream closes before done", async () => {
    const toolCall = { type: "tool_call", iteration: 1, status: "running", call: { id: "c1", name: "read_file", parameters: {} } };
    fetchWithAuthMock.mockResolvedValue(new Response(sseBody([toolCall]), { status: 200 }));
    const onEvent = vi.fn();
    const result = await getAgentRunStream("run-7", { since: 0, onEvent });
    expect(onEvent).toHaveBeenCalledWith(toolCall);
    expect(result.finalEvent).toBeUndefined();
  });
});
